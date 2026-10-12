import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Output, Mp4OutputFormat, AppendOnlyStreamTarget } from 'mediabunny';
import { DownloadError, checkAbort } from '../common/errors.js';

// A posted task lets cancellation/UI run without inactive-tab timer clamping.
function yieldToTask(signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (aborted = false) => {
      channel.port1.close(); channel.port2.close();
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(new DownloadError('CANCELLED', 'Загрузка отменена.'));
      else resolve();
    };
    const abort = () => finish(true);
    signal?.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = () => finish();
    channel.port2.postMessage(null);
  });
}

export async function muxMp4({ videoBlob, audioBlob, signal, onProgress = () => {} }) {
  checkAbort(signal);
  const inputs = []; const chunks = [];
  let output;
  try {
    const videoInput = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS }); inputs.push(videoInput);
    const audioInput = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS }); inputs.push(audioInput);
    const video = await videoInput.getPrimaryVideoTrack(); const audio = await audioInput.getPrimaryAudioTrack();
    checkAbort(signal);
    if (!video || !audio || await video.getCodec() !== 'avc' || await audio.getCodec() !== 'aac') throw new DownloadError('MUX_UNSUPPORTED_CODEC', 'Для объединения требуются H.264 и AAC.');
    const videoConfig = await video.getDecoderConfig(); const audioConfig = await audio.getDecoderConfig();
    if (!videoConfig || !audioConfig) throw new DownloadError('MUX_UNSUPPORTED_CODEC', 'Отсутствует конфигурация дорожек.');
    checkAbort(signal);
    const videoSource = new EncodedVideoPacketSource('avc'); const audioSource = new EncodedAudioPacketSource('aac');
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
      target: new AppendOnlyStreamTarget(new WritableStream({ write(chunk) { checkAbort(signal); chunks.push(new Blob([chunk])); } })) });
    output.addVideoTrack(videoSource, { rotation: await video.getRotation() }); output.addAudioTrack(audioSource);
    await output.start();
    const streams = [
      { iterator: new EncodedPacketSink(video).packets(), source: videoSource, config: videoConfig, first: true, count: 0 },
      { iterator: new EncodedPacketSink(audio).packets(), source: audioSource, config: audioConfig, first: true, count: 0 },
    ];
    for (const stream of streams) stream.next = await stream.iterator.next();
    const duration = Math.max(await video.computeDuration(), await audio.computeDuration());
    let count = 0; let progress = 0; let lastProgressAt = -Infinity;
    while (streams.some(s => !s.next.done)) {
      checkAbort(signal);
      const stream = streams.filter(s => !s.next.done).sort((a, b) => a.next.value.timestamp - b.next.value.timestamp)[0];
      const packet = stream.next.value;
      await stream.source.add(packet, stream.first ? { decoderConfig: stream.config } : undefined);
      stream.first = false; stream.count++;
      progress = Math.max(progress, Math.min(0.99, (packet.timestamp + packet.duration) / duration));
      const now = performance.now();
      if (now - lastProgressAt >= 250) { onProgress(progress); lastProgressAt = now; }
      checkAbort(signal);
      stream.next = await stream.iterator.next();
      if (++count % 100 === 0) await yieldToTask(signal);
    }
    if (streams.some(s => !s.count)) throw new DownloadError('MUX_FAILED', 'Одна из дорожек не содержит медиаданных.');
    videoSource.close(); audioSource.close(); checkAbort(signal);
    await output.finalize(); checkAbort(signal);
    const result = new Blob(chunks, { type: 'video/mp4' });
    if (!result.size) throw new DownloadError('MUX_FAILED', 'Получен пустой MP4.');
    onProgress(1); checkAbort(signal); return result;
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    checkAbort(signal);
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('MUX_FAILED', 'Не удалось прочитать или объединить медиадорожки.');
  } finally {
    for (const input of inputs) input.dispose(); chunks.length = 0;
  }
}
