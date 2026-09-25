import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual injected script, including its timer-driven submission.
const source = readFileSync(new URL('../src-tauri/src/browser_agent.rs', import.meta.url), 'utf8');
const script = source.slice(source.indexOf('pub async fn send_prompt_to_browser_agent'))
  .match(/r#"([\s\S]*?)"#/)[1].replaceAll('{{', '{').replaceAll('}}', '}')
  .replace('{text}', JSON.stringify('diagnostic test'));

for (const scenario of ['legacy', 'current', 'disabled', 'aria-disabled', 'missing']) {
  let now = 0, nextId = 0, clicks = 0;
  const timers = new Map();
  const window = {};
  const button = {
    disabled: scenario === 'disabled',
    getAttribute(name) { return name === 'aria-disabled' && scenario === 'aria-disabled' ? 'true' : null; },
    click() { clicks++; box.textContent = ''; },
  };
  const form = {
    querySelector(s) {
      if (scenario === 'missing') return null;
      if (s.includes('data-testid')) return scenario === 'legacy' ? button : null;
      return scenario !== 'legacy' ? button : null;
    },
    querySelectorAll() { return []; },
  };
  const box = {
    textContent: '', isConnected: true, isContentEditable: true,
    focus() { document.activeElement = box; }, closest() { return form; },
  };
  const document = {
    readyState: 'complete', visibilityState: 'hidden', activeElement: null,
    querySelector(s) {
      if (s.includes('stop-button')) return null;
      assert.ok(s.includes('contenteditable'), 'buttons must be looked up within the composer form');
      return box;
    },
    execCommand(command, _, value) { if (command === 'insertText') box.textContent = value; return true; },
  };
  const schedule = (fn, ms, interval) => { const id = ++nextId; timers.set(id, { fn, due: now + ms, interval }); return id; };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(script, {
    window, document, location: { pathname: '/' }, Date: Clock,
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => timers.delete(id),
  });
  while (timers.size) {
    const [id, task] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
    assert.ok(task.due < 6000, 'submission must terminate');
    now = task.due;
    if (task.interval) task.due += task.interval; else timers.delete(id);
    task.fn();
  }
  const success = scenario === 'legacy' || scenario === 'current';
  assert.equal(clicks, success ? 1 : 0);
  assert.equal(window.__tempestPromptResult.ok, success);
  assert.equal(window.__tempestPromptResult.reason,
    success ? null : scenario === 'missing' ? 'send button not found' : 'send button never enabled');
  console.log(`PASS ${scenario}: clicks=${clicks}, result=${JSON.stringify(window.__tempestPromptResult)}`);
}
