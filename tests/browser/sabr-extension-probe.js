import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { SabrStream } from 'googlevideo/sabr-stream';
import { u8ToBase64 } from 'googlevideo/utils';
import { muxMp4 } from '../../src/mux/muxer.js';
import { downloadBlob } from '../../src/common/browser-api.js';
import { createSabrSessionStore } from '../../src/youtube/sabr-session.js';
const store = createSabrSessionStore();
const sessions = new Map();
const stats = { requests:0, decoded:0, raw:0 };
globalThis.sabrProbeStats=stats;
browser.webRequest.onBeforeRequest.addListener(details => {
  if(details.tabId < 0 || details.method !== 'POST')return;
  stats.requests++;
  store.setVideo(details.tabId,'jNQXAC9IVRw');
  stats.storeAccepted=store.observe(details);
  stats.origin=details.originUrl?new URL(details.originUrl).origin:null;
  stats.documentOrigin=details.documentUrl?new URL(details.documentUrl).origin:null;
  try {
    const parts=details.requestBody?.raw??[];
    stats.raw+=parts.length;
    const chunks=parts.filter(p=>p.bytes).map(p=>new Uint8Array(p.bytes));
    const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;
    for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    if(!bytes.length||bytes.length>262144)return;
    const r=VideoPlaybackAbrRequest.decode(bytes);
    if(!r.videoPlaybackUstreamerConfig?.length||!r.streamerContext?.clientInfo)return;
    sessions.set(details.tabId,{url:details.url,request:r});stats.decoded++;
  }catch{}
}, {urls:['https://*.googlevideo.com/videoplayback*']}, ['requestBody']);
browser.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.type!=='RUNNER_SABR_PROBE')return false;
  const run=async()=>{
    const tabs=await browser.tabs.query({url:'https://www.youtube.com/*'});const tab=tabs.at(-1);
    const session=sessions.get(tab.id);
    if(!session)return {...stats,error:'No SABR request captured'};
    const [{result:p}]=await browser.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>{
      const p=document.querySelector('#movie_player')?.getPlayerResponse?.();
      return {videoId:p.videoDetails.videoId,duration:Number(p.videoDetails.lengthSeconds)*1000,
        config:p.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
        formats:p.streamingData?.adaptiveFormats?.map(f=>({itag:f.itag,mimeType:f.mimeType,lastModified:f.lastModified,xtags:f.xtags,height:f.height,bitrate:f.bitrate,approxDurationMs:Number(f.approxDurationMs)}))};
    }});
    const counts={video:0,audio:0};const chunks={video:[],audio:[]};const statuses=[];let error;
    const ctx=session.request.streamerContext;
    stats.contextTypes=ctx.sabrContexts?.map(c=>c.type)??[];stats.cookieBytes=ctx.playbackCookie?.length??0;stats.unsentTypes=ctx.unsentSabrContexts??[];
    const stream=new SabrStream({serverAbrStreamingUrl:session.url,videoPlaybackUstreamerConfig:u8ToBase64(session.request.videoPlaybackUstreamerConfig),
      clientInfo:ctx.clientInfo,poToken:ctx.poToken?.length?u8ToBase64(ctx.poToken):undefined,formats:p.formats,durationMs:p.duration,
      fetch:async(url,opts)=>{const r=await fetch(url,{...opts,credentials:'omit'});statuses.push({status:r.status,type:r.headers.get('content-type')});return r;}});
    stream.on('error',e=>{error=e.message;});
    stream.on('streamProtectionStatusUpdate',x=>{stats.protection=x.status;});
    stream.on('formatInitialization',x=>{stats.serverVideoId=x.formatInitializationMetadata.videoId;});
    const chosen=p.formats.find(f=>f.itag===134)??p.formats.filter(f=>f.mimeType?.includes('avc1')).sort((a,b)=>a.height-b.height)[0];
    const tracks=await stream.start({videoFormat:chosen?.itag,audioFormat:140,maxRetries:0,stallDetectionMs:5000});
    const read=async(reader,key)=>{try{for(;;){const {done,value}=await reader.read();if(done)break;counts[key]+=value.length;chunks[key].push(value);
      if(!message.full&&counts.video>50000&&counts.audio>10000){stream.abort();break;}}}catch(e){error??=String(e);}};
    const timer=setTimeout(()=>stream.abort(),message.full?90000:15000);
    await Promise.all([read(tracks.videoStream.getReader(),'video'),read(tracks.audioStream.getReader(),'audio')]);clearTimeout(timer);
    let saved;
    if(message.full&&!error){const blob=await muxMp4({videoBlob:new Blob(chunks.video),audioBlob:new Blob(chunks.audio)});
      const id=await downloadBlob({blob,filename:'SABR '+chosen.height+'p sample.mp4',saveAs:false});const [item]=await browser.downloads.search({id});saved={state:item.state,bytes:item.fileSize,filename:item.filename};}
    return {...stats,sameConfig:p.config===u8ToBase64(session.request.videoPlaybackUstreamerConfig),tokenBytes:ctx.poToken?.length??0,statuses,counts,error,saved};
  };
  run().then(respond,e=>respond({...stats,error:e.message}));return true;
});
