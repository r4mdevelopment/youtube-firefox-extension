import { expect, it, vi } from 'vitest';
import { VideoPlaybackAbrRequest, StreamerContext } from 'googlevideo/protos';
it('returns a resolved SABR session to the MV3 runner during refresh',async()=>{
 let listener,observe;const id='test@local';const base='moz-extension://test/';
 const api={runtime:{id,getManifest:()=>({manifest_version:3}),getURL:path=>base+path,onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async()=>({})},
 storage:{local:{get:async()=>({jobs:[]}),set:async()=>{}}},tabs:{onRemoved:{addListener(){}},sendMessage:async()=>({state:{videoId:'abcdefghijk'},metadata:{payload:{sabrConfig:'AQID'}}})},
 webRequest:{onBeforeRequest:{addListener:fn=>{observe=fn;}}}};
 vi.stubGlobal('browser',api);vi.resetModules();
 try{
  await import('../../src/background/background.js');
  const send=(message,sender)=>new Promise(resolve=>{if(listener(message,sender,resolve)===false)resolve({ignored:true});});
  await send({type:'VIDEO_CHANGED',payload:{videoId:'abcdefghijk',generation:1}},{id,frameId:0,tab:{id:7},url:'https://www.youtube.com/watch?v=abcdefghijk'});
  const body=VideoPlaybackAbrRequest.encode({...VideoPlaybackAbrRequest.decode(new Uint8Array()),videoPlaybackUstreamerConfig:new Uint8Array([1,2,3]),streamerContext:{...StreamerContext.decode(new Uint8Array()),clientInfo:{clientName:1}}}).finish();
  observe({tabId:7,method:'POST',url:'https://r1.googlevideo.com/videoplayback',originUrl:'https://www.youtube.com/watch?v=abcdefghijk',requestBody:{raw:[{bytes:body.buffer}]}});
  const runner={id,url:base+'offscreen/offscreen.html'};
  await send({type:'JOB_UPDATED',payload:{id:'running',videoId:'abcdefghijk',tabId:7,state:'downloading'}},runner);
  const result=await send({type:'GET_SABR_SESSION',payload:{videoId:'abcdefghijk',tabId:7}},runner);
  expect(result.error).toBeUndefined();expect(result.session).toMatchObject({videoPlaybackUstreamerConfig:'AQID'});expect(()=>structuredClone(result)).not.toThrow();
 }finally{vi.unstubAllGlobals();vi.resetModules();}
});

async function saveHarness() {
 let listener; const id = 'test'; const base = 'chrome-extension://test/'; let options; let cancelled;
 const api = { runtime: { id, getManifest: () => ({manifest_version:3}), getURL: p => base+p, onMessage: {addListener: fn => {listener=fn;}}, sendMessage: async () => ({}) },
 storage: {local: {get: async () => ({jobs:[]}), set: async () => {}}}, tabs: {onRemoved:{addListener(){}}}, webRequest:{onBeforeRequest:{addListener(){}}},
 downloads: {download: async value => {options=value; return 11;}, search: async () => [{id:11,url:options?.url,state:'complete'}], cancel: async value => {cancelled=value;}} };
 vi.stubGlobal('browser',api); vi.resetModules(); await import('../../src/background/background.js');
 return { api, send: (message,sender={id,url:base+'offscreen/offscreen.html'}) => new Promise(resolve=>listener(message,sender,resolve)), getOptions:()=>options, getCancelled:()=>cancelled };
}
it('saves an offscreen-owned blob through background downloads and reports browser completion', async () => {
 try {
  const h=await saveHarness(); const url='blob:chrome-extension://test/media';
  expect(await h.send({type:'SAVE_BLOB',payload:{url,filename:'тест.mp4',saveAs:false}})).toEqual({downloadId:11});
  expect(h.getOptions()).toMatchObject({url,filename:'тест.mp4',saveAs:false});
  expect(await h.send({type:'SAVE_STATUS',payload:{downloadId:11}})).toEqual({state:'complete'});
  expect(await h.send({type:'CANCEL_SAVE',payload:{downloadId:11}})).toEqual({cancelled:true}); expect(h.getCancelled()).toBe(11);
 } finally {vi.unstubAllGlobals();vi.resetModules();}
});
it('rejects save requests from tabs, popup and foreign blob origins', async () => {
 try {
  const h=await saveHarness();const message={type:'SAVE_BLOB',payload:{url:'blob:chrome-extension://test/media',filename:'test.mp4'}};
  for(const sender of [{id:'test',url:'https://www.youtube.com/',tab:{id:1}}, {id:'test',url:'chrome-extension://test/popup/popup.html'}, {id:'other',url:'chrome-extension://test/offscreen/offscreen.html'}, {id:'test',url:'chrome-extension://test/offscreen/offscreen.html',tab:{id:1}}])
   expect((await h.send(message,sender)).error.code).toBe('UNAUTHORIZED_MESSAGE');
  expect((await h.send({...message,payload:{...message.payload,url:'https://example.com/file'}})).error.code).toBe('INVALID_MESSAGE');
  expect(h.getOptions()).toBeUndefined();
 } finally {vi.unstubAllGlobals();vi.resetModules();}
});

it('recovers a validated page-held capture after the service worker restarts', async()=>{
 let listener,observe,cached;const id='test@local',base='chrome-extension://test/';
 const api={runtime:{id,getManifest:()=>({manifest_version:3}),getURL:path=>base+path,onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async()=>({})},
 storage:{local:{get:async()=>({jobs:[]}),set:async()=>{}}},tabs:{onRemoved:{addListener(){}},sendMessage:async(_tab,message)=>{
  if(message.type==='CACHE_PLAYBACK_REQUEST'){cached=message.payload;return {cached:true};}
  if(message.type==='GET_PLAYBACK_REQUEST')return {request:cached?.config===message.payload.config?cached.request:null};
  return {state:{videoId:'abcdefghijk'},metadata:{payload:{sabrConfig:'AQID'}}};
 }},webRequest:{onBeforeRequest:{addListener:fn=>{observe=fn;}}}};
 vi.stubGlobal('browser',api);vi.resetModules();
 try{
  await import('../../src/background/background.js');
  const bytes=VideoPlaybackAbrRequest.encode({...VideoPlaybackAbrRequest.decode(new Uint8Array()),videoPlaybackUstreamerConfig:new Uint8Array([1,2,3]),streamerContext:{...StreamerContext.decode(new Uint8Array()),clientInfo:{clientName:1}}}).finish();
  observe({tabId:7,method:'POST',url:'https://r1.googlevideo.com/videoplayback',initiator:'https://www.youtube.com',requestBody:{raw:[{bytes:bytes.buffer}]}});
  await vi.waitFor(()=>expect(cached).toBeDefined());
  vi.resetModules();await import('../../src/background/background.js');
  const send=(message,sender)=>new Promise(resolve=>{if(listener(message,sender,resolve)===false)resolve({ignored:true});});
  const runner={id,url:base+'offscreen/offscreen.html'};
  await send({type:'JOB_UPDATED',payload:{id:'running',videoId:'abcdefghijk',tabId:7,state:'downloading'}},runner);
  const result=await send({type:'GET_SABR_SESSION',payload:{videoId:'abcdefghijk',tabId:7}},runner);
  expect(result.error).toBeUndefined();expect(result.session).toMatchObject({videoPlaybackUstreamerConfig:'AQID'});
 }finally{vi.unstubAllGlobals();vi.resetModules();}
});
