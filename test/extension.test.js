import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function loadCore() {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(resolve('core.js'), 'utf8'), context);
  return context.AxionExtensionCore;
}

test('extension policy requires approval for sensitive and mutating tools', () => {
  const core = loadCore();
  for (const name of ['click', 'type_text', 'select_option', 'navigate', 'take_screenshot']) {
    assert.equal(core.toolRequiresApproval(name), true, name);
  }
  for (const name of ['read_page', 'find_elements', 'get_html', 'get_value', 'scroll']) {
    assert.equal(core.toolRequiresApproval(name), false, name);
  }
  assert.equal(core.MAX_AGENT_ROUNDS, 12);
});

test('extension policy rejects unsafe navigation and non-loopback imports', () => {
  const core = loadCore();
  assert.equal(core.normalizeNavigationUrl('https://example.com/a'), 'https://example.com/a');
  assert.throws(() => core.normalizeNavigationUrl('javascript:alert(1)'), /limited to http/);
  assert.equal(core.normalizeLoopbackBaseURL('http://localhost:8080/path'), 'http://localhost:8080');
  assert.equal(core.normalizeLoopbackBaseURL('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.throws(() => core.normalizeLoopbackBaseURL('https://example.com'), /loopback/);
  assert.throws(() => core.normalizeLoopbackBaseURL('http://user:pass@localhost:3000'), /credentials/);
});

test('content typing uses the correct textarea setter and focused-element fallback', () => {
  class InputElement {
    constructor() { this.tagName = 'INPUT'; }
    focus() { this.focused = true; }
    dispatchEvent(event) { (this.events ||= []).push(event.type); }
  }
  class TextAreaElement {
    constructor() { this.tagName = 'TEXTAREA'; }
    focus() { this.focused = true; }
    dispatchEvent(event) { (this.events ||= []).push(event.type); }
  }
  Object.defineProperty(InputElement.prototype, 'value', {
    get() { return this._value || ''; },
    set(value) {
      if (!(this instanceof InputElement)) throw new TypeError('wrong input receiver');
      this._value = value;
    },
  });
  Object.defineProperty(TextAreaElement.prototype, 'value', {
    get() { return this._value || ''; },
    set(value) {
      if (!(this instanceof TextAreaElement)) throw new TypeError('wrong textarea receiver');
      this._value = value;
    },
  });
  const textarea = new TextAreaElement();
  const body = {};
  const documentElement = {};
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    window: { HTMLInputElement: InputElement, HTMLTextAreaElement: TextAreaElement, getComputedStyle() { return {}; } },
    document: { activeElement: textarea, body, documentElement },
    Event: class Event { constructor(type) { this.type = type; } },
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: String },
  });
  vm.runInContext(readFileSync(resolve('content.js'), 'utf8'), context);
  const result = context.typeText({ value: 'hello' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { typed: 'hello', into: 'textarea' });
  assert.equal(textarea.value, 'hello');
  assert.deepEqual(textarea.events, ['input', 'change']);

  textarea.events = [];
  context.typeText({ value: ' world', clear: false });
  assert.equal(textarea.value, 'hello world');
  assert.deepEqual(textarea.events, ['input', 'change']);
});

test('sidebar loads policy before app code and no longer auto-injects page text', () => {
  const html = readFileSync(resolve('sidebar.html'), 'utf8');
  const sidebar = readFileSync(resolve('sidebar.js'), 'utf8');
  assert.ok(html.indexOf('src="core.js"') < html.indexOf('src="sidebar.js"'));
  assert.doesNotMatch(sidebar, /Page context — auto-read/);
  assert.match(sidebar, /MAX_AGENT_ROUNDS/);
  assert.match(sidebar, /name: 'get_value'/);
  assert.match(sidebar, /requestToolApproval/);
});
