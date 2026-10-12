// Isolated Brave regression: production controllers/media with local fixtures.
import { spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const youtubeHost=process.env.YOUTUBE_HOST??'www.youtube.com';assert(['youtube.com','www.youtube.com'].includes(youtubeHost));
const live=process.env.LIVE_PROBE==='1';const sample=process.env.SAMPLE_ID??'jNQXAC9IVRw';const quality=Number(process.env.QUALITY_HEIGHT)||null;assert.match(sample,/^[\w-]{11}$/);
const root=resolve('.'), out=resolve('.superpowers/brave-offscreen'+(live?'-live':'')); await mkdir(out,{recursive:true});
const extension=resolve(out,'extension'); await cp('dist/chromium',extension,{recursive:true});
const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));if(!live)manifest.content_scripts=manifest.content_scripts.filter(entry=>!entry.js.includes('content.js'));await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
const media={video:await readFile('tests/fixtures/background-video.mp4'),audio:await readFile('tests/fixtures/background-audio.mp4')};
let held=true;const pending=[];
const server=createServer((req,res)=>{
 if(req.url.startsWith('/media/')){
  const key=req.url.includes('audio')?'audio':'video'; const finish=()=>{if(res.destroyed)return;res.writeHead(200,{'content-type':key==='audio'?'audio/mp4':'video/mp4','content-length':media[key].length});res.end(media[key]);};
  if(held)pending.push(finish);else finish();
 }else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Progress fixture</title><h1>Ordinary site</h1>');}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const bgEnvironment=`
const originalSend=chrome.tabs.sendMessage.bind(chrome.tabs),originalDownload=chrome.downloads.download.bind(chrome.downloads);
chrome.downloads.download=(options,callback)=>originalDownload({...options,saveAs:false},callback);
chrome.tabs.sendMessage=(tabId,message,...args)=>{
 if(!['GET_CURRENT_METADATA','REFRESH_STREAMS'].includes(message.type))return originalSend(tabId,message,...args);
 const tabTitle='Brave без вкладки '+tabId;
 const metadata={type:'YTDL_PAGE_BRIDGE_MESSAGE',videoId:'abcdefghijk',generation:1,documentToken:'fixture-'+tabId,payload:{title:tabTitle,duration:20,status:'OK',transport:'DIRECT',formats:[],adaptiveFormats:[
 {itag:137,url:'https://r1.googlevideo.com/videoplayback?id=fixture-video',mimeType:'video/mp4; codecs="avc1.640028"',height:1080,fps:30,contentLength:'${media.video.length}'},
 {itag:140,url:'https://r1.googlevideo.com/videoplayback?id=fixture-audio',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:64000,contentLength:'${media.audio.length}'}]}};
 const value=message.type==='REFRESH_STREAMS'?metadata:{state:{videoId:'abcdefghijk',generation:1,documentToken:'fixture-'+tabId},metadata};const callback=args.at(-1);if(typeof callback==='function')queueMicrotask(()=>callback(value));else return Promise.resolve(value);
};
`;
await writeFile(resolve(extension,'background.js'),(live?`const originalDownload=chrome.downloads.download.bind(chrome.downloads);chrome.downloads.download=(options,callback)=>originalDownload({...options,saveAs:false},callback);
`:bgEnvironment)+await readFile(resolve(extension,'background.js'),'utf8'));
const screenPath=resolve(extension,'offscreen/offscreen.js');if(!live)await writeFile(screenPath,`const realFetch=fetch.bind(globalThis);globalThis.fetch=(url,options)=>realFetch(String(url).startsWith('https://r1.googlevideo.com/videoplayback?id=fixture-')?'${base}/media/'+(String(url).endsWith('audio')?'audio':'video'):url,options);\n`+await readFile(screenPath,'utf8'));
const profile=resolve(out,'profile-'+Date.now());await mkdir(profile,{recursive:true});
const browserProcess=spawn('C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--headless=new','--no-first-run','--no-default-browser-check','--disable-brave-update','--autoplay-policy=no-user-gesture-required',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';browserProcess.stderr.on('data',d=>{log+=d;});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,limit=15000){const end=Date.now()+limit;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e;}await sleep(100);}throw last??new Error('Timed out');}
class Cdp{
 static async connect(url){const c=new Cdp();c.ws=new WebSocket(url);await new Promise((r,j)=>{c.ws.addEventListener('open',r,{once:true});c.ws.addEventListener('error',j,{once:true});});c.id=0;c.pending=new Map();c.listeners=[];c.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=c.pending.get(m.id);c.pending.delete(m.id);m.error?p?.reject(new Error(m.error.message)):p?.resolve(m.result);}else for(const fn of c.listeners)fn(m);});return c;}
 send(method,params={},sessionId){const id=++this.id;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timed out'));},30000);this.pending.set(id,{resolve:x=>{clearTimeout(timeout);resolve(x);},reject:e=>{clearTimeout(timeout);reject(e);}});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
 async attach(targetId){return(await this.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;}
 async evaluate(sessionId,expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;}
}
let c;const report={};
try{
 const active=await until(async()=>{const text=await readFile(resolve(profile,'DevToolsActivePort'),'utf8');return text.split('\n');});c=await Cdp.connect('ws://127.0.0.1:'+active[0]+active[1]);
 report.version=await c.send('Browser.getVersion');
 await mkdir(resolve(out,'downloads'),{recursive:true});await c.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:resolve(out,'downloads')});
 const worker=await until(async()=>{const targets=(await c.send('Target.getTargets')).targetInfos;return targets.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'));});
 const extensionBase=worker.url.replace('background.js','');let workerSession=await c.attach(worker.targetId);
 const evaluate=(s,e)=>c.evaluate(s,e);
 c.listeners.push(m=>{if(m.method==='Runtime.exceptionThrown')console.error('Runtime exception',JSON.stringify(m.params.exceptionDetails));});await c.send('Runtime.enable',{},workerSession);
 console.log('Loaded extension',extensionBase);
 const inspect=()=>evaluate(workerSession,"(async()=>({jobs:(await chrome.storage.local.get('jobs')).jobs??[],tabs:await chrome.tabs.query({}),downloads:await chrome.downloads.search({}),contexts:await chrome.runtime.getContexts({})}))()");
 const newPage=async(url,html)=>{
  const {targetId}=await c.send('Target.createTarget',{url:'about:blank'});const sessionId=await c.attach(targetId);await c.send('Page.enable',{},sessionId);await c.send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  if(html){await c.send('Fetch.enable',{patterns:[{urlPattern:'https://'+youtubeHost+'/*',resourceType:'Document'}]},sessionId);c.listeners.push(m=>{if(m.sessionId===sessionId&&m.method==='Fetch.requestPaused')c.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:'text/html'}],body:Buffer.from(html).toString('base64')},sessionId).catch(()=>{});});}
  await c.send('Runtime.enable',{},sessionId);await c.send('Page.navigate',{url},sessionId);return {targetId,sessionId};
 };
 const click=async(page,expression)=>{
  await c.send('Page.bringToFront',{},page.sessionId);
  const point=await evaluate(page.sessionId,`(async()=>{const e=${expression};if(!e)throw new Error('Click target missing');e.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();if(!r.width||!r.height)throw new Error('Click target is hidden');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},page.sessionId);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},page.sessionId);await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},page.sessionId);
 };
 if(live){
  const page=await newPage('https://'+youtubeHost+'/watch?v='+sample);
  await until(()=>evaluate(page.sessionId,"!!document.querySelector('video')"),45000);
  await evaluate(page.sessionId,"document.querySelector('video').play().then(()=>true).catch(()=>false)");
  await until(()=>evaluate(page.sessionId,"!!document.querySelector('#ytdl-inline-host')"),30000);
  await click(page,"document.querySelector('#ytdl-inline-host').shadowRoot.querySelector('button')");
  await until(()=>evaluate(page.sessionId,"document.querySelector('#ytdl-quality-host')?.shadowRoot.querySelectorAll('.quality').length"),30000);
  report.realQualities=await evaluate(page.sessionId,"[...document.querySelector('#ytdl-quality-host').shadowRoot.querySelectorAll('.quality')].map(x=>x.textContent)");
  report.pageUrl=await evaluate(page.sessionId,'location.href');
  if(process.env.METADATA_ONLY==='1'){report.success=true;console.log(JSON.stringify(report));}else{
  await sleep(6000);report.playback=await evaluate(page.sessionId,"(()=>{const v=document.querySelector('video');return{paused:v.paused,currentTime:v.currentTime,readyState:v.readyState};})()");
  const selected=quality?`[...document.querySelector('#ytdl-quality-host').shadowRoot.querySelectorAll('.quality')].find(e=>e.textContent.startsWith('${quality}p'))`:"document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('.quality')";await click(page,selected);
  await sleep(1200);report.initialJobs=(await inspect()).jobs.map(j=>({state:j.state,error:j.error}));report.inlineStatus=await evaluate(page.sessionId,"document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('[role=status]').textContent");console.log(JSON.stringify({playback:report.playback,jobs:report.initialJobs,inlineStatus:report.inlineStatus}));
  assert(report.initialJobs.length,report.inlineStatus);
  const state=await until(async()=>{const s=await inspect();return s.jobs.some(j=>['complete','failed','cancelled'].includes(j.state))?s:null;},180000);
  const job=state.jobs.at(-1);report.realJob={state:job.state,error:job.error,progress:job.progress};
  assert.equal(job.state,'complete',JSON.stringify(report.realJob));
  const file=state.downloads.find(d=>d.id===job.downloadId);const bytes=await readFile(file.filename);report.realSavedBytes=bytes.length;
  const decode=spawn(resolve('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),['-v','error','-i',file.filename,'-f','null','-'],{windowsHide:true,stdio:['ignore','ignore','pipe']});let decodeError='';decode.stderr.on('data',d=>{decodeError+=d;});assert.equal(await new Promise(r=>decode.on('exit',r)),0,decodeError);assert.equal(decodeError,'');report.realIndependentDecode=true;report.sample=sample;report.requestedHeight=quality;
  assert(!state.tabs.some(t=>t.url?.includes('/offscreen/')||t.url?.includes('/runner/')));report.noTaskTab=true;report.success=true;
  console.log(JSON.stringify(report));
 }
 }else{
 const youtube=await newPage('https://'+youtubeHost+'/watch?v=abcdefghijk','<!doctype html><title>YouTube fixture</title><div id="top-level-buttons-computed" style="margin:40px;display:flex"><button>Like</button></div>');
 const ordinary=await newPage(base+'/progress');
 await until(()=>evaluate(youtube.sessionId,"!!document.querySelector('#ytdl-inline-host')?.shadowRoot.querySelector('button')"));
 await click(youtube,"document.querySelector('#ytdl-inline-host').shadowRoot.querySelector('button')");
 await until(()=>evaluate(youtube.sessionId,"!!document.querySelector('#ytdl-quality-host')?.shadowRoot.querySelector('.quality')"));
 await click(youtube,"document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('.quality')");
 await until(async()=>{const s=await inspect();return s.jobs.some(j=>j.state==='downloading');});
 const tabsBefore=(await inspect()).tabs.length;
 // A genuine extension popup document receives its state, then closes while downloading.
 const popup=await newPage(extensionBase+'popup/popup.html');await until(()=>evaluate(popup.sessionId,"!!document.querySelector('#title')"));await c.send('Target.closeTarget',{targetId:popup.targetId});
 const widget=()=>evaluate(ordinary.sessionId,"(()=>{const h=document.querySelector('#ytdl-widget-host');return{visible:h?.style.display!=='none',text:h?.shadowRoot.textContent};})()");
 await until(async()=>{const x=await widget();return x.visible&&x.text.includes('Загрузка');});
 const started=Date.now();held=false;for(const finish of pending.splice(0))finish();
 const complete=await until(async()=>{const s=await inspect();return s.jobs.some(j=>j.state==='complete')?s:null;},20000);
 report.completeElapsedMs=Date.now()-started;report.closedPopupCompletes=true;
 const job=complete.jobs.find(j=>j.state==='complete');const download=complete.downloads.find(d=>d.id===job.downloadId);assert(download?.state==='complete');
 const saved=await readFile(download.filename);report.savedBytes=saved.length;report.sha256=createHash('sha256').update(saved).digest('hex');
 const decode=spawn(resolve('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),['-v','error','-i',download.filename,'-f','null','-'],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';decode.stderr.on('data',d=>{error+=d;});const exit=await new Promise(r=>decode.on('exit',r));assert.equal(exit,0,error);assert.equal(error,'');report.independentDecode=true;
 await until(async()=>{const x=await widget();return x.text?.includes('Скачано');});report.widgetShowsComplete=true;
 await until(async()=>!(await widget()).visible,7000);report.widgetAutoHides=true;
 assert.equal(complete.tabs.length,tabsBefore);assert(!complete.tabs.some(t=>t.url?.includes('/runner/')||t.url?.includes('/offscreen/')));assert(complete.contexts.some(x=>x.contextType==='OFFSCREEN_DOCUMENT'));report.noTaskTab=true;
 console.log('Brave hidden media save and widget passed');
 // Hold four starts in distinct tabs; cancel one while the other three finish.
 held=true;const pages=[];
 for(let i=0;i<4;i++){
  const page=await newPage('https://'+youtubeHost+'/watch?v=abcdefghijk','<!doctype html><title>Parallel fixture</title><div id="top-level-buttons-computed" style="margin:40px;display:flex"><button>Like</button></div>');pages.push(page);
  await until(()=>evaluate(page.sessionId,"!!document.querySelector('#ytdl-inline-host')"));await click(page,"document.querySelector('#ytdl-inline-host').shadowRoot.querySelector('button')");await until(()=>evaluate(page.sessionId,"!!document.querySelector('#ytdl-quality-host')?.shadowRoot.querySelector('.quality')"));await click(page,"document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('.quality')");
 }
 const parallel=await until(async()=>{const s=await inspect();return s.jobs.filter(j=>j.state==='downloading').length===4?s:null;});report.parallelActive=4;
 let workerVersions=[];c.listeners.push(m=>{if(m.sessionId===ordinary.sessionId&&m.method==='ServiceWorker.workerVersionUpdated')workerVersions.push(...m.params.versions);});
 await c.send('ServiceWorker.enable',{},ordinary.sessionId);
 const version=await until(()=>workerVersions.find(v=>v.scriptURL===worker.url));
 await c.send('Target.detachFromTarget',{sessionId:workerSession});
 await c.send('ServiceWorker.stopWorker',{versionId:version.versionId},ordinary.sessionId);
 const restarted=await until(async()=>{const items=(await c.send('Target.getTargets')).targetInfos;return items.find(t=>t.type==='service_worker'&&t.url===worker.url&&t.targetId!==worker.targetId);});
 workerSession=await c.attach(restarted.targetId);
 await until(async()=>{const s=await inspect();return s.jobs.filter(j=>j.state==='downloading').length===4;});report.workerRestartPreservesFourJobs=true;

 await click(pages[3],"document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('[data-role=cancel]')");await until(async()=>{const s=await inspect();return s.jobs.some(j=>j.state==='cancelled');});
 held=false;for(const finish of pending.splice(0))finish();await until(async()=>{const s=await inspect();return s.jobs.filter(j=>j.state==='complete').length===4;},20000);report.independentCancellation=true;
 const final=await inspect();assert.equal(final.downloads.length,4);assert.equal(final.contexts.filter(x=>x.contextType==='OFFSCREEN_DOCUMENT').length,1);assert(!final.tabs.some(t=>t.url?.includes('/offscreen/')||t.url?.includes('/runner/')));
 report.success=true;console.log(JSON.stringify(report));
 }
}catch(error){report.success=false;report.error=error.stack;console.error(error);throw error;}
finally{await writeFile(resolve(out,'results.json'),JSON.stringify(report,null,2));await writeFile(resolve(out,'browser.log'),log);if(c){await c.send('Browser.close').catch(()=>{});c.ws.close();}browserProcess.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
