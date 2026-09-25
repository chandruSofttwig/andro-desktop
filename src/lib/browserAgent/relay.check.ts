import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../src-tauri/src/browser_agent.rs', import.meta.url), 'utf8');
const script = source.match(/const RELAY_SCRIPT: &str = r#"([\s\S]*?)"#;/)![1];
let now = 100000;
let tick: () => Promise<void>;
let calls = 0;
let limited = false;
const window: any = {};
class Clock extends Date { static now() { return now; } }
vm.runInNewContext(script, {
  window, Date: Clock, Math, location: { pathname: '/c/abc-123' },
  document: { body: {}, querySelector: (s: string) => s.includes('stop-button') ? null : {} },
  MutationObserver: class { observe() {} },
  setTimeout() {}, clearTimeout() {}, setInterval(fn: typeof tick) { tick = fn; },
  fetch: async (url: string) => {
    calls++;
    if (url.includes('/api/auth')) return { ok: true, json: async () => ({ accessToken: 'test' }) };
    if (limited) return { ok: false, status: 429, headers: { get: () => '120' } };
    return { ok: true, json: async () => ({ current_node: 'a', mapping: {
      a: { id: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Saved reply'] }, create_time: 1 } },
    } }) };
  },
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(window.__tempestState.messages[0].text, 'Saved reply');
const initialCalls = calls;
for (let i = 0; i < 30; i++) await tick!();
assert.equal(calls, initialCalls, 'DOM/poll bursts must not request again');
now += 60001;
limited = true;
await tick!();
assert.match(window.__tempestState.error, /429/);
assert.equal(window.__tempestState.apiOk, false, 'cached success must not mask a failed fetch');
assert.ok(Number.isInteger(window.__tempestState.retryAt));
assert.equal(window.__tempestState.messages[0].text, 'Saved reply', '429 preserves history');
const limitedCalls = calls;
now += 119000;
await tick!();
assert.equal(calls, limitedCalls, 'honor Retry-After');
now += 3000;
limited = false;
await tick!();
assert.equal(window.__tempestState.error, undefined, 'recover after cooldown');
assert.equal(window.__tempestState.apiOk, true);
console.log('browserAgent/relay: all checks passed');
