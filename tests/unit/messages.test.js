import { expect, it } from 'vitest';
import { parsePageMessage, makeExtensionMessage } from '../../src/common/messages.js';
import { pageEnvelope } from '../fixtures/page.js';
import { runInNewContext } from 'node:vm';
it('accepts plain postMessage objects from the page realm in Firefox', () => {
  const value = runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(pageEnvelope()))})`);
  expect(Object.getPrototypeOf(value)).not.toBe(Object.prototype);
  expect(parsePageMessage(value)?.payload.title).toBe('Видео / пример');
});
it('never reads inherited getters from a foreign Object.prototype', () => {
  let reads = 0;
  const value = runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(pageEnvelope()))})`);
  Object.defineProperty(Object.getPrototypeOf(value), 'transport', { get() { reads++; return 'SABR'; } });
  expect(parsePageMessage(value)?.payload.transport).toBe('DIRECT');
  expect(reads).toBe(0);
});
it('projects only serializable media fields', () => {
  const message = parsePageMessage(pageEnvelope());
  expect(message.payload.title).toBe('Видео / пример');
  expect(message.payload.formats[0].itag).toBe(18);
  expect(message.payload.tracking).toBeUndefined();
});
it.each([
  value => { delete value.videoId; },
  value => { value.type = 'START_DOWNLOAD'; },
  value => { value.generation = -1; },
  value => { value.payload.formats = {}; },
  value => { value.payload.formats = Array(501).fill(value.payload.formats[0]); },
  value => { value.payload.title = 'x'.repeat(5001); },
  value => { Object.setPrototypeOf(value.payload, { injected: true }); },
  value => { value.payload.formats[0].url = 'https://googlevideo.com.evil.test/media'; },
  value => { value.payload.formats[0].url = 'https://user:password@r1.googlevideo.com/media'; },
  value => { value.payload.formats[0].url = 'http://r1.googlevideo.com/media'; },
  value => { value.payload.formats[0].url = 'https://r1.googlevideo.com:8443/media'; },
])('rejects invalid page input %#', mutate => {
  const message = pageEnvelope(); mutate(message);
  expect(parsePageMessage(message)).toBeNull();
});
it('does not invoke getters in untrusted data', () => {
  const value = pageEnvelope();
  Object.defineProperty(value.payload, 'title', { get() { throw new Error('getter invoked'); }, enumerable: true });
  expect(parsePageMessage(value)).toBeNull();
});
it('allows only known extension message types', () => {
  expect(makeExtensionMessage('VIDEO_METADATA', pageEnvelope())).toMatchObject({ type: 'VIDEO_METADATA' });
  expect(() => makeExtensionMessage('EXECUTE_CODE', {})).toThrow();
});
