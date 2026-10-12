import { expect, it } from 'vitest';
import { normalizeRepresentations } from '../../src/youtube/extractor.js';
import { buildDownloadChoices } from '../../src/youtube/formats.js';
import { collectPlayerMetadata } from '../../src/content/page-bridge.js';
import progressive from '../fixtures/progressive-mp4.json';
import adaptive from '../fixtures/adaptive-1080.json';
import adaptive720 from '../fixtures/adaptive-720.json';
import codecs from '../fixtures/same-resolution-codecs.json';
import missing from '../fixtures/missing-audio.json';
import unavailable from '../fixtures/unavailable.json';
const choices = raw => buildDownloadChoices(normalizeRepresentations(raw));
it('keeps adaptive SABR qualities when a player also exposes a progressive direct URL', () => {
  const payload=collectPlayerMetadata({videoDetails:{videoId:'abcdefghijk',title:'Mixed',lengthSeconds:'12'},playabilityStatus:{status:'OK'},
    streamingData:{serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?sabr=1',formats:progressive.formats,
      adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))}}, {videoId:'abcdefghijk',generation:1}).payload;
  expect(payload.transport).toBe('SABR');
  expect(choices(payload)).toEqual(expect.arrayContaining([expect.objectContaining({height:1080,transport:'SABR'}),expect.objectContaining({height:360,transport:'DIRECT'})]));
});
it('preserves direct streams in a mixed SABR response without requiring SABR identifiers', () => {
  const raw={...progressive,transport:'SABR'};
  expect(choices(raw)[0]).toMatchObject({height:360,transport:'DIRECT'});
  expect(choices({...raw,formats:raw.formats.map(f=>({...f,url:'https://evil.test/media',lastModified:'123'}))})).toEqual([]);
});
it('prefers the actual SABR track over the legacy progressive URL at the same quality', () => {
  const raw={...progressive,transport:'SABR',adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123',...(f.height?{height:360,fps:30}:{})}))};
  expect(choices(raw)).toHaveLength(2);expect(choices(raw)[0]).toMatchObject({height:360,transport:'SABR',mode:'adaptive'});
  expect(choices(raw)[1]).toMatchObject({transport:'DIRECT',mode:'progressive'});
});
it('does not offer cipher-only progressive formats through the two-track SABR adapter', () => {
  const raw={...progressive,transport:'SABR',formats:progressive.formats.map(({url,...f})=>({...f,lastModified:'123',signatureCipher:'s=fixture'})),
    adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))};
  expect(choices(raw)).toHaveLength(1);expect(choices(raw)[0]).toMatchObject({height:1080,transport:'SABR',mode:'adaptive'});
});
it('never pairs a direct video URL with an audio format that only supports SABR', () => {
  const raw={...adaptive,transport:'SABR',adaptiveFormats:adaptive.adaptiveFormats.map(f=>f.height?f:(({url,...a})=>({...a,lastModified:'123'}))(f))};
  expect(choices(raw)).toEqual([]);
});
it('offers real SABR AVC/AAC formats with identifiers even without individual URLs', () => {
  const raw={...adaptive,transport:'SABR',adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))};
  expect(choices(raw)[0]).toMatchObject({height:1080,transport:'SABR',video:{itag:137,lastModified:'123'},audio:{itag:140}});
  expect(choices({...raw,transport:'DIRECT'})).toEqual([]);
  expect(choices({...raw,adaptiveFormats:raw.adaptiveFormats.map(({lastModified,...f})=>f)})).toEqual([]);
});
it('shows only actual progressive quality', () => {
  expect(choices(progressive).map(c => [c.height, c.mode, c.audio])).toEqual([[360, 'progressive', null]]);
});
it('includes genuinely available low-resolution formats without deriving height from itag', () => {
  const raw={...progressive,formats:progressive.formats.map(f=>({...f,height:240,qualityLabel:'240p'}))};
  expect(choices(raw).map(c=>c.height)).toEqual([240]);
});
it('pairs adaptive H264 with AAC and counts both sizes', () => {
  expect(choices(adaptive)[0]).toMatchObject({ height: 1080, mode: 'adaptive', videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', estimatedBytes: 300, audio: { itag: 140 }, recommended: true });
  expect(choices(adaptive720)[0].height).toBe(720);
});
it('ranks supported codecs deterministically regardless of input order', () => {
  const normal = choices(codecs);
  expect(normal).toHaveLength(1);
  expect(normal[0].videoCodec).toMatch(/^avc1/);
  expect(choices({ ...codecs, adaptiveFormats: [...codecs.adaptiveFormats].reverse() }).map(c => c.id)).toEqual(normal.map(c => c.id));
});
it('does not offer adaptive video without compatible audio', () => {
  expect(choices(missing)).toEqual([]);
  expect(choices(unavailable)).toEqual([]);
});
it('rejects cipher-only and hostile URLs without manufacturing streams', () => {
  const raw = { ...progressive, formats: progressive.formats.map(f => ({ ...f, url: 'https://evil.test/media' })) };
  expect(choices(raw)).toEqual([]);
  expect(choices({ formats: [{ itag: 18, signatureCipher: 's=secret', mimeType: 'video/mp4', height: 360 }] })).toEqual([]);
});
it('preserves unknown sizes and avoids NaN', () => {
  const raw = { ...progressive, formats: progressive.formats.map(({ contentLength, ...f }) => f) };
  expect(choices(raw)[0].estimatedBytes).toBeNull();
});
