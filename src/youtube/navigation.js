export function videoIdFromUrl(href) {
  try {
    const url = new URL(href);
    const id = url.searchParams.get('v');
    return url.origin === 'https://www.youtube.com' && url.pathname === '/watch' && /^[\w-]{11}$/.test(id ?? '') ? id : null;
  } catch { return null; }
}
export function createNavigationTracker({ onVideoChanged, env = window }) {
  let state = { videoId: null, generation: 0 };
  let timer; let started = false;
  const check = () => {
    const videoId = videoIdFromUrl(env.location.href);
    if (videoId !== state.videoId) {
      state = { videoId, generation: state.generation + 1 };
      onVideoChanged({ ...state });
    }
  };
  return {
    start() {
      if (started) return;
      started = true; check();
      for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate']) env.addEventListener(event, check);
      timer = env.setInterval(check, 750);
    },
    stop() {
      started = false; env.clearInterval(timer);
      for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate']) env.removeEventListener(event, check);
    },
    current() { check(); return { ...state }; },
  };
}
