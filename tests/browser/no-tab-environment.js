// Test-only environment: local media replaces the network; production job code is unchanged.
const originalFetch = globalThis.fetch.bind(globalThis);
const originalSend = browser.tabs.sendMessage.bind(browser.tabs);
const originalDownload = browser.downloads.download.bind(browser.downloads);
const stats = {createdTabs:0, backgroundPath:location.pathname, requests:0, mode:'complete'};
let parallelReleased=false;const waiting=[];
const realCreate = browser.tabs.create.bind(browser.tabs);
browser.tabs.create = options => { stats.createdTabs++; return realCreate(options); };
browser.downloads.download = options => originalDownload({...options,saveAs:false});
const read = async name => (await originalFetch(browser.runtime.getURL('probe/'+name))).blob();
const media = Promise.all([read('background-video.mp4'),read('background-audio.mp4')]);
globalThis.fetch = async (url,options) => {
  if (!String(url).startsWith('https://r1.googlevideo.com/videoplayback?id=fixture-')) return originalFetch(url,options);
  stats.requests++;
  if(stats.mode==='parallel'&&!parallelReleased) await new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Cancelled','AbortError'));
    options.signal.addEventListener('abort',abort,{once:true});
    waiting.push(()=>{options.signal.removeEventListener('abort',abort);resolve();});
  });
  if(stats.mode==='cancel') await new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Cancelled','AbortError'));
    if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  });
  await new Promise(resolve=>setTimeout(resolve,500)); // Leave time to close the real popup during download.
  const blobs=await media;const blob=blobs[String(url).endsWith('audio')?1:0];
  return new Response(blob,{headers:{'content-type':'video/mp4','content-length':String(blob.size)}});
};
browser.tabs.sendMessage = async (tabId,message,...args) => {
  if(!['GET_CURRENT_METADATA','REFRESH_STREAMS'].includes(message.type))return originalSend(tabId,message,...args);
  const [video,audio]=await media;
  const metadata={type:'YTDL_PAGE_BRIDGE_MESSAGE',videoId:'abcdefghijk',generation:1,documentToken:'fixture-document',payload:{title:'Без вкладки Firefox',duration:20,status:'OK',transport:'DIRECT',formats:[],adaptiveFormats:[
    {itag:137,url:'https://r1.googlevideo.com/videoplayback?id=fixture-video',mimeType:'video/mp4; codecs="avc1.640028"',height:1080,fps:30,contentLength:String(video.size)},
    {itag:140,url:'https://r1.googlevideo.com/videoplayback?id=fixture-audio',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:64000,contentLength:String(audio.size)}]}};
  return message.type==='REFRESH_STREAMS'?metadata:{state:{videoId:'abcdefghijk',generation:1,documentToken:'fixture-document'},metadata};
};
globalThis.noTabProbe={stats,releaseParallel(){parallelReleased=true;for(const resume of waiting.splice(0))resume();},setMode(mode){stats.mode=mode;},async inspect(){
  const {jobs=[]}=await browser.storage.local.get('jobs');
  const downloads=await browser.downloads.search({});
  const tabs=await browser.tabs.query({});
  return {stats,jobs,downloads:downloads.map(d=>({id:d.id,state:d.state,filename:d.filename,bytes:d.fileSize})),tabs:tabs.map(t=>({id:t.id,url:t.url})),persistent:browser.runtime.getManifest().background.persistent};
}};
