import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real stores with only the native transport/session registry mocked.
const listeners = new Map();
let nextSession = 0;
const native = {
  listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); },
  invoke: async () => {},
};
function load(path, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, console, require(name) {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const activity = load('store/androActivity.ts', {
  '@tauri-apps/api/event': native,
  '../lib/androActivity/types': load('lib/androActivity/types.ts'),
  '../lib/androActivity/normalize': load('lib/androActivity/normalize.ts'),
}).androActivity;
const runtime = load('store/browserAgentRuntime.ts', {
  '@tauri-apps/api/event': native, '@tauri-apps/api/core': native,
  './androActivity': { androActivity: activity },
  '../lib/browserAgent/normalize': { normalizeRelayPayload: () => null },
  '../lib/agentRuntime': { agentRuntime: {
    createSession: () => ({ id: `s${++nextSession}` }),
    setState() {}, stopSession() {}, removeSession() {}, publish() {},
  } },
}).browserAgentRuntime;
function emit(id, status, output) {
  listeners.get('andro-activity')({ payload: JSON.stringify({
    id, ts: 1, tool: 'Bash', status, argsSummary: 'printf test', paths: [],
    args: { command: 'printf test' }, output,
  }) });
}
const first = await runtime.start();
emit('call1', 'started');
assert.equal(activity.getSnapshot()[0]?.toolName, 'Bash', 'new browser sessions must receive shell events');
emit('call1', 'progress', 'one\n');
emit('call1', 'progress', 'two\n');
assert.equal(activity.getSnapshot().length, 1);
assert.equal(activity.getSnapshot()[0].result.content, 'one\ntwo\n');
assert.equal(activity.getSnapshot()[0].args.command, 'printf test');
emit('call1', 'ok', 'one\ntwo\n');
assert.equal(activity.getSnapshot()[0].status, 'complete');
const second = await runtime.createNewSession();
assert.equal(activity.getSnapshot().length, 0, 'new sessions start empty');
emit('call2', 'started');
await runtime.activate(first);
assert.equal(activity.getSnapshot()[0].id, 'call1', 'switching restores the selected history');
await runtime.closeSession(first);
assert.equal(runtime.getSessionId(), second);
assert.equal(activity.getSnapshot()[0].id, 'call2', 'closing selects the remaining activity history');
await runtime.newChatInActiveSession();
assert.equal(activity.getSnapshot().length, 0, 'new chat clears activity');
emit('call3', 'started');
await runtime.stop();
emit('orphan', 'started');
assert.equal(activity.getSnapshot().length, 0, 'closed sessions do not receive events');
console.log('PASS: browser session lifecycle routes Bash events, accumulates output, restores histories, and clears closed/new chats.');
