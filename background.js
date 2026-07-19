importScripts('wait-core.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Storage isolation ─────────────────────────────────────────────────────────
// Keep extension secrets out of content-script contexts.

// Keys and chat history are only needed by extension-owned pages. Restricting
// storage access keeps content scripts from reading either store.
for (const area of [chrome.storage.local, chrome.storage.session]) {
  if (typeof area.setAccessLevel === 'function') {
    area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       'ask-axion',
      title:    'Ask Axion: "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id:       'ask-axion-page',
      title:    'Ask Axion about this page',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const text = info.selectionText || '';
  chrome.storage.session.set({ prefillText: text });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ── Screenshot ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'screenshot') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse({ dataUrl: null }); return; }
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        void chrome.runtime.lastError;
        sendResponse({ dataUrl: dataUrl || null });
      });
    });
    return true;
  }
  if (msg.action === 'page-change-token' || msg.action === 'wait-for-page-change') {
    (async () => {
      try {
        const tab = await getTargetTab(msg.tabId);
        if (msg.action === 'page-change-token') {
          sendResponse({ ok: true, result: await capturePageState(tab.id, msg.input?.selector) });
          return;
        }
        const controller = new AbortController();
        if (msg.requestId) pendingPageWaits.set(msg.requestId, controller);
        try {
          const result = await waitForPageChange(tab.id, msg.input || {}, controller.signal);
          sendResponse({ ok: true, result });
        } finally {
          if (msg.requestId) pendingPageWaits.delete(msg.requestId);
        }
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
  if (msg.action === 'cancel-page-wait') {
    pendingPageWaits.get(msg.requestId)?.abort();
    pendingPageWaits.delete(msg.requestId);
    sendResponse({ ok: true });
  }
});

// ── Local Axion bridge ────────────────────────────────────────────────────────

const BRIDGE_CAPABILITIES = [
  'tabs.list', 'page.read', 'page.html', 'page.find', 'page.value',
  'page.screenshot', 'page.click', 'page.type', 'page.scroll',
  'page.navigate', 'page.select', 'page.wait',
];

const pendingPageWaits = new Map();

let bridgeSocket = null;
let bridgeReconnectTimer = null;
let bridgeRetryMs = 1_000;
let bridgeState = { status: 'disabled', connected: false, error: null };

function setBridgeState(status, extra = {}) {
  bridgeState = { status, connected: status === 'connected', error: null, ...extra };
  chrome.runtime.sendMessage({ action: 'bridge-state', state: bridgeState }).catch(() => {});
}

async function bridgeConfig() {
  const saved = await chrome.storage.local.get(['axionBridgeEnabled', 'axionBridgePort', 'axionBridgeToken']);
  return {
    enabled: saved.axionBridgeEnabled === true,
    port: Number(saved.axionBridgePort) || 3210,
    token: String(saved.axionBridgeToken || '').trim(),
  };
}

async function connectBridge({ immediate = false } = {}) {
  clearTimeout(bridgeReconnectTimer);
  bridgeReconnectTimer = null;
  if (bridgeSocket) {
    bridgeSocket.onclose = null;
    try { bridgeSocket.close(); } catch {}
    bridgeSocket = null;
  }

  const config = await bridgeConfig();
  if (!config.enabled) {
    setBridgeState('disabled');
    return;
  }
  if (!config.token) {
    setBridgeState('needs-pairing', { error: 'Paste the pairing token from Axion Desktop settings.' });
    return;
  }

  setBridgeState('connecting', { port: config.port });
  const url = `ws://127.0.0.1:${config.port}/?role=extension&token=${encodeURIComponent(config.token)}`;
  const socket = new WebSocket(url);
  bridgeSocket = socket;

  socket.onopen = () => {
    bridgeRetryMs = 1_000;
    setBridgeState('connected', { port: config.port });
    socket.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version, capabilities: BRIDGE_CAPABILITIES }));
  };
  socket.onmessage = (event) => {
    void handleBridgeMessage(socket, event.data);
  };
  socket.onerror = () => {
    setBridgeState('error', { port: config.port, error: 'Could not reach the local Axion bridge.' });
  };
  socket.onclose = () => {
    if (bridgeSocket !== socket) return;
    bridgeSocket = null;
    setBridgeState('waiting', { port: config.port, error: 'Waiting for Axion CLI or Desktop.' });
    bridgeReconnectTimer = setTimeout(() => void connectBridge(), immediate ? 250 : bridgeRetryMs);
    bridgeRetryMs = Math.min(bridgeRetryMs * 1.7, 15_000);
  };
}

async function handleBridgeMessage(socket, raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.type === 'ping') {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    return;
  }
  if (message.type !== 'request' || !message.id) return;
  try {
    const result = await executeBridgeCommand(message.method, message.params || {});
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result }));
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'response', id: message.id, ok: false, error: error?.message || String(error) }));
    }
  }
}

function chromeCall(invoke) {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function getTargetTab(tabId) {
  if (Number.isInteger(tabId)) return chromeCall((done) => chrome.tabs.get(tabId, done));
  const tabs = await chromeCall((done) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, done));
  if (!tabs[0]) throw new Error('Chrome has no active tab.');
  return tabs[0];
}

async function sendPageTool(tabId, tool, input) {
  const send = () => chromeCall((done) => chrome.tabs.sendMessage(tabId, { action: 'page_tool', tool, input }, done));
  let response;
  try {
    response = await send();
  } catch (error) {
    if (!/receiving end|Could not establish connection/i.test(error.message)) throw error;
    await chromeCall((done) => chrome.scripting.executeScript({ target: { tabId }, files: ['wait-core.js', 'content.js'] }, done));
    response = await send();
  }
  if (!response?.ok) throw new Error(response?.error || `Chrome page tool failed: ${tool}`);
  return response.result;
}

async function capturePageState(tabId, selector = null) {
  const tab = await getTargetTab(tabId);
  let pageState = null;
  let pageError = null;
  try {
    pageState = await sendPageTool(tab.id, 'page_state', selector ? { selector } : {});
  } catch (error) {
    // During a full navigation there is briefly no content-script receiver.
    // Tab URL/title still let URL waits complete; DOM waits retry until ready.
    if (/Invalid CSS selector/i.test(error?.message || '')) throw error;
    pageError = error?.message || String(error);
  }
  return AxionPageWait.normalizeToken({
    url: pageState?.url || tab.url || '',
    title: pageState?.title || tab.title || '',
    content_signature: pageState?.content_signature || null,
    selector: selector || pageState?.selector || null,
    selector_exists: pageState?.selector_exists,
    selector_signature: pageState?.selector_signature,
    page_error: pageError,
  });
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Page wait cancelled', 'AbortError'));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Page wait cancelled', 'AbortError'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForPageChange(tabId, rawInput = {}, signal = null) {
  const options = AxionPageWait.normalizeWaitInput(rawInput);
  const startedAt = Date.now();
  let current = await capturePageState(tabId, options.selector);
  let baseline = options.changeToken;

  const selectorBaselineMatches = baseline
    && (!options.selector || !baseline.selector || baseline.selector === options.selector);
  const tokenHasRequiredBaseline = baseline && (
    options.condition === 'url'
      ? Boolean(baseline.url)
      : options.condition === 'content'
        ? Boolean(baseline.content_signature)
        : options.condition === 'selector'
          ? selectorBaselineMatches && typeof baseline.selector_exists === 'boolean'
          : Boolean(baseline.url || baseline.content_signature)
  );
  if (!tokenHasRequiredBaseline) baseline = current;

  while (true) {
    const reason = AxionPageWait.detectPageChange(baseline, current, options.condition);
    if (reason) {
      if (options.settleMs) {
        await abortableDelay(options.settleMs, signal);
        current = await capturePageState(tabId, options.selector);
      }
      return {
        changed: true,
        timed_out: false,
        reason,
        elapsed_ms: Date.now() - startedAt,
        change_token: current,
      };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      return {
        changed: false,
        timed_out: true,
        reason: 'timeout',
        elapsed_ms: elapsed,
        change_token: current,
      };
    }
    await abortableDelay(Math.min(250, options.timeoutMs - elapsed), signal);
    current = await capturePageState(tabId, options.selector);
  }
}

function safeNavigationUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('Enter a valid absolute URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Navigation is limited to http:// and https:// URLs.');
  return url.href;
}

async function executeBridgeCommand(method, params) {
  if (method === 'tabs.list') {
    const tabs = await chromeCall((done) => chrome.tabs.query({}, done));
    return tabs.map((tab) => ({
      id: tab.id, windowId: tab.windowId, active: tab.active, pinned: tab.pinned,
      title: tab.title || '', url: tab.url || '',
    }));
  }

  const tab = await getTargetTab(params.tabId);
  if (method === 'page.screenshot') {
    if (!tab.active) throw new Error('Screenshots require the requested tab to be active.');
    const dataUrl = await chromeCall((done) => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, done));
    if (!dataUrl) throw new Error('Chrome did not return a screenshot.');
    return { dataUrl, title: tab.title || '', url: tab.url || '' };
  }
  if (method === 'page.navigate') {
    const changeToken = await capturePageState(tab.id);
    const url = safeNavigationUrl(params.url);
    const updated = await chromeCall((done) => chrome.tabs.update(tab.id, { url }, done));
    return { tabId: updated.id, url, change_token: changeToken };
  }
  if (method === 'page.wait') {
    const input = { ...params };
    delete input.tabId;
    return waitForPageChange(tab.id, input);
  }

  const toolMap = {
    'page.read': 'read_page',
    'page.html': 'get_html',
    'page.find': 'find_elements',
    'page.value': 'get_value',
    'page.click': 'click',
    'page.type': 'type_text',
    'page.scroll': 'scroll',
    'page.select': 'select_option',
  };
  const tool = toolMap[method];
  if (!tool) throw new Error(`Unsupported browser command: ${method}`);
  const input = { ...params };
  delete input.tabId;
  return sendPageTool(tab.id, tool, input);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'bridge-status') {
    sendResponse(bridgeState);
    return;
  }
  if (msg.action === 'bridge-reconnect') {
    void connectBridge({ immediate: true });
    sendResponse({ ok: true });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.axionBridgeEnabled || changes.axionBridgePort || changes.axionBridgeToken) {
    void connectBridge({ immediate: true });
  }
});

void connectBridge();
