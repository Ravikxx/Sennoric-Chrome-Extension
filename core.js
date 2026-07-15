// Shared, dependency-free policy helpers for the extension sidebar.
// Kept as a classic script so the unpacked extension works without a build step.
(function initAxionExtensionCore(root) {
  const MAX_AGENT_ROUNDS = 12;
  const APPROVAL_TOOLS = new Set([
    'click',
    'type_text',
    'select_option',
    'navigate',
    'take_screenshot',
  ]);

  function toolRequiresApproval(name) {
    return APPROVAL_TOOLS.has(name);
  }

  function normalizeNavigationUrl(raw) {
    let url;
    try { url = new URL(String(raw || '')); }
    catch { throw new Error('Enter a valid absolute URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Navigation is limited to http:// and https:// URLs.');
    }
    return url.href;
  }

  function normalizeLoopbackBaseURL(raw) {
    let url;
    try { url = new URL(String(raw || '')); }
    catch { throw new Error('Enter a valid Axion CLI URL.'); }
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
      throw new Error('CLI import is restricted to an http:// loopback address.');
    }
    if (url.username || url.password) throw new Error('CLI URLs cannot contain credentials.');
    return url.origin;
  }

  function describeToolAction(name, input = {}) {
    const truncate = (value, length = 160) => {
      const text = String(value ?? '');
      return text.length > length ? `${text.slice(0, length)}…` : text;
    };
    switch (name) {
      case 'click':
        return `Click ${truncate(input.text || input.selector || 'the requested element')}`;
      case 'type_text':
        return `Type “${truncate(input.value)}” into ${truncate(input.text || input.selector || 'the focused field')}`;
      case 'select_option':
        return `Select ${truncate(input.label || input.value || 'the requested option')}`;
      case 'navigate':
        return `Navigate to ${truncate(input.url)}`;
      case 'take_screenshot':
        return 'Capture the visible tab and send the image to the selected model';
      default:
        return `Run ${name}`;
    }
  }

  root.AxionExtensionCore = Object.freeze({
    MAX_AGENT_ROUNDS,
    toolRequiresApproval,
    normalizeNavigationUrl,
    normalizeLoopbackBaseURL,
    describeToolAction,
  });
})(globalThis);
