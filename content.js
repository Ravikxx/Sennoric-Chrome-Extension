// Runs on every page. Receives tool commands from the sidebar and executes DOM operations.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'page_tool') return;
  (async () => {
    try {
      sendResponse({ ok: true, result: await dispatch(msg.tool, msg.input) });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

async function dispatch(tool, input) {
  switch (tool) {
    case 'read_page':      return readPage();
    case 'get_html':       return getHtml(input);
    case 'find_elements':  return findElements(input);
    case 'click':          return clickEl(input);
    case 'type_text':      return typeText(input);
    case 'scroll':         return scroll(input);
    case 'select_option':  return selectOption(input);
    case 'get_value':      return getValue(input);
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

function readPage() {
  const clone = document.body.cloneNode(true);
  for (const el of clone.querySelectorAll('script,style,noscript,svg,iframe')) el.remove();
  const text = (clone.innerText || clone.textContent || '').replace(/\s{3,}/g, '\n\n').trim();
  return {
    url:   location.href,
    title: document.title,
    text:  text.slice(0, 12000),
  };
}

function getHtml({ selector = 'body', limit = 4000 } = {}) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`No element matches "${selector}"`);
  return el.outerHTML.slice(0, limit);
}

function findElements({ selector, text: textQuery, limit = 10 } = {}) {
  let els = [];
  if (selector) {
    els = [...document.querySelectorAll(selector)];
  } else if (textQuery) {
    const all = document.querySelectorAll('a,button,input,select,textarea,label,[role=button],[role=link],[contenteditable]');
    const q = textQuery.toLowerCase();
    els = [...all].filter(el => (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').toLowerCase().includes(q));
  }
  return els.slice(0, limit).map(el => ({
    tag:       el.tagName.toLowerCase(),
    text:      (el.innerText || el.value || '').slice(0, 80).trim(),
    selector:  uniqueSelector(el),
    type:      el.type || null,
    href:      el.href || null,
    visible:   isVisible(el),
  }));
}

function clickEl({ selector, text: textQuery } = {}) {
  const el = resolveEl(selector, textQuery);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus();
  el.click();
  return { clicked: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 60).trim() };
}

function typeText({ selector, text: textQuery, value, clear = true } = {}) {
  if (typeof value !== 'string') throw new Error('"value" must be a string');
  const el = selector || textQuery ? resolveEl(selector, textQuery) : document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    throw new Error('No editable element is focused');
  }
  el.focus();

  if (el.isContentEditable) {
    // contenteditable divs (e.g. Claude, Notion, ProseMirror/Lexical editors):
    // execCommand fires the mutation events these frameworks listen to.
    if (clear) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
    document.execCommand('insertText', false, value);
    return { typed: value.slice(0, 60), into: el.tagName.toLowerCase() };
  }

  // Standard <input> / <textarea> path. Use the matching native setter so
  // React and other controlled-input frameworks observe the update.
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : el instanceof window.HTMLInputElement
      ? window.HTMLInputElement.prototype
      : null;
  if (!proto) throw new Error('Element is not editable');
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!nativeSetter?.set) throw new Error('Editable element has no value setter');
  const nextValue = clear ? value : `${el.value || ''}${value}`;
  nativeSetter.set.call(el, nextValue);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: value.slice(0, 60), into: el.tagName.toLowerCase() };
}

function scroll({ direction = 'down', amount = 400, selector } = {}) {
  const target = selector ? document.querySelector(selector) : window;
  if (!target) throw new Error(`No element matches "${selector}"`);
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  if (target === window) window.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
  else target.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
  return { scrolled: direction, amount };
}

function selectOption({ selector, text: textQuery, value, label } = {}) {
  const el = resolveEl(selector, textQuery);
  if (el.tagName.toLowerCase() !== 'select') throw new Error('Element is not a <select>');
  const opt = [...el.options].find(o =>
    (value && o.value === value) || (label && o.text.toLowerCase().includes(label.toLowerCase()))
  );
  if (!opt) throw new Error(`Option not found: ${value || label}`);
  el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: opt.text };
}

function getValue({ selector, text: textQuery } = {}) {
  const el = resolveEl(selector, textQuery);
  return { value: el.value, text: el.innerText?.slice(0, 200) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveEl(selector, textQuery) {
  if (selector) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  if (textQuery) {
    const all = document.querySelectorAll('a,button,input,select,textarea,label,[role=button],[role=link],[role=menuitem],[contenteditable]');
    const q = textQuery.toLowerCase();
    const found = [...all].find(el =>
      isVisible(el) &&
      (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').toLowerCase().includes(q)
    );
    if (found) return found;
  }
  throw new Error(`Could not find element: ${selector || textQuery}`);
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
}

function uniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const siblings = node.parentElement
      ? [...node.parentElement.children].filter(s => s.tagName === node.tagName)
      : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    const candidate = parts.join(' > ');
    if (document.querySelectorAll(candidate).length === 1) return candidate;
    node = node.parentElement;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}
