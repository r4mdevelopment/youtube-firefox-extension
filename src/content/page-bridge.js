import { parsePageMessage, YTDL_PAGE_BRIDGE_MESSAGE, YTDL_PAGE_BRIDGE_REQUEST } from '../common/messages.js';

export function collectPlayerMetadata(player, { videoId, generation }) {
  if (player?.videoDetails?.videoId !== videoId) return null;
  return parsePageMessage({ type: YTDL_PAGE_BRIDGE_MESSAGE, videoId, generation, payload: {
    title: player.videoDetails.title ?? '', duration: Number(player.videoDetails.lengthSeconds) || 0,
    status: player.videoDetails.isLiveContent ? 'LIVE' : player.playabilityStatus?.status && player.playabilityStatus.status !== 'OK' ? 'UNAVAILABLE' : 'OK',
    formats: player.streamingData?.formats ?? [], adaptiveFormats: player.streamingData?.adaptiveFormats ?? [],
    sabrConfig: player.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
    transport: player.streamingData?.serverAbrStreamingUrl ? 'SABR' : 'DIRECT',
  } });
}

if (typeof window !== 'undefined' && !window.__ytdlBridgeInstalled) {
  window.__ytdlBridgeInstalled = true;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== YTDL_PAGE_BRIDGE_REQUEST) return;
    const { videoId, generation } = event.data;
    if (!/^[\w-]{11}$/.test(videoId) || !Number.isSafeInteger(generation) || generation < 0) return;
    try {
      const player = document.querySelector('#movie_player')?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
      const metadata = collectPlayerMetadata(player, { videoId, generation });
      if (metadata) window.postMessage(metadata, location.origin);
    } catch { /* Player may be unavailable while YouTube is replacing it. */ }
  });
}
