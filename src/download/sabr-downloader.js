import { SabrStream } from 'googlevideo/sabr-stream';
import { Logger, LogLevel } from 'googlevideo/utils';
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';
import { DownloadError, checkAbort } from '../common/errors.js';
import { isMediaUrl } from '../common/messages.js';
import { createBlobSink } from './stream-downloader.js';
import { shouldRetry, retryDelayMs, abortableDelay } from './retry.js';

Logger.getInstance().setLogLevels(LogLevel.NONE);

export async function downloadSabr({ choice, signal, onProgress = () => {}, onRetry = () => {}, fetchImpl = fetch, delayImpl = abortableDelay, stallMs = 30000 }) {
  checkAbort(signal);
  const session = choice.sabrSession;
  if (!session || !isMediaUrl(session.url)) throw new DownloadError('INVALID_MEDIA_URL', 'Недопустимая сессия медиапотока.');
  const cancellation = new AbortController(); let failure; let timer; let stream;
  const sinks = { video: createBlobSink(), audio: createBlobSink() }; const identities = new Set();
  const stop = error => { failure ??= error; cancellation.abort(); stream?.abort(); };
  const abort = () => stop(new DownloadError('CANCELLED', 'Загрузка отменена.'));
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => stop(new DownloadError('SABR_TIMEOUT', 'Сервер перестал передавать медиаданные. Повторите загрузку.')), stallMs); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    stream = new SabrStream({ serverAbrStreamingUrl: session.url, videoPlaybackUstreamerConfig: session.videoPlaybackUstreamerConfig,
      clientInfo: session.clientInfo, poToken: session.poToken, durationMs: choice.duration * 1000,
      formats: [choice.video, choice.audio].map(f => ({ ...f, approxDurationMs: choice.duration * 1000 })),
      fetch: async (url, options) => {
        if (!isMediaUrl(String(url))) { const e = new DownloadError('INVALID_MEDIA_URL', 'Сервер перенаправил поток на недопустимый адрес.'); stop(e); throw e; }
        for (let attempt = 0; ; attempt++) {
          checkAbort(cancellation.signal);
          try {
            const headers = { ...options.headers }; delete headers['accept-encoding'];
            const response = await fetchImpl(url, { ...options, headers, signal: AbortSignal.any([options.signal, cancellation.signal]), credentials: 'omit', redirect: 'error' });
            if (!response.ok) { await response.body?.cancel(); throw new DownloadError([403, 410].includes(response.status) ? 'URL_EXPIRED' : 'HTTP_ERROR', `Сервер вернул HTTP ${response.status}.`, { status: response.status }); }
            // Deliver an entire UMP response atomically: a retried interrupted body
            // must not replay segments already consumed by the SDK.
            const chunks = []; let bytes = 0; const reader = response.body?.getReader();
            if (!reader) throw new DownloadError('EMPTY_OUTPUT', 'Сервер не передал медиаданные.');
            try {
              for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                checkAbort(cancellation.signal); bytes += value.byteLength; touch();
                if (bytes > 64 * 1024 * 1024) throw new DownloadError('SABR_RESPONSE_TOO_LARGE', 'Ответ медиасервера слишком велик.');
                chunks.push(new Uint8Array(value));
              }
            } catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
            return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { status: response.status, headers: response.headers });
          } catch (error) {
            if (cancellation.signal.aborted) throw failure;
            if (!shouldRetry(error, attempt)) { stop(error.code ? error : new DownloadError('SABR_NETWORK_ERROR', 'Не удалось получить медиапоток.')); throw failure; }
            onRetry({ attempt: attempt + 1 });
            await delayImpl(retryDelayMs(attempt), cancellation.signal);
          }
        }
      } });
    stream.on('formatInitialization', track => {
      const meta = track.formatInitializationMetadata;
      const expected = [choice.video, choice.audio].find(f => f.itag === meta.formatId?.itag && f.lastModified === meta.formatId.lastModified && (f.xtags ?? '') === (meta.formatId.xtags ?? ''));
      if (meta.videoId !== choice.videoId || !expected) stop(new DownloadError('STALE_VIDEO', 'Сервер вернул поток другого ролика или формата. Обновите страницу.'));
      else identities.add(expected.itag);
    });
    stream.on('streamProtectionStatusUpdate', status => {
      if (status.status === 3) stop(new DownloadError('SABR_ATTESTATION_REQUIRED', 'YouTube требует дополнительную проверку плеера. В текущей сессии скачать ролик не удалось.'));
    });
    stream.on('error', () => stop(new DownloadError('SABR_STREAM_ERROR', 'Не удалось получить полный поток SABR. Повторите загрузку после запуска видео.')));
    touch();
    const tracks = await stream.start({ videoFormat: choice.video.itag, audioFormat: choice.audio.itag, maxRetries: 0, stallDetectionMs: stallMs });
    const read = async (readable, phase) => {
      const reader = readable.getReader(); let bytesReceived = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          if (failure) throw failure; checkAbort(signal);
          if (!identities.has(choice[phase].itag)) throw new DownloadError('STALE_VIDEO', 'Не подтверждён источник медиаданных.');
          sinks[phase].write(value); bytesReceived += value.byteLength; touch();
          onProgress(phase, { bytesReceived, expectedBytes: choice[phase].expectedBytes ?? null });
        }
        return { blob: sinks[phase].finish(phase === 'video' ? 'video/mp4' : 'audio/mp4'), bytesReceived };
      } catch (error) { stop(failure ?? error); throw failure; }
      finally { reader.releaseLock(); }
    };
    const [video, audio] = await Promise.all([read(tracks.videoStream, 'video'), read(tracks.audioStream, 'audio')]);
    if (failure) throw failure;
    for (const [phase, result] of [['video', video], ['audio', audio]]) {
      if (!result.blob.size) throw new DownloadError('EMPTY_OUTPUT', 'Не получены обе дорожки ролика.');
      if (choice[phase].expectedBytes != null && result.bytesReceived !== choice[phase].expectedBytes)
        throw new DownloadError('TRUNCATED_RESPONSE', 'Размер медиадорожки не совпадает с данными YouTube.');
      const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
      try {
        const track = phase === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
        const duration = await track?.computeDuration();
        if (!track || await track.getCodec() !== (phase === 'video' ? 'avc' : 'aac') || !Number.isFinite(duration) || Math.abs(duration - choice.duration) > 2)
          throw new DownloadError('TRUNCATED_RESPONSE', 'Получен неполный или несовместимый медиапоток.');
      } finally { input.dispose(); }
    }
    checkAbort(signal); return { video, audio };
  } catch (error) {
    stop(error.code ? error : new DownloadError('SABR_STREAM_ERROR', 'Не удалось получить полный поток SABR.'));
    sinks.video.discard(); sinks.audio.discard(); throw failure;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
