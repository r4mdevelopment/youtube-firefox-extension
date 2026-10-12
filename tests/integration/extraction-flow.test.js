import { expect, it } from 'vitest';
import { forwardPageMessage } from '../../src/content/content.js';
import { collectPlayerMetadata } from '../../src/content/page-bridge.js';
import { parsePageMessage } from '../../src/common/messages.js';
import { pageEnvelope, videoId } from '../fixtures/page.js';
it('passes MAIN-world metadata through isolated validation to runtime', async () => {
  const player = { videoDetails: { videoId, title: 'Видео / пример', lengthSeconds: '12' }, streamingData: pageEnvelope().payload };
  const envelope = collectPlayerMetadata(player, { videoId, generation: 1 });
  const sent = [];
  await forwardPageMessage(envelope, message => sent.push(message));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: 'VIDEO_METADATA', payload: { videoId, generation: 1, payload: { title: 'Видео / пример', duration: 12 } } });
  expect(sent[0].payload.payload.formats[0].itag).toBe(18);
  expect(sent[0].payload.payload.tracking).toBeUndefined();
});
it('never forwards a forged save command from the page', async () => {
  const sent = [];
  await forwardPageMessage({ type: 'START_DOWNLOAD', payload: {} }, message => sent.push(message));
  expect(sent).toEqual([]);
});
it('reports SABR-only transport without exposing its playback URL', () => {
  const player = { videoDetails: { videoId, title: 'SABR video', lengthSeconds: '12' },
    streamingData: { serverAbrStreamingUrl: 'https://r1.googlevideo.com/private', adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"' }] } };
  const envelope = collectPlayerMetadata(player, { videoId, generation: 1 });
  expect(envelope.payload.transport).toBe('SABR');
  expect(JSON.stringify(envelope)).not.toContain('/private');
  const forwarded = parsePageMessage(envelope);
  expect(forwarded.payload.transport).toBe('SABR');
});
it('drops delayed A metadata after B navigation', async () => {
  const sent = [];
  const current = () => ({ videoId: 'lmnopqrstuv', generation: 2 });
  expect(await forwardPageMessage(pageEnvelope(), message => sent.push(message), current)).toBe(false);
  const next = pageEnvelope(); next.videoId = 'lmnopqrstuv'; next.generation = 2;
  expect(await forwardPageMessage(next, message => sent.push(message), current)).toBe(true);
  expect(sent.map(m => m.payload.videoId)).toEqual(['lmnopqrstuv']);
});
