"""Production Firefox popup/job/save without a runner tab; isolated local-media fixture."""
import hashlib, json, os, socket, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'.superpowers/browser-libs'))
from marionette_driver.marionette import Marionette
from marionette_driver.addons import Addons
OUT=ROOT/'.superpowers/firefox-no-tab';OUT.mkdir(parents=True,exist_ok=True)
DOWNLOADS=OUT/'downloads';DOWNLOADS.mkdir(exist_ok=True)
subprocess.run(['node','--input-type=module','-e',"import{build}from'esbuild';await build({entryPoints:['tests/browser/background-mux-probe.js'],outfile:'.superpowers/firefox-no-tab/mux-probe.js',bundle:true,format:'iife',target:'firefox142'});"],cwd=ROOT,check=True)
profile=Path(tempfile.mkdtemp(prefix='profile-',dir=OUT))
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
uuid='ec495304-cc16-40cc-96cf-dac46b331d93'
prefs={'marionette.port':port,'browser.shell.checkDefaultBrowser':False,'browser.aboutwelcome.enabled':False,'browser.download.folderList':2,'browser.download.dir':str(DOWNLOADS),'browser.download.useDownloadDir':True,'extensions.webextensions.uuids':json.dumps({'youtube-mp4-downloader@local.invalid':uuid})}
(profile/'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)},{json.dumps(v)});'for k,v in prefs.items()),encoding='utf8')
package=OUT/'extension.xpi'
with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED)as z:
 for p in (ROOT/'dist/firefox').rglob('*'):
  if p.is_file() and p.name!='manifest.json':z.write(p,p.relative_to(ROOT/'dist/firefox'))
 manifest=json.loads((ROOT/'dist/firefox/manifest.json').read_text())
 assert manifest['manifest_version']==2 and manifest['background']['persistent']
 manifest['background']['scripts'].insert(0,'probe/environment.js');manifest['background']['scripts'].append('probe/mux-probe.js')
 z.writestr('manifest.json',json.dumps(manifest));z.write(ROOT/'tests/browser/no-tab-environment.js','probe/environment.js');z.write(OUT/'mux-probe.js','probe/mux-probe.js')
 z.writestr('probe/controller.html','<!doctype html><html><body>Test controller</body></html>')
 for name in ['background-video.mp4','background-audio.mp4']:z.write(ROOT/'tests/fixtures'/name,'probe/'+name)
result={};log=(OUT/'firefox.log').open('w',encoding='utf8')
process=subprocess.Popen([r'C:\Program Files\Mozilla Firefox\firefox.exe','-no-remote','-headless','-profile',str(profile),'-marionette'],env={**os.environ,'MOZ_HEADLESS':'1','MOZ_REMOTE_ALLOW_SYSTEM_ACCESS':'1'},stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
m=Marionette(port=port,socket_timeout=60)
def inspect():
 m.set_context('content')
 return m.execute_async_script("const done=arguments[arguments.length-1],bg=window.wrappedJSObject.browser.extension.getBackgroundPage();(bg.wrappedJSObject??bg).noTabProbe.inspect().then(x=>done(JSON.parse(JSON.stringify(x))));")
def popup_eval(expression):
 m.set_context('chrome')
 return m.execute_async_script("""const done=arguments[arguments.length-1],mm=document.querySelector('browser.webextension-popup-browser').messageManager;const listener=m=>{mm.removeMessageListener('NoTabResult',listener);done(m.data);};mm.addMessageListener('NoTabResult',listener);mm.loadFrameScript('data:application/javascript,'+encodeURIComponent("sendAsyncMessage('NoTabResult',"+arguments[0]+");"),false);""",script_args=[expression])
def start(mode):
 m.set_context('content')
 m.execute_script("const bg=window.wrappedJSObject.browser.extension.getBackgroundPage();(bg.wrappedJSObject??bg).noTabProbe.setMode(arguments[0]);",script_args=[mode])
 m.execute_async_script("const done=arguments[arguments.length-1];window.wrappedJSObject.browser.browserAction.openPopup().then(done,e=>done({error:e.message}));")
 for _ in range(30):
  try:
   popup=popup_eval("({ready:!!content.document.querySelector('#quality')?.options.length,title:content.document.querySelector('#title')?.textContent,error:content.document.querySelector('#error')?.textContent})")
   if popup.get('ready'):break
  except Exception:pass
  time.sleep(.1)
 assert popup.get('ready'),str(popup)
 popup_eval("(()=>{const s=content.document.querySelector('#quality');content.stableQualityOptions=[...s.options];return true;})()")
 time.sleep(1.8) # Allow at least two production popup polls.
 assert popup_eval("(()=>{const s=content.document.querySelector('#quality');return content.stableQualityOptions.every((o,i)=>s.options[i]===o);})()"), 'Periodic refresh recreated the quality options'
 popup_eval("(()=>{content.document.querySelector('#download').click();return true;})()")
 time.sleep(.1)
 for _ in range(30):
  running=inspect()
  if running['jobs'] and running['jobs'][-1]['state']=='downloading':break
  time.sleep(.05)
 assert running['jobs'] and running['jobs'][-1]['state']=='downloading',str(running)+str(popup_eval("content.document.querySelector('#error').textContent"))
 if mode=='cancel':popup_eval("(()=>{content.document.querySelector('#cancel').click();return true;})()")
 m.set_context('chrome')
 closed=m.execute_script("const p=document.querySelector('browser.webextension-popup-browser')?.closest('panel');p?.hidePopup();return !!p;")
 assert closed, 'Popup panel was not found for closure'
 time.sleep(.05)
 assert m.execute_script("return ![...document.querySelectorAll('panel')].some(p=>p.state==='open'&&p.querySelector('browser.webextension-popup-browser'))"), 'Popup remained open'
 return popup,running
try:
 for _ in range(150):
  try:
   with socket.create_connection(('127.0.0.1',port),timeout=.2):break
  except OSError:time.sleep(.2)
 m.start_session(timeout=30);m.timeout.script=40;result['firefoxVersion']=m.session['browserVersion'];Addons(m).install(str(package),temp=True)
 m.navigate(f'moz-extension://{uuid}/probe/controller.html')
 baseline=inspect();result['initialTabs']=len(baseline['tabs'])
 result['popup'],result['whileDownloading']=start('complete')
 for _ in range(80):
  state=inspect()
  if state['jobs'][-1]['state'] in ['complete','failed','cancelled']:break
  time.sleep(.1)
 result['complete']=state;assert state['jobs'][-1]['state']=='complete',str(state)
 assert state['stats']['failedDialogs']==1;result['saveDialogFallback']=True
 saved=next(d for d in state['downloads']if d['id']==state['jobs'][-1]['downloadId'])
 path=Path(saved['filename']);assert path.is_relative_to(DOWNLOADS) and path.exists();result['savedBytes']=path.stat().st_size;result['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
 decode=subprocess.run([str(ROOT/'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),'-v','error','-i',str(path),'-f','null','-'],capture_output=True,text=True)
 result['independentDecode']=decode.returncode==0 and not decode.stderr;assert result['independentDecode'],decode.stderr
 result['cancelPopup'],_=start('cancel')
 for _ in range(30):
  state=inspect()
  if state['jobs'][-1]['state'] in ['cancelled','failed','complete']:break
  time.sleep(.1)
 result['cancel']=state;assert state['jobs'][-1]['state']=='cancelled';assert len(state['downloads'])==1
 for key in ['complete','cancel']:
  assert result[key]['stats']['createdTabs']==0;assert len(result[key]['tabs'])==result['initialTabs'];assert not any('/runner/'in(t.get('url')or'')for t in result[key]['tabs'])
 m.set_context('content')
 result['mux']=m.execute_async_script("const done=arguments[arguments.length-1];window.wrappedJSObject.browser.runtime.sendMessage({type:'RUNNER_MUX_BENCHMARK',cancel:false}).then(done);")
 assert result['mux']['exactPackets'] and result['mux']['contextPath']=='/_generated_background_page.html';assert result['mux']['elapsedMs']<3000
 # Four real popup starts, in four tabs, held before media completion.
 for index in range(4):
  if index:
   m.open(type='tab');m.switch_to_window(m.window_handles[-1]);m.set_context('content');m.navigate(f'moz-extension://{uuid}/probe/controller.html')
  start('parallel')
 running=inspect();result['parallelActiveCount']=sum(j['state']=='downloading'for j in running['jobs']);assert result['parallelActiveCount']==4
 m.set_context('content');m.execute_async_script("const done=arguments[arguments.length-1];window.wrappedJSObject.browser.browserAction.openPopup().then(done);")
 time.sleep(.3);popup_eval("(()=>{content.document.querySelector('#cancel').click();return true;})()")
 m.set_context('content');m.execute_script("const bg=window.wrappedJSObject.browser.extension.getBackgroundPage();(bg.wrappedJSObject??bg).noTabProbe.releaseParallel();")
 for _ in range(100):
  state=inspect();parallel=state['jobs'][-4:]
  if all(j['state']in['complete','cancelled','failed']for j in parallel):break
  time.sleep(.1)
 result['parallelStates']=[j['state']for j in parallel];assert result['parallelStates']==['complete','complete','complete','cancelled'],str(state)
 assert len(state['downloads'])==4 and state['stats']['createdTabs']==0;assert not any('/runner/'in(t.get('url')or'')for t in state['tabs'])
 for download in state['downloads']:
  path=Path(download['filename']);assert path.is_relative_to(DOWNLOADS)
  decode=subprocess.run([str(ROOT/'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),'-v','error','-i',str(path),'-f','null','-'],capture_output=True,text=True)
  assert decode.returncode==0 and not decode.stderr
 result['parallelSavedDecode']=True
except Exception as error:
 import traceback
 result['fatal']=str(error) or type(error).__name__;result['trace']=traceback.format_exc()
finally:
 try:m.delete_session()
 except Exception:pass
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill()
 log.close();(OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(result,ensure_ascii=True),flush=True)
if result.get('fatal'):sys.exit(1)
