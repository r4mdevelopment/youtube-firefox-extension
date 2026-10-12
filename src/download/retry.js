import { DownloadError, checkAbort } from '../common/errors.js';
export function shouldRetry(error, attempt) {
  if (attempt >= 3 || error?.name === 'AbortError' || error?.code === 'CANCELLED') return false;
  if (Number.isFinite(error?.status)) return [429, 500, 502, 503, 504].includes(error.status);
  return error instanceof TypeError || error?.code === 'NETWORK_ERROR';
}
export function retryDelayMs(attempt) { return Math.min(8000, 500 * 2 ** Math.max(0, attempt)); }
export function abortableDelay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new DownloadError('CANCELLED', 'Загрузка отменена.')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
