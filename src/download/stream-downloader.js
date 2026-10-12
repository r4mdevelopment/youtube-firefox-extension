import { DownloadError, checkAbort } from '../common/errors.js';
import { isMediaUrl } from '../common/messages.js';
import { shouldRetry, retryDelayMs, abortableDelay } from './retry.js';

// Buffering boundary: a different sink can replace Blob assembly without changing fetch/retry.
export function createBlobSink() {
  let parts = [];
  return { write(part) { parts.push(part); },
    finish(type) { const blob = new Blob(parts, { type }); parts = []; return blob; },
    discard() { parts = []; } };
}
export async function downloadStream({ url, expectedBytes, signal, onProgress = () => {}, onRetry = () => {}, fetchImpl = fetch, delayImpl = abortableDelay, sinkFactory = createBlobSink }) {
  if (!isMediaUrl(url)) throw new DownloadError('INVALID_MEDIA_URL', 'Недопустимый адрес медиапотока.');
  let highWater = 0;
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    const sink = sinkFactory();
    let reader; let abortReader;
    try {
      const response = await fetchImpl(url, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      checkAbort(signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadError([403, 410].includes(response.status) ? 'URL_EXPIRED' : 'HTTP_ERROR', `Сервер вернул HTTP ${response.status}.`, { status: response.status });
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0];
      if (!['video/mp4', 'audio/mp4', 'application/octet-stream'].includes(contentType) || !response.body) {
        await response.body?.cancel();
        throw new DownloadError('INVALID_MEDIA_RESPONSE', 'Сервер не вернул MP4-поток.');
      }
      const serverBytes = Number(response.headers.get('content-length')) || null;
      if (expectedBytes && serverBytes && expectedBytes !== serverBytes) {
        await response.body.cancel();
        throw new DownloadError('TRUNCATED_RESPONSE', 'Размер потока не совпадает с метаданными.');
      }
      const total = expectedBytes || serverBytes;
      reader = response.body.getReader();
      abortReader = () => { reader.cancel().catch(() => {}); };
      signal?.addEventListener('abort', abortReader, { once: true });
      let bytesReceived = 0;
      for (;;) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        bytesReceived += value.byteLength;
        if (total && bytesReceived > total) throw new DownloadError('TRUNCATED_RESPONSE', 'Размер потока превышает ожидаемый.');
        await sink.write(value);
        highWater = Math.max(highWater, bytesReceived);
        onProgress({ bytesReceived: highWater, expectedBytes: total ?? null });
      }
      if (total && bytesReceived !== total) throw new DownloadError('TRUNCATED_RESPONSE', 'Медиапоток загружен не полностью.');
      if (!bytesReceived) throw new DownloadError('EMPTY_OUTPUT', 'Получен пустой медиапоток.');
      return { blob: await sink.finish(contentType), bytesReceived, contentType };
    } catch (error) {
      await reader?.cancel().catch(() => {});
      await sink.discard();
      checkAbort(signal);
      if (!shouldRetry(error, attempt)) {
        if (error instanceof DownloadError) throw error;
        throw new DownloadError('NETWORK_EXHAUSTED', 'Не удалось загрузить поток после повторных попыток.');
      }
      onRetry({ attempt: attempt + 1, delayMs: retryDelayMs(attempt) });
      await delayImpl(retryDelayMs(attempt), signal);
    } finally {
      signal?.removeEventListener('abort', abortReader);
      reader?.releaseLock();
    }
  }
}
