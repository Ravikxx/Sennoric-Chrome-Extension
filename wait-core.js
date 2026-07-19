// Dependency-free page-change comparison helpers shared by the extension's
// service worker and tests. Page content itself is never stored here: callers
// provide bounded fingerprints produced by content.js.
(function initAxionPageWait(root) {
  const CONDITIONS = new Set(['any', 'url', 'content', 'selector']);
  const DEFAULT_TIMEOUT_MS = 10_000;
  const MIN_TIMEOUT_MS = 500;
  // Leave headroom under the bridge client's 30-second request deadline.
  const MAX_TIMEOUT_MS = 25_000;
  const DEFAULT_SETTLE_MS = 300;
  const MAX_SETTLE_MS = 2_000;

  const clampInteger = (value, fallback, min, max) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  };

  function normalizeToken(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const token = {
      url: typeof value.url === 'string' ? value.url.slice(0, 8_192) : '',
      title: typeof value.title === 'string' ? value.title.slice(0, 1_024) : '',
      content_signature: typeof value.content_signature === 'string'
        ? value.content_signature.slice(0, 128)
        : null,
      selector: typeof value.selector === 'string' ? value.selector.slice(0, 1_024) : null,
      selector_exists: typeof value.selector_exists === 'boolean' ? value.selector_exists : null,
      selector_signature: typeof value.selector_signature === 'string'
        ? value.selector_signature.slice(0, 128)
        : null,
    };
    return token;
  }

  function normalizeWaitInput(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const selector = typeof input.selector === 'string' && input.selector.trim()
      ? input.selector.trim().slice(0, 1_024)
      : null;
    const changeToken = normalizeToken(input.change_token);
    const requestedCondition = typeof input.condition === 'string' ? input.condition : '';
    const condition = CONDITIONS.has(requestedCondition)
      ? requestedCondition
      : (selector ? 'selector' : 'any');
    const effectiveSelector = selector || changeToken?.selector || null;
    if (condition === 'selector' && !effectiveSelector) {
      throw new Error('selector is required when condition is "selector"');
    }
    return {
      condition,
      selector: effectiveSelector,
      timeoutMs: clampInteger(input.timeout_ms, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      settleMs: clampInteger(input.settle_ms, DEFAULT_SETTLE_MS, 0, MAX_SETTLE_MS),
      changeToken,
    };
  }

  function detectPageChange(baselineValue, currentValue, condition = 'any') {
    const baseline = normalizeToken(baselineValue);
    const current = normalizeToken(currentValue);
    if (!baseline || !current) return null;

    const changed = {
      url: Boolean(baseline.url && current.url && baseline.url !== current.url),
      title: baseline.title !== current.title,
      content: Boolean(
        baseline.content_signature
        && current.content_signature
        && baseline.content_signature !== current.content_signature
      ),
      selector: Boolean(
        (typeof baseline.selector_exists === 'boolean' && typeof current.selector_exists === 'boolean'
          && baseline.selector_exists !== current.selector_exists)
        || (baseline.selector_signature && current.selector_signature
          && baseline.selector_signature !== current.selector_signature)
      ),
    };

    if (condition === 'url') return changed.url ? 'url' : null;
    if (condition === 'content') return changed.content ? 'content' : null;
    if (condition === 'selector') return changed.selector ? 'selector' : null;
    if (changed.url) return 'url';
    if (changed.selector) return 'selector';
    if (changed.content) return 'content';
    if (changed.title) return 'title';
    return null;
  }

  root.AxionPageWait = Object.freeze({
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    normalizeToken,
    normalizeWaitInput,
    detectPageChange,
  });
})(globalThis);
