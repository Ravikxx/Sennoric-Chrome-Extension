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
});
