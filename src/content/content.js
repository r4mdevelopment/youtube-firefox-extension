import { callApi, getExtensionApi } from '../common/browser-api.js';
import { parsePageMessage, makeExtensionMessage, YTDL_PAGE_BRIDGE_REQUEST } from '../common/messages.js';
import { createNavigationTracker } from '../youtube/navigation.js';

export async function forwardPageMessage(value, send = message => callApi('runtime', 'sendMessage', message), current) {
  const metadata = parsePageMessage(value);
  if (!metadata) return false;
  if (current) {
    const state = current();
    if (metadata.videoId !== state.videoId || metadata.generation !== state.generation) return false;
  }
  await send(makeExtensionMessage('VIDEO_METADATA', metadata));
  return true;
}

if (typeof window !== 'undefined') {
  let requestTimer;
  const documentToken = crypto.randomUUID();
  let received = null;
  const refreshWaiters = new Set();
  const tracker = createNavigationTracker({ onVideoChanged: state => {
    received = null;
    clearInterval(requestTimer);
    callApi('runtime', 'sendMessage', makeExtensionMessage('VIDEO_CHANGED', { ...state, documentToken })).catch(() => {});
    if (!state.videoId) return;
    let attempts = 0;
    const request = () => {
      if (++attempts > 30 || received) { clearInterval(requestTimer); return; }
      window.postMessage({ type: YTDL_PAGE_BRIDGE_REQUEST, ...state }, location.origin);
    };
    requestTimer = setInterval(request, 500); request();
  } });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    forwardPageMessage(event.data, async message => {
      message.payload.documentToken = documentToken;
      received = message.payload;
      for (const resolve of refreshWaiters) resolve(received);
      refreshWaiters.clear();
      await callApi('runtime', 'sendMessage', message);
    }, tracker.current).catch(() => {});
  });
  callApi('runtime', 'sendMessage', makeExtensionMessage('INJECT_BRIDGE')).then(() => tracker.start()).catch(() => {});
  const api = getExtensionApi();
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== api.runtime.id) return false;
    if (message?.type === 'GET_CURRENT_METADATA') {
      const state = { ...tracker.current(), documentToken };
      respond({ state, metadata: received }); return false;
    }
    if (message?.type !== 'REFRESH_STREAMS') return false;
    const state = tracker.current();
    if (!state.videoId) { respond({ error: { code: 'STALE_VIDEO', message: 'Текущий ролик изменился.' } }); return false; }
    let timeout;
    const accept = metadata => {
      clearTimeout(timeout); refreshWaiters.delete(accept);
      respond(metadata.videoId === state.videoId && metadata.generation === state.generation ? metadata : { error: { code: 'STALE_VIDEO', message: 'Ролик изменился во время обновления потоков.' } });
    };
    refreshWaiters.add(accept);
    timeout = setTimeout(() => { refreshWaiters.delete(accept); respond({ error: { code: 'REFRESH_TIMEOUT', message: 'Не удалось обновить адреса потоков.' } }); }, 10000);
    window.postMessage({ type: YTDL_PAGE_BRIDGE_REQUEST, ...state }, location.origin);
    return true;
  });
}
