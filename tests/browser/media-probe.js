// Test-only extension document. Never included in either production build.
import { downloadStream } from '../../src/download/stream-downloader.js';
import { muxMp4 } from '../../src/mux/muxer.js';
import { downloadBlob } from '../../src/common/browser-api.js';

window.runMediaProbe = async () => {
  const results = [];
  const read = async name => (await fetch(browser.runtime.getURL(`probe/${name}`))).blob();
  const video = await read('video-only.mp4');
  const audio = await read('audio-only.mp4');
  let attempts = 0;
  const downloaded = await downloadStream({ url: 'https://test.googlevideo.com/video', expectedBytes: video.size,
    fetchImpl: async () => ++attempts === 1 ? new Response('', { status: 503 }) : new Response(video, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(video.size) } }), delayImpl: async () => {} });
  if (attempts !== 2 || downloaded.blob.size !== video.size) throw new Error('retry/integrity failed');
  results.push({ case: 'Firefox streaming retry and integrity (local fixture)', result: 'PASS' });
  const cancelled = new AbortController(); cancelled.abort();
  try { await muxMp4({ videoBlob: video, audioBlob: audio, signal: cancelled.signal }); throw new Error('missing cancellation'); }
  catch (e) { if (e.code !== 'CANCELLED') throw e; }
  results.push({ case: 'Firefox remux cancellation', result: 'PASS' });
  const blob = await muxMp4({ videoBlob: downloaded.blob, audioBlob: audio });
  const media = document.createElement('video'); const url = URL.createObjectURL(blob);
  try {
    media.src = url; document.body.append(media);
    await new Promise((resolve, reject) => { media.onloadedmetadata = resolve; media.onerror = () => reject(new Error('Firefox MP4 decode error'));
      setTimeout(() => reject(new Error('Firefox metadata timeout')), 10000); });
    if (!media.videoWidth || !media.videoHeight || !Number.isFinite(media.duration)) throw new Error('Invalid playback metadata');
    results.push({ case: 'Firefox reads remuxed H.264/AAC MP4', result: 'PASS', width: media.videoWidth, height: media.videoHeight, duration: media.duration });
  } finally { media.remove(); URL.revokeObjectURL(url); }
  const downloads = [];
  for (let i = 0; i < 2; i++) {
    const id = await downloadBlob({ blob, filename: 'Проверка Firefox.mp4', saveAs: false });
    const [item] = await browser.downloads.search({ id });
    downloads.push({ state: item.state, filename: item.filename, bytes: item.fileSize });
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
  results.push({ case: 'Firefox Blob save and duplicate Cyrillic filename', result: 'PASS', downloads, bytes: blob.size, sha256: digest });
  return results;
};
