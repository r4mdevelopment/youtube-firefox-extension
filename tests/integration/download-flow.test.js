import { createJobContextProxy } from '../../src/common/job-context.js';
import { expect, it, vi } from 'vitest';
import { createBackgroundController } from '../../src/background/controller.js';
import { pageEnvelope } from '../fixtures/page.js';
import adaptive from '../fixtures/adaptive-1080.json';
const extensionId = 'test@local'; const popupUrl = 'moz-extension://local/popup/popup.html';
const content = { id: extensionId, frameId: 0, tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
const popup = { id: extensionId, url: popupUrl };
async function setup(raw, dependencies = {}) {
  const saves = []; const fetches = []; const muxes = [];
  const controller = createBackgroundController({ extensionId, popupUrl,
    downloadStream: async options => { fetches.push(options); return { blob: new Blob(['media']), bytesReceived: 5 }; },
    mux: async options => { muxes.push(options); return new Blob(['muxed'], { type: 'video/mp4' }); },
    save: async options => { saves.push(options); return 3; }, refreshMetadata: async () => pageEnvelope(), ...dependencies,
  });
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'abcdefghijk', generation: 1 } }, content);
  const envelope = pageEnvelope(); if (raw) envelope.payload = { ...envelope.payload, ...raw };
  await controller.handle({ type: 'VIDEO_METADATA', payload: envelope }, content);
  return { controller, saves, fetches, muxes };
}
const view = controller => controller.handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: 1 } }, popup);
it('explains SABR-only playback without attributing it to protected content', async () => {
  const { controller } = await setup({ transport: 'SABR', formats: [], adaptiveFormats: [] });
  const current = await view(controller);
  expect(current.choices).toEqual([]);
  expect(current.unavailableReason).toContain('SABR');
  expect(current.unavailableReason).toContain('H.264/AAC');
});
it('attaches an in-memory SABR session only to an authorized job and keeps public choices free of proof', async () => {
  let received;
  const raw={...adaptive,transport:'SABR',adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))};
  const {controller}=await setup(raw,{getSabrSession:async()=>({url:'https://r1.googlevideo.com/videoplayback',poToken:'private proof'}),managerFactory:()=>({subscribe(){},list:()=>[],start:async c=>{received=c;return 'job';}})});
  const current=await view(controller);expect(JSON.stringify(current)).not.toContain('private proof');
  await start(controller);expect(received.transport).toBe('SABR');expect(received.sabrSession.poToken).toBe('private proof');expect(received.duration).toBeGreaterThan(0);
});
async function start(controller) {
  const current = await view(controller);
  return controller.handle({ type: 'START_DOWNLOAD', payload: { tabId: 1, choiceId: current.choices[0].id, videoId: current.videoId, generation: current.generation } }, popup);
}
it('rejects navigation while awaiting a SABR session', async () => {
  let release;const held=new Promise(r=>{release=r;});const begin=vi.fn();
  const raw={...adaptive,transport:'SABR',adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))};
  const {controller}=await setup(raw,{getSabrSession:()=>held,managerFactory:()=>({subscribe(){},list:()=>[],start:begin})});
  const pending=start(controller);await Promise.resolve();await Promise.resolve();
  await controller.handle({type:'VIDEO_CHANGED',payload:{videoId:'lmnopqrstuv',generation:2}},content);
  release({url:'https://r1.googlevideo.com/videoplayback'});
  await expect(pending).rejects.toMatchObject({code:'STALE_VIDEO'});expect(begin).not.toHaveBeenCalled();
});
async function completed(controller) {
  await vi.waitFor(async () => expect((await view(controller)).activeJob?.state).toBe('complete'));
}
it('connects extracted progressive choice through manager to browser save', async () => {
  const { controller, saves, fetches } = await setup();
  const current = await view(controller);
  expect(current.choices[0].video).toBeUndefined();
  expect(JSON.stringify(current)).not.toContain('googlevideo');
  await start(controller); await completed(controller);
  expect(saves).toHaveLength(1); expect(saves[0].filename).toBe('Видео пример.mp4'); expect(fetches).toHaveLength(1);
});
it('downloads two adaptive tracks and remuxes and saves exactly once', async () => {
  const { controller, saves, fetches, muxes } = await setup(adaptive);
  await start(controller); await completed(controller);
  expect(fetches).toHaveLength(2); expect(muxes).toHaveLength(1); expect(saves).toHaveLength(1);
});
it('exposes permanent error with code and human message', async () => {
  const { controller, saves } = await setup(null, { downloadStream: async () => { throw { code: 'HTTP_ERROR', message: 'HTTP 404' }; } });
  await start(controller);
  await vi.waitFor(async () => expect((await view(controller)).activeJob?.state).toBe('failed'));
  expect((await view(controller)).activeJob.error).toEqual({ code: 'HTTP_ERROR', message: 'HTTP 404' }); expect(saves).toHaveLength(0);
});
it('deduplicates double click and cancels without saving', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const { controller, saves } = await setup(null, { downloadStream: async () => { await held; return { blob: new Blob(['media']) }; } });
  const first = await start(controller); const second = await start(controller);
  expect(second.jobId).toBe(first.jobId);
  await controller.handle({ type: 'CANCEL_DOWNLOAD', payload: { tabId: 1, jobId: first.jobId } }, popup);
  release(); await Promise.resolve();
  expect((await view(controller)).activeJob.state).toBe('cancelled'); expect(saves).toHaveLength(0);
});
it('denies privileged commands originating from page/content context', async () => {
  const { controller, fetches } = await setup();
  await expect(controller.handle({ type: 'START_DOWNLOAD', payload: { tabId: 1, choiceId: '18:progressive' } }, content)).rejects.toMatchObject({ code: 'UNAUTHORIZED_MESSAGE' });
  expect(fetches).toHaveLength(0);
});
it('rejects stale popup selection instead of downloading a different video', async () => {
  const { controller, fetches } = await setup(); const old = await view(controller);
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'lmnopqrstuv', generation: 2 } }, content);
  await expect(controller.handle({ type: 'START_DOWNLOAD', payload: { tabId: 1, choiceId: old.choices[0].id, videoId: old.videoId, generation: old.generation } }, popup)).rejects.toMatchObject({ code: 'STALE_VIDEO' });
  expect(fetches).toHaveLength(0);
});
it('keeps metadata isolated between tabs and rejects unknown choices', async () => {
  const { controller } = await setup();
  expect((await controller.handle({ type: 'GET_CURRENT_VIDEO', payload: { tabId: 2 } }, popup)).choices).toEqual([]);
  await expect(controller.handle({ type: 'START_DOWNLOAD', payload: { tabId: 1, choiceId: 'fake', videoId: 'abcdefghijk', generation: 1 } }, popup)).rejects.toMatchObject({ code: 'FORMAT_UNAVAILABLE' });
});
it('rejects delayed hydration within the same content document', async () => {
  const { controller } = await setup();
  const doc = { ...content, documentId: 'actual-browser-document' };
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'abcdefghijk', generation: 1, documentToken: 'token-1' } }, doc);
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'lmnopqrstuv', generation: 2, documentToken: 'token-1' } }, doc);
  const hydrate = { ...content, documentId: undefined };
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'abcdefghijk', generation: 1, documentToken: 'token-1' } }, hydrate);
  await controller.handle({ type: 'VIDEO_METADATA', payload: { ...pageEnvelope(), documentToken: 'token-1' } }, hydrate);
  expect((await view(controller)).videoId).toBe('lmnopqrstuv');
  expect((await view(controller)).choices).toEqual([]);
});
it('rejects retired document metadata after a full page reload', async () => {
  const { controller } = await setup();
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'abcdefghijk', generation: 1, documentToken: 'old-document' } }, content);
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'lmnopqrstuv', generation: 1, documentToken: 'new-document' } }, content);
  await controller.handle({ type: 'VIDEO_CHANGED', payload: { videoId: 'abcdefghijk', generation: 2, documentToken: 'old-document' } }, content);
  expect((await view(controller)).videoId).toBe('lmnopqrstuv');
});

it('does not show a completed previous-video job after SPA navigation',async()=>{
 const {controller}=await setup();const result=await start(controller);await vi.waitFor(()=>expect(controller.manager.get(result.jobId).state).toBe('complete'));
 await controller.handle({type:'VIDEO_CHANGED',payload:{videoId:'lmnopqrstuv',generation:2}},content);
 expect((await view(controller)).activeJob).toBeNull();
});

it('starts from the YouTube inline UI using sender tab, ignoring a supplied different tab', async()=>{
 const {controller,saves}=await setup();const current=await view(controller);
 const result=await controller.handle({type:'SITE_START_DOWNLOAD',payload:{tabId:99,videoId:current.videoId,generation:current.generation,choiceId:current.choices[0].id}},content);
 await completed(controller);expect(controller.manager.get(result.jobId).tabId).toBe(1);expect(saves).toHaveLength(1);
});
it('shows safe job progress on an ordinary site and cancels an existing job from its widget',async()=>{
 let release;const held=new Promise(r=>{release=r;});const {controller,saves}=await setup(null,{downloadStream:async()=>{await held;return {blob:new Blob(['media'])};}});
 const job=await start(controller);const site={id:extensionId,frameId:0,tab:{id:9},url:'https://example.org/'};
 const status=await controller.handle({type:'GET_SITE_VIEW'},site);expect(status.video).toBeNull();expect(status.jobs).toEqual([expect.objectContaining({id:job.jobId,title:'Видео / пример',state:'downloading'})]);expect(JSON.stringify(status)).not.toMatch(/googlevideo|sabrSession|poToken/);
 await controller.handle({type:'SITE_CANCEL_DOWNLOAD',payload:{jobId:job.jobId}},site);release();expect(controller.manager.get(job.jobId).state).toBe('cancelled');expect(saves).toHaveLength(0);
});
it('denies inline starts outside YouTube and widget commands from frames or foreign extensions',async()=>{
 const {controller}=await setup();const site={id:extensionId,frameId:0,tab:{id:9},url:'https://example.org/'};
 for(const sender of [{...site,id:'foreign'},{...site,frameId:2},{...site,url:'file:///secret'}])await expect(controller.handle({type:'GET_SITE_VIEW'},sender)).rejects.toMatchObject({code:'UNAUTHORIZED_MESSAGE'});
 await expect(controller.handle({type:'SITE_START_DOWNLOAD',payload:{}},site)).rejects.toMatchObject({code:'UNAUTHORIZED_MESSAGE'});
});

it('shares widget dismissal between tabs and expires completion three seconds after the last job settles',async()=>{
 let clock=100;let release;const held=new Promise(r=>{release=r;});const {controller}=await setup(null,{now:()=>clock,downloadStream:async()=>{await held;return {blob:new Blob(['media'])};}});
 const site={id:extensionId,frameId:0,tab:{id:9},url:'https://example.org/'};const other={...site,tab:{id:10}};const read=sender=>controller.handle({type:'GET_SITE_VIEW'},sender);
 const first=await start(controller);clock=10000;expect((await read(site)).jobs).toHaveLength(1);
 release();await completed(controller);clock=12999;expect((await read(other)).jobs).toHaveLength(1);clock=13000;expect((await read(other)).jobs).toHaveLength(0);
 const second=await start(controller);await completed(controller);expect((await read(site)).jobs).toHaveLength(1);
 await controller.handle({type:'SITE_HIDE_WIDGET'},site);expect((await read(other)).jobs).toHaveLength(0);
 const third=await start(controller);await completed(controller);expect((await read(other)).jobs[0].id).toBe(third.jobId);
 await controller.handle({type:'SITE_DISMISS_JOB',payload:{jobId:third.jobId}},site);expect((await read(other)).jobs).toHaveLength(0);
});

it('keeps hydrated MV3 active jobs visible while preserving explicit global closure',async()=>{
 const active={id:'running',title:'Running',state:'downloading',progress:{},tabId:1};const proxy=createJobContextProxy({initialJobs:[active],send:async()=>({jobs:[active]}),openRunner:async()=>{}});
 const controller=createBackgroundController({extensionId,popupUrl,initialJobs:[active],managerFactory:()=>proxy});const site={id:extensionId,frameId:0,tab:{id:9},url:'https://example.org/'};
 await proxy.hydrate();expect((await controller.handle({type:'GET_SITE_VIEW'},site)).jobs).toEqual([expect.objectContaining({id:'running',state:'downloading'})]);
 await controller.handle({type:'SITE_HIDE_WIDGET'},site);await proxy.hydrate();expect((await controller.handle({type:'GET_SITE_VIEW'},site)).jobs).toHaveLength(0);
});
it('starts the three-second grace period only after all parallel jobs finish',async()=>{
 let clock=0;const releases=[];const {controller}=await setup(null,{now:()=>clock,downloadStream:()=>new Promise(r=>releases.push(()=>r({blob:new Blob(['media'])})))});
 const first=await start(controller);const tab2={...content,tab:{id:2}};await controller.handle({type:'VIDEO_CHANGED',payload:{videoId:'abcdefghijk',generation:1}},tab2);await controller.handle({type:'VIDEO_METADATA',payload:pageEnvelope()},tab2);
 const c=await view(controller);const second=await controller.handle({type:'START_DOWNLOAD',payload:{tabId:2,videoId:c.videoId,generation:c.generation,choiceId:c.choices[0].id}},popup);
 clock=10000;releases[0]();await vi.waitFor(()=>expect(controller.manager.get(first.jobId).state).toBe('complete'));clock=50000;
 const read=()=>controller.handle({type:'GET_SITE_VIEW'},content);expect((await read()).jobs).toHaveLength(2);
 releases[1]();await vi.waitFor(()=>expect(controller.manager.get(second.jobId).state).toBe('complete'));clock=52999;expect((await read()).jobs).toHaveLength(2);clock=53000;expect((await read()).jobs).toHaveLength(0);
});
