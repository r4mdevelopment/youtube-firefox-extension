import { afterEach, expect, it, vi } from 'vitest';
import { createNavigationTracker, videoIdFromUrl } from '../../src/youtube/navigation.js';
afterEach(() => vi.useRealTimers());
export function navigationEnvironment() {
  const events = new EventTarget();
  return { location: { href: 'https://www.youtube.com/watch?v=abcdefghijk' },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events), setInterval, clearInterval };
}
it('tracks initial video, changes, duplicates, and non-watch clearing', () => {
  vi.useFakeTimers();
  const env = navigationEnvironment(); const changes = [];
  const tracker = createNavigationTracker({ env, onVideoChanged: state => changes.push(state) });
  tracker.start();
  expect(tracker.current()).toEqual({ videoId: 'abcdefghijk', generation: 1 });
  env.location.href = 'https://www.youtube.com/watch?v=lmnopqrstuv';
  env.dispatchEvent(new Event('yt-navigate-finish'));
  expect(tracker.current()).toEqual({ videoId: 'lmnopqrstuv', generation: 2 });
  env.dispatchEvent(new Event('yt-navigate-finish'));
  expect(changes).toHaveLength(2);
  env.location.href = 'https://www.youtube.com/';
  vi.advanceTimersByTime(1000);
  expect(tracker.current()).toEqual({ videoId: null, generation: 3 });
  tracker.stop();
});
it('rejects video IDs outside normal YouTube watch URLs', () => {
  const env = navigationEnvironment(); env.location.href = 'https://evil.test/watch?v=abcdefghijk';
  const tracker = createNavigationTracker({ env, onVideoChanged() {} });
  tracker.start(); expect(tracker.current().videoId).toBeNull(); tracker.stop();
});

it.each(['youtube.com', 'www.youtube.com'])('recognizes HTTPS watch pages on %s', host => {
  expect(videoIdFromUrl(`https://${host}/watch?v=abcdefghijk`)).toBe('abcdefghijk');
});
it.each(['https://youtube.com.evil.test', 'https://m.youtube.com', 'http://youtube.com', 'https://youtube.com:8443'])('rejects unsupported origins %s', origin => {
  expect(videoIdFromUrl(`${origin}/watch?v=abcdefghijk`)).toBeNull();
});
