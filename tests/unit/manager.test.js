import { expect, it, vi } from 'vitest';
import { createDownloadManager } from '../../src/download/manager.js';
import { createStreamRefresher } from '../../src/youtube/stream-refresh.js';
import { normalizeRepresentations } from '../../src/youtube/extractor.js';
import { buildDownloadChoices } from '../../src/youtube/formats.js';
import progressive from '../fixtures/progressive-mp4.json';
import adaptive from '../fixtures/adaptive-1080.json';
const choice = (raw = progressive) => ({ ...buildDownloadChoices(normalizeRepresentations(raw))[0], videoId: 'abcdefghijk', title: 'Пример / тест' });
const data = () => ({ blob: new Blob(['media']), bytesReceived: 5 });
const defaults = () => ({ downloadStream: async () => data(), mux: async () => new Blob(['muxed'], { type: 'video/mp4' }), save: async () => 42, refreshStreams: async () => choice() });
async function terminal(manager, id) {
  await vi.waitFor(() => expect(['complete', 'failed', 'cancelled']).toContain(manager.get(id).state));
  return manager.get(id);
}
it('runs SABR tracks together through the existing mux and save states without persisting proof', async () => {
  const downloadStream=vi.fn();const downloadSabr=vi.fn(async()=>({video:data(),audio:data()}));const save=vi.fn(async()=>42);
  const manager=createDownloadManager({...defaults(),downloadStream,downloadSabr,save});
  const sabr={...choice(adaptive),transport:'SABR',sabrSession:{poToken:'private proof'}};
  const id=await manager.start(sabr);expect((await terminal(manager,id)).state).toBe('complete');
  expect(downloadStream).not.toHaveBeenCalled();expect(downloadSabr).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(manager.list())).not.toContain('private proof');
});
it('does not mux or save SABR partial tracks after attestation failure', async () => {
  const mux=vi.fn();const save=vi.fn();const manager=createDownloadManager({...defaults(),mux,save,downloadSabr:async()=>{throw {code:'SABR_ATTESTATION_REQUIRED',message:'Сессия не подтверждена'};}});
  const id=await manager.start({...choice(adaptive),transport:'SABR'});
  expect((await terminal(manager,id)).error.code).toBe('SABR_ATTESTATION_REQUIRED');expect(mux).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
});
it.each([[progressive, ['queued', 'downloading', 'saving', 'complete']], [adaptive, ['queued', 'downloading', 'muxing', 'saving', 'complete']]])('follows the legal success path %#', async (raw, expected) => {
  const states = []; const saves = [];
  const manager = createDownloadManager({ ...defaults(), save: async input => { saves.push(input); return 42; } });
  manager.subscribe(job => { if (states.at(-1) !== job.state) states.push(job.state); });
  const id = await manager.start(choice(raw));
  expect((await terminal(manager, id)).state).toBe('complete'); expect(states).toEqual(expected);
  expect(saves[0].filename).toBe('Пример тест.mp4');
  manager.cancel(id); expect(manager.get(id).state).toBe('complete');
});
it('exposes retrying then returns to downloading on progress', async () => {
  const states = []; const manager = createDownloadManager({ ...defaults(), downloadStream: async options => {
    options.onRetry({ attempt: 1 }); options.onProgress({ bytesReceived: 5, expectedBytes: 5 }); return data();
  } });
  manager.subscribe(job => states.push(job.state));
  const id = await manager.start(choice()); await terminal(manager, id);
  expect(states).toContain('retrying'); expect(manager.get(id).state).toBe('complete');
});
it('refreshes expired URL once and uses refreshed stream', async () => {
  let attempts = 0; const urls = []; const refresh = vi.fn(async () => ({ ...choice(), video: { ...choice().video, url: 'https://r2.googlevideo.com/videoplayback?id=new' } }));
  const manager = createDownloadManager({ ...defaults(), refreshStreams: refresh, downloadStream: async ({ url }) => {
    urls.push(url); if (++attempts === 1) throw { code: 'URL_EXPIRED' }; return data();
  } });
  const id = await manager.start(choice()); expect((await terminal(manager, id)).state).toBe('complete');
  expect(refresh).toHaveBeenCalledTimes(1); expect(urls[1]).toContain('r2.googlevideo.com');
});
it('fails a second expired URL instead of refreshing forever', async () => {
  const refresh = vi.fn(async () => choice()); const save = vi.fn();
  const manager = createDownloadManager({ ...defaults(), save, refreshStreams: refresh, downloadStream: async () => { throw { code: 'URL_EXPIRED' }; } });
  const id = await manager.start(choice()); expect((await terminal(manager, id)).error.code).toBe('URL_EXPIRED');
  expect(refresh).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
});
it('surfaces permanent failure with a message', async () => {
  const manager = createDownloadManager({ ...defaults(), downloadStream: async () => { throw { code: 'HTTP_ERROR', message: 'HTTP 404' }; } });
  const id = await manager.start(choice()); expect((await terminal(manager, id)).error).toEqual({ code: 'HTTP_ERROR', message: 'HTTP 404' });
});
it.each(['retry', 'audio', 'mux'])('cancels during %s and never saves', async stage => {
  let entered; let release; let calls = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const save = vi.fn(); let signal;
  const manager = createDownloadManager({ ...defaults(), save,
    downloadStream: async options => {
      calls++; signal = options.signal;
      if ((stage === 'retry' && calls === 1) || (stage === 'audio' && calls === 2)) {
        if (stage === 'retry') options.onRetry({ attempt: 1 }); entered(); await held;
      }
      return data();
    }, mux: async options => { signal = options.signal; entered(); await held; return new Blob(['muxed']); },
  });
  const id = await manager.start(choice(adaptive)); await waiting;
  manager.cancel(id); expect(signal.aborted).toBe(true); release();
  await terminal(manager, id); await new Promise(resolve => setTimeout(resolve, 0));
  expect(manager.get(id).state).toBe('cancelled'); expect(save).not.toHaveBeenCalled();
});
it('deduplicates active starts and protects snapshot state', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const manager = createDownloadManager({ ...defaults(), downloadStream: async () => { await held; return data(); } });
  const id = await manager.start(choice()); expect(await manager.start(choice())).toBe(id);
  const snapshot = manager.get(id); snapshot.state = 'complete';
  expect(manager.get(id).state).toBe('downloading'); manager.cancel(id); release();
});
it('rejects refresh metadata for a different video', async () => {
  const refresh = createStreamRefresher({ requestMetadata: async () => ({ videoId: 'lmnopqrstuv', payload: progressive }) });
  await expect(refresh({ videoId: 'abcdefghijk', choiceId: choice().id })).rejects.toMatchObject({ code: 'STALE_VIDEO' });
});
it('reconstructs interrupted jobs as failed, without pretending to resume bytes', () => {
  const manager = createDownloadManager({ ...defaults(), initialJobs: [{ id: 'old', state: 'muxing', title: 'Old' }] });
  expect(manager.get('old')).toMatchObject({ state: 'failed', error: { code: 'BACKGROUND_RESTARTED' } });
});

it('runs four tab jobs independently, deduplicates only within a tab and bounds a fifth',async()=>{
 const held=new Map();const manager=createDownloadManager({...defaults(),downloadStream:async o=>{await new Promise(resolve=>held.set(o.url,resolve));return data();}});
 const pick=tabId=>({...choice(),tabId,video:{...choice().video,url:'https://r1.googlevideo.com/videoplayback?id='+tabId}});
 const ids=[];for(let tab=1;tab<=4;tab++)ids.push(await manager.start(pick(tab)));
 expect(new Set(ids).size).toBe(4);expect(await manager.start(pick(1))).toBe(ids[0]);await expect(manager.start(pick(5))).rejects.toMatchObject({code:'JOB_BUSY'});
 manager.cancel(ids[0]);for(const resolve of held.values())resolve();
 expect((await terminal(manager,ids[0])).state).toBe('cancelled');for(const id of ids.slice(1))expect((await terminal(manager,id)).state).toBe('complete');
});
