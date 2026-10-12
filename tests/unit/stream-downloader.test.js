import { expect, it, vi } from 'vitest';
import { downloadStream } from '../../src/download/stream-downloader.js';
const url = 'https://r1.googlevideo.com/videoplayback?id=test';
function response(parts, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(new Uint8Array(part)); controller.close();
  } }), { headers: { 'content-type': 'video/mp4', ...headers } });
}
it('accumulates progress and validates expected bytes', async () => {
  const progress = [];
  const result = await downloadStream({ url, expectedBytes: 5, fetchImpl: async () => response([[1, 2], [3, 4, 5]]), onProgress: p => progress.push(p.bytesReceived) });
  expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
  expect(progress).toEqual([2, 5]); expect(result.bytesReceived).toBe(5);
});
it('rejects a truncated body instead of accepting a partial MP4', async () => {
  await expect(downloadStream({ url, expectedBytes: 5, fetchImpl: async () => response([[1, 2]]) })).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' });
});
it('checks server content-length even without metadata', async () => {
  await expect(downloadStream({ url, fetchImpl: async () => response([[1]], { 'content-length': '3' }) })).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' });
});
it('retries transient response and exposes retry count', async () => {
  let count = 0; const retries = [];
  const result = await downloadStream({ url, delayImpl: async () => {}, onRetry: r => retries.push(r.attempt), fetchImpl: async () => ++count === 1 ? new Response(null, { status: 503 }) : response([[4]]) });
  expect(result.bytesReceived).toBe(1); expect(count).toBe(2); expect(retries).toEqual([1]);
});
it('stops after exactly three retries', async () => {
  let count = 0;
  await expect(downloadStream({ url, delayImpl: async () => {}, fetchImpl: async () => { count++; throw new TypeError('network'); } })).rejects.toMatchObject({ code: 'NETWORK_EXHAUSTED' });
  expect(count).toBe(4);
});
it('does not retry 404', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
  await expect(downloadStream({ url, fetchImpl })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 404 }); expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('classifies expiry for the job manager', async () => {
  await expect(downloadStream({ url, fetchImpl: async () => new Response(null, { status: 403 }) })).rejects.toMatchObject({ code: 'URL_EXPIRED' });
});
it('does not download from untrusted hosts', async () => {
  const fetchImpl = vi.fn();
  await expect(downloadStream({ url: 'https://evil.test/', fetchImpl })).rejects.toMatchObject({ code: 'INVALID_MEDIA_URL' }); expect(fetchImpl).not.toHaveBeenCalled();
});
it('rejects HTML and empty media output', async () => {
  await expect(downloadStream({ url, fetchImpl: async () => response([[1]], { 'content-type': 'text/html' }) })).rejects.toMatchObject({ code: 'INVALID_MEDIA_RESPONSE' });
  await expect(downloadStream({ url, fetchImpl: async () => response([]) })).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' });
});
it('propagates cancellation to fetch and interrupts body reads', async () => {
  const controller = new AbortController();
  const reading = downloadStream({ url, signal: controller.signal, fetchImpl: async (_url, options) => {
    expect(options.signal).toBe(controller.signal);
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'video/mp4' } });
  } });
  await Promise.resolve(); controller.abort();
  await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
});
