function key(config) {
  if (typeof config !== 'string' || config.length > 65536) return null;
  try { return btoa(atob(config.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}
// This cache stays inside the isolated content script; proof is never written to storage.
export function createPlaybackCache({ now = Date.now } = {}) {
  const captures = new Map();
  return {
    put({ config, request }) {
      const id = key(config); if (!id || !request) return;
      captures.delete(id); captures.set(id, { request: structuredClone(request), at: request.capturedAt ?? now() });
      while (captures.size > 2) captures.delete(captures.keys().next().value);
    },
    get(config) {
      const value = captures.get(key(config));
      return value && value.at <= now() && now() - value.at <= 600000 ? structuredClone(value.request) : null;
    },
  };
}
