// Test-only probe; no assets from this directory enter production builds.
import { muxMp4 } from '../../src/mux/muxer.js';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
async function packets(blob) {
  const input=new Input({source:new BlobSource(blob),formats:ALL_FORMATS});const result={};
  try {
    for(const kind of ['Video','Audio']) {
      const track=await input[`getPrimary${kind}Track`]();if(!track)continue;
      const parts=[];const times=[];
      for await(const packet of new EncodedPacketSink(track).packets()){parts.push(packet.data);times.push([packet.timestamp,packet.duration]);}
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await new Blob(parts).arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
      result[kind]={count:parts.length,hash,times};
    }
    return result;
  } finally {input.dispose();}
}
browser.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type!=='RUNNER_MUX_BENCHMARK'||sender.id!==browser.runtime.id)return false;
  const run=async()=>{
    const read=async name=>(await fetch(browser.runtime.getURL('probe/'+name))).blob();
    const videoBlob=await read('background-video.mp4');const audioBlob=await read('background-audio.mp4');
    const hiddenAtStart=document.hidden;let progressEvents=0;let visibleDuringMux=false;
    const controller=new AbortController();let cancellationChannel;
    const started=performance.now();
    try {
      const output=await muxMp4({videoBlob,audioBlob,signal:controller.signal,onProgress:()=>{
        progressEvents++;visibleDuringMux ||= !document.hidden;
        if(message.cancel&&!cancellationChannel){cancellationChannel=new MessageChannel();cancellationChannel.port1.onmessage=()=>controller.abort();cancellationChannel.port2.postMessage(null);}
      }});
      const elapsedMs=performance.now()-started;
      const original={...await packets(videoBlob),...await packets(audioBlob)};const actual=await packets(output);
      return {contextPath:location.pathname,elapsedMs,hiddenAtStart,hiddenAtEnd:document.hidden,visibleDuringMux,progressEvents,bytes:output.size,
        exactPackets:JSON.stringify(original)===JSON.stringify(actual),videoPackets:actual.Video.count,audioPackets:actual.Audio.count};
    }catch(error){return {elapsedMs:performance.now()-started,hiddenAtStart,progressEvents,error:error.code??error.message};}
    finally {cancellationChannel?.port1.close();cancellationChannel?.port2.close();}
  };
  run().then(respond,error=>respond({error:error.message}));return true;
});
