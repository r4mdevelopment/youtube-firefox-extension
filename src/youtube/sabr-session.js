import { isYouTubeUrl } from '../common/youtube-url.js';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { u8ToBase64 } from 'googlevideo/utils';
import { isMediaUrl } from '../common/messages.js';

function canonicalConfig(value) {
  if (typeof value !== 'string' || value.length > 65536 || !/^[A-Za-z0-9_+\/=-]+$/.test(value)) return null;
  try { return btoa(atob(value.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

// Opaque playback proof belongs only to this tab/video and lives in memory.
export function createSabrSessionStore({ now = Date.now, onCapture = () => {} } = {}) {
  const videos = new Map(); const sessions = new Map(); const pending = new Map(); const configurations = new Map();
  return {
    setVideo(tabId, videoId) {
      if (!videos.has(tabId) && sessions.has(tabId) && (!sessions.get(tabId).videoId || sessions.get(tabId).videoId === videoId)) sessions.get(tabId).videoId = videoId;
      else if (videos.get(tabId) !== videoId) sessions.delete(tabId);
      videos.set(tabId, videoId);
      const next = pending.get(tabId)?.get(videoId);
      if (next) { sessions.set(tabId, next); pending.get(tabId).delete(videoId); }
    },
    forgetTab(tabId) { videos.delete(tabId); sessions.delete(tabId); pending.delete(tabId); configurations.delete(tabId); },
    observe(details, { notify = true, capturedAt = now() } = {}) {
      try {
        if (!Number.isFinite(capturedAt) || capturedAt > now() || now() - capturedAt > 600000) return false;
        const origin = new URL(details.originUrl ?? details.initiator ?? details.documentUrl);
        if (!isYouTubeUrl(origin) || !Number.isInteger(details.tabId) || details.tabId < 0 ||
            details.method !== 'POST' || !isMediaUrl(details.url) || new URL(details.url).pathname !== '/videoplayback') return false;
        const source = new URL(details.documentUrl ?? details.originUrl ?? details.initiator);
        const sourceVideoId = isYouTubeUrl(source) ? source.searchParams.get('v') : null;
        const chunks = (details.requestBody?.raw ?? []).map(p => p.bytes ? new Uint8Array(p.bytes) : null);
        if (chunks.some(c => !c)) return false;
        const length = chunks.reduce((n, c) => n + c.length, 0);
        if (!length || length > 262144) return false;
        const bytes = new Uint8Array(length); let offset = 0;
        for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
        const request = VideoPlaybackAbrRequest.decode(bytes);
        const ctx = request.streamerContext;
        if (!request.videoPlaybackUstreamerConfig?.length || !ctx?.clientInfo) return false;
        const capture = { videoId: sourceVideoId ?? videos.get(details.tabId), createdAt: capturedAt,
          data: { url: details.url, videoPlaybackUstreamerConfig: u8ToBase64(request.videoPlaybackUstreamerConfig),
            clientInfo: ctx.clientInfo, poToken: ctx.poToken?.length ? u8ToBase64(ctx.poToken) : undefined } };
        const candidatesByConfig = configurations.get(details.tabId) ?? new Map();
        candidatesByConfig.delete(capture.data.videoPlaybackUstreamerConfig);
        candidatesByConfig.set(capture.data.videoPlaybackUstreamerConfig, capture);
        while (candidatesByConfig.size > 2) candidatesByConfig.delete(candidatesByConfig.keys().next().value);
        configurations.set(details.tabId, candidatesByConfig);
        if (sourceVideoId && videos.has(details.tabId) && videos.get(details.tabId) !== sourceVideoId) {
          const candidates = pending.get(details.tabId) ?? new Map();
          candidates.delete(sourceVideoId); candidates.set(sourceVideoId, capture);
          while (candidates.size > 2) candidates.delete(candidates.keys().next().value);
          pending.set(details.tabId, candidates);
        } else sessions.set(details.tabId, capture);
        if (notify) onCapture({ tabId: details.tabId, config: capture.data.videoPlaybackUstreamerConfig,
          request: { capturedAt, method: details.method, url: details.url, originUrl: details.originUrl, initiator: details.initiator,
            documentUrl: details.documentUrl, chunks: chunks.map(chunk => Array.from(chunk)) } });
        return true;
      } catch { return false; }
    },
    get(tabId, videoId, playerConfig) {
      // SPA requests can retain the original document URL. Match the accepted
      // current player's opaque config rather than relabelling an old session.
      if (playerConfig) {
        if (videos.get(tabId) !== videoId) return null;
        const candidate = configurations.get(tabId)?.get(canonicalConfig(playerConfig));
        return candidate && now() - candidate.createdAt <= 600000 ? structuredClone(candidate.data) : null;
      }
      const session = sessions.get(tabId);
      if (!session || session.videoId !== videoId || now() - session.createdAt > 600000) return null;
      return structuredClone(session.data);
    },
  };
}
