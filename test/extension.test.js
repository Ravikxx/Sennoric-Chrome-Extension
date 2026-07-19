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

function loadWaitCore() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(resolve('wait-core.js'), 'utf8'), context);
  return context.AxionPageWait;
}

test('extension policy requires approval for sensitive and mutating tools', () => {
  const core = loadCore();
  for (const name of ['click', 'type_text', 'select_option', 'navigate', 'take_screenshot']) {
    assert.equal(core.toolRequiresApproval(name), true, name);
  }
  for (const name of ['read_page', 'find_elements', 'get_html', 'get_value', 'scroll', 'wait_for_page_change']) {
    assert.equal(core.toolRequiresApproval(name), false, name);
  }
  assert.equal(core.MAX_AGENT_ROUNDS, 12);
});

test('page wait options are bounded and page changes are classified', () => {
  const wait = loadWaitCore();
  const normalized = wait.normalizeWaitInput({ timeout_ms: 100_000, settle_ms: -20 });
  assert.equal(normalized.timeoutMs, 25_000);
  assert.equal(normalized.settleMs, 0);
  assert.equal(normalized.condition, 'any');
  assert.throws(() => wait.normalizeWaitInput({ condition: 'selector' }), /selector is required/);

  const before = { url: 'https://example.com/a', title: 'A', content_signature: '111' };
  assert.equal(wait.detectPageChange(before, { ...before, url: 'https://example.com/b' }), 'url');
  assert.equal(wait.detectPageChange(before, { ...before, content_signature: '222' }, 'content'), 'content');
  assert.equal(wait.detectPageChange(
    { ...before, selector: '#status', selector_exists: false },
    { ...before, selector: '#status', selector_exists: true },
    'selector',
  ), 'selector');
  assert.equal(wait.detectPageChange(before, before), null);
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
    document: {
      activeElement: textarea,
      body,
      documentElement,
      title: 'Test',
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    location: { href: 'https://example.com/' },
    Event: class Event { constructor(type) { this.type = type; } },
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: String },
  });
  vm.runInContext(readFileSync(resolve('wait-core.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve('content.js'), 'utf8'), context);
  const result = context.typeText({ value: 'hello' });
  assert.equal(result.typed, 'hello');
  assert.equal(result.into, 'textarea');
  assert.equal(result.change_token.url, 'https://example.com/');
  assert.ok(result.change_token.content_signature);
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
  assert.match(sidebar, /name: 'wait_for_page_change'/);
  assert.match(sidebar, /change_token/);
});

test('extension exposes the authenticated local Axion bridge controls', () => {
  const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8'));
  const background = readFileSync(resolve('background.js'), 'utf8');
  const html = readFileSync(resolve('sidebar.html'), 'utf8');
  assert.equal(manifest.version, '1.2.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.match(background, /role=extension/);
  assert.match(background, /axionBridgeToken/);
  assert.match(background, /page\.screenshot/);
  assert.match(background, /page\.wait/);
  assert.match(background, /waitForPageChange/);
  assert.match(html, /id="bridge-token"/);
  assert.match(html, /id="bridge-indicator"/);
  assert.deepEqual(manifest.content_scripts[0].js, ['wait-core.js', 'content.js']);
});
