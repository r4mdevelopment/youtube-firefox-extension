import { expect, it } from 'vitest';
import { VideoPlaybackAbrRequest, StreamerContext } from 'googlevideo/protos';
import { createSabrSessionStore } from '../../src/youtube/sabr-session.js';
const body = () => VideoPlaybackAbrRequest.encode({...VideoPlaybackAbrRequest.decode(new Uint8Array()),videoPlaybackUstreamerConfig:new Uint8Array([1,2,3]),streamerContext:{...StreamerContext.decode(new Uint8Array()),clientInfo:{clientName:1,clientVersion:'test'},poToken:new Uint8Array([4,5])}}).finish();
const details = () => ({tabId:7,method:'POST',url:'https://r1.googlevideo.com/videoplayback?sabr=1',originUrl:'https://www.youtube.com/watch?v=abcdefghijk',requestBody:{raw:[{bytes:body().buffer}]}});
it('captures only playback session data, isolated by tab and current video', () => {
  const store=createSabrSessionStore(); store.setVideo(7,'abcdefghijk');
  expect(store.observe(details())).toBe(true);
  expect(store.get(7,'abcdefghijk')).toMatchObject({url:details().url,clientInfo:{clientName:1},poToken:'BAU='});
  expect(store.get(8,'abcdefghijk')).toBeNull();
  store.setVideo(7,'lmnopqrstuv'); expect(store.get(7,'lmnopqrstuv')).toBeNull();
});
it.each([
  d=>{d.url='https://evil.test/videoplayback';},d=>{d.originUrl='https://evil.test/';},d=>{d.method='GET';},
  d=>{d.tabId=-1;},d=>{d.requestBody={raw:[{bytes:new Uint8Array(262145).buffer}]};},d=>{d.requestBody={raw:[{bytes:new Uint8Array([255]).buffer}]};},
])('rejects hostile/malformed capture %#', mutate=>{const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');const d=details();mutate(d);expect(store.observe(d)).toBe(false);});
it('expires sessions and clears closed tabs', () => {
  let now=0; const store=createSabrSessionStore({now:()=>now});store.setVideo(7,'abcdefghijk');store.observe(details());
  now=600001;expect(store.get(7,'abcdefghijk')).toBeNull();
  now=0;store.observe(details());store.forgetTab(7);expect(store.get(7,'abcdefghijk')).toBeNull();
});
it('binds an early capture on first metadata but clears it on subsequent navigation', () => {
  const store=createSabrSessionStore();expect(store.observe(details())).toBe(true);
  store.setVideo(7,'abcdefghijk');expect(store.get(7,'abcdefghijk')).not.toBeNull();
  store.setVideo(7,'lmnopqrstuv');expect(store.get(7,'lmnopqrstuv')).toBeNull();
});
it('does not relabel a delayed request from the previous video', () => {
  const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');store.setVideo(7,'lmnopqrstuv');
  expect(store.observe(details())).toBe(true);expect(store.get(7,'lmnopqrstuv')).toBeNull();
});
it('holds an early next-video capture separately until navigation accepts its identity', () => {
  const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');store.observe(details());
  const next=details();next.originUrl='https://www.youtube.com/watch?v=lmnopqrstuv';
  expect(store.observe(next)).toBe(true);expect(store.get(7,'lmnopqrstuv')).toBeNull();expect(store.get(7,'abcdefghijk')).not.toBeNull();
  store.setVideo(7,'lmnopqrstuv');expect(store.get(7,'lmnopqrstuv')).not.toBeNull();
  expect(store.observe(details())).toBe(true);expect(store.get(7,'lmnopqrstuv')).not.toBeNull();
});

it('matches a new SPA video by player config when request documentUrl still names the old video',()=>{
 const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');store.observe(details());store.setVideo(7,'lmnopqrstuv');
 const next=details();const request=VideoPlaybackAbrRequest.decode(body());request.videoPlaybackUstreamerConfig=new Uint8Array([9,8,7]);next.documentUrl=details().originUrl;next.requestBody={raw:[{bytes:VideoPlaybackAbrRequest.encode(request).finish().buffer}]};
 store.observe(next);store.observe(details());
 expect(store.get(7,'lmnopqrstuv','CQgH')).not.toBeNull();expect(store.get(7,'lmnopqrstuv','wrong')).toBeNull();expect(store.get(8,'lmnopqrstuv','CQgH')).toBeNull();
});

it.each(['/w==','/w','_w==','_w'])('matches equivalent Base64 player config %s', config=>{
 const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');const d=details();const request=VideoPlaybackAbrRequest.decode(body());request.videoPlaybackUstreamerConfig=new Uint8Array([255]);d.requestBody={raw:[{bytes:VideoPlaybackAbrRequest.encode(request).finish().buffer}]};store.observe(d);
 expect(store.get(7,'abcdefghijk',config)?.videoPlaybackUstreamerConfig).toBe('/w==');
});

it.each(['youtube.com', 'www.youtube.com'])('captures playback from %s', host => {
 const store=createSabrSessionStore();store.setVideo(7,'abcdefghijk');
 const d=details();d.originUrl=`https://${host}/watch?v=abcdefghijk`;
 expect(store.observe(d)).toBe(true);expect(store.get(7,'abcdefghijk')).not.toBeNull();
});
