import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { UmpWriter, CompositeBuffer } from 'googlevideo/ump';
import { UMPPartId, FormatInitializationMetadata, MediaHeader, StreamProtectionStatus } from 'googlevideo/protos';
import { downloadSabr } from '../../src/download/sabr-downloader.js';
const videoId='abcdefghijk';
const choice={videoId,duration:1,video:{itag:134,lastModified:'123',mimeType:'video/mp4; codecs="avc1.4d401e"',height:360,bitrate:50000},
  audio:{itag:140,lastModified:'123',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:20000},
  sabrSession:{url:'https://r1.googlevideo.com/videoplayback?sabr=1',videoPlaybackUstreamerConfig:'AQID',clientInfo:{clientName:1,clientVersion:'test'},poToken:'BAU='}};
async function protocol({wrongVideo=false,protection=false,repeat=false}={}) {
  const buffer=new CompositeBuffer();const writer=new UmpWriter(buffer);
  if(protection){writer.write(UMPPartId.STREAM_PROTECTION_STATUS,StreamProtectionStatus.encode({status:3}).finish());}
  else for(const [itag,mimeType,name,index] of [[134,'video/mp4','video-only.mp4',0],[140,'audio/mp4','audio-only.mp4',2]]){
    const formatId={itag,lastModified:'123',xtags:''};
    const bytes=new Uint8Array(await readFile(new URL(`../fixtures/${name}`,import.meta.url)));
    if(!repeat)writer.write(UMPPartId.FORMAT_INITIALIZATION_METADATA,FormatInitializationMetadata.encode({videoId:wrongVideo?'lmnopqrstuv':videoId,formatId,mimeType,durationUnits:'1000',durationTimescale:'1000',endSegmentNumber:'1'}).finish());
    for(const [headerId,isInitSeg,data] of [[index,true,new Uint8Array()],[index+1,false,bytes]]){
      writer.write(UMPPartId.MEDIA_HEADER,MediaHeader.encode({headerId,videoId,itag,formatId,isInitSeg,sequenceNumber:isInitSeg?0:1,durationMs:isInitSeg?'0':'1000',startMs:'0',contentLength:String(data.length)}).finish());
      if(data.length)writer.write(UMPPartId.MEDIA,new Uint8Array([headerId,...data]));
      writer.write(UMPPartId.MEDIA_END,new Uint8Array([headerId]));
    }
  }
  const bytes = new Uint8Array(buffer.chunks.reduce((n,c)=>n+c.length,0)); let offset=0;
  for(const chunk of buffer.chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),{headers:{'content-type':'application/vnd.yt-ump'}});
}
it('downloads both real UMP tracks, reports progress, and requires server identity',async()=>{
  const progress=[];let calls=0;const fetchImpl=vi.fn(()=>protocol({repeat:++calls>1}));
  const result=await downloadSabr({choice,fetchImpl,onProgress:(phase,p)=>progress.push([phase,p.bytesReceived])});
  expect(result.video.blob.size).toBe((await readFile(new URL('../fixtures/video-only.mp4',import.meta.url))).length);
  expect(result.audio.blob.size).toBeGreaterThan(0);expect(progress.map(p=>p[0])).toContain('audio');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('rejects a stale video before returning media',async()=>{
  await expect(downloadSabr({choice,fetchImpl:()=>protocol({wrongVideo:true})})).rejects.toMatchObject({code:'STALE_VIDEO'});
});
it('turns attestation into a bounded human error without retry loops',async()=>{
  const fetchImpl=vi.fn(()=>protocol({protection:true}));
  await expect(downloadSabr({choice,fetchImpl})).rejects.toMatchObject({code:'SABR_ATTESTATION_REQUIRED',message:expect.stringContaining('скачать ролик не удалось')});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('never requests an invalid session host',async()=>{
  const fetchImpl=vi.fn();await expect(downloadSabr({choice:{...choice,sabrSession:{...choice.sabrSession,url:'https://evil.test/media'}},fetchImpl})).rejects.toMatchObject({code:'INVALID_MEDIA_URL'});
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('cancels an in-flight request without partial output',async()=>{
  const controller=new AbortController();const entered=Promise.withResolvers();
  const promise=downloadSabr({choice,signal:controller.signal,fetchImpl:(_url,{signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await entered.promise;controller.abort();await expect(promise).rejects.toMatchObject({code:'CANCELLED'});
});
it('retries a transient response with visible status, bounded by the existing policy',async()=>{
  let calls=0;const onRetry=vi.fn();
  const fetchImpl=vi.fn(()=>++calls===1?new Response('',{status:503}):protocol({repeat:calls>2}));
  const result=await downloadSabr({choice,fetchImpl,onRetry,delayImpl:async()=>{}});
  expect(result.audio.blob.size).toBeGreaterThan(0);expect(onRetry).toHaveBeenCalledWith({attempt:1});expect(calls).toBe(3);
});
it('returns an expiry error for refresh instead of retrying 403',async()=>{
  const fetchImpl=vi.fn(async()=>new Response('',{status:403}));
  await expect(downloadSabr({choice,fetchImpl})).rejects.toMatchObject({code:'URL_EXPIRED'});expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([false,true])('retries interrupted response bodies without delivering duplicate media (partial=%s)',async partial=>{
  let calls=0;const retry=vi.fn();const initial=await protocol();const prefix=new Uint8Array(await initial.arrayBuffer());
  const fetchImpl=vi.fn(()=>{
    if(++calls===1)return new Response(new ReadableStream({start(c){if(partial)c.enqueue(prefix);},pull(c){c.error(new TypeError('network disconnected'));}}),{headers:{'content-type':'application/vnd.yt-ump'}});
    return protocol({repeat:calls>2});
  });
  const result=await downloadSabr({choice,fetchImpl,onRetry:retry,delayImpl:async()=>{}});
  expect(result.video.blob.size).toBe((await readFile(new URL('../fixtures/video-only.mp4',import.meta.url))).length);
  expect(calls).toBe(3);expect(retry).toHaveBeenCalledWith({attempt:1});
});
it('bounds repeated body failures and cancels during recovery',async()=>{
  const fetchImpl=vi.fn(()=>new Response(new ReadableStream({start(c){c.error(new TypeError('offline'));}}),{headers:{'content-type':'application/vnd.yt-ump'}}));
  await expect(downloadSabr({choice,fetchImpl,delayImpl:async()=>{}})).rejects.toMatchObject({code:'SABR_NETWORK_ERROR'});
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  const controller=new AbortController();const entered=Promise.withResolvers();
  const pending=downloadSabr({choice,signal:controller.signal,fetchImpl,delayImpl:async(_ms,signal)=>{entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await entered.promise;controller.abort();await expect(pending).rejects.toMatchObject({code:'CANCELLED'});
});
it('rejects a track whose byte count differs from the advertised size',async()=>{
  let calls=0;
  await expect(downloadSabr({choice:{...choice,video:{...choice.video,expectedBytes:1}},fetchImpl:()=>protocol({repeat:++calls>1})})).rejects.toMatchObject({code:'TRUNCATED_RESPONSE'});
});

