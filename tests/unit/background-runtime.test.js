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
  const send=(message,sender)=>new Promise(resolve=>listener(message,sender,resolve));
  await send({type:'VIDEO_CHANGED',payload:{videoId:'abcdefghijk',generation:1}},{id,frameId:0,tab:{id:7},url:'https://www.youtube.com/watch?v=abcdefghijk'});
  const body=VideoPlaybackAbrRequest.encode({...VideoPlaybackAbrRequest.decode(new Uint8Array()),videoPlaybackUstreamerConfig:new Uint8Array([1,2,3]),streamerContext:{...StreamerContext.decode(new Uint8Array()),clientInfo:{clientName:1}}}).finish();
  observe({tabId:7,method:'POST',url:'https://r1.googlevideo.com/videoplayback',originUrl:'https://www.youtube.com/watch?v=abcdefghijk',requestBody:{raw:[{bytes:body.buffer}]}});
  const runner={id,url:base+'runner/runner.html'};
  await send({type:'JOB_UPDATED',payload:{id:'running',videoId:'abcdefghijk',tabId:7,state:'downloading'}},runner);
  const result=await send({type:'GET_SABR_SESSION',payload:{videoId:'abcdefghijk',tabId:7}},runner);
  expect(result.error).toBeUndefined();expect(result.session).toMatchObject({videoPlaybackUstreamerConfig:'AQID'});expect(()=>structuredClone(result)).not.toThrow();
 }finally{vi.unstubAllGlobals();vi.resetModules();}
});
