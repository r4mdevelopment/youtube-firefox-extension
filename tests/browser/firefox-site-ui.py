"""Trusted clicks on live YouTube UI + ordinary-site widget, fixture media only."""
import json,os,socket,subprocess,sys,tempfile,time,zipfile,threading,http.server
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'.superpowers/browser-libs'))
from marionette_driver.marionette import Marionette
from marionette_driver.addons import Addons
OUT=ROOT/'.superpowers/firefox-site-ui';OUT.mkdir(parents=True,exist_ok=True);downloads=OUT/'downloads';downloads.mkdir(exist_ok=True)
class Page(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(b'<!doctype html><html><body style="font:20px Arial"><h1>Ordinary site</h1><p>Extension progress without YouTube.</p></body></html>')
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Page);threading.Thread(target=server.serve_forever,daemon=True).start()
profile=Path(tempfile.mkdtemp(prefix='profile-',dir=OUT))
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
uuid='ec495304-cc16-40cc-96cf-dac46b331d93'
prefs={'marionette.port':port,'browser.shell.checkDefaultBrowser':False,'browser.aboutwelcome.enabled':False,'browser.download.folderList':2,'browser.download.dir':str(downloads),'browser.download.useDownloadDir':True,'extensions.webextensions.uuids':json.dumps({'youtube-mp4-downloader@local.invalid':uuid})}
(profile/'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)},{json.dumps(v)});'for k,v in prefs.items()),encoding='utf8')
package=OUT/'extension.xpi'
with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED)as z:
 for p in (ROOT/'dist/firefox').rglob('*'):
  if p.is_file()and p.name!='manifest.json':z.write(p,p.relative_to(ROOT/'dist/firefox'))
 manifest=json.loads((ROOT/'dist/firefox/manifest.json').read_text());manifest['background']['scripts'].insert(0,'probe/environment.js');z.writestr('manifest.json',json.dumps(manifest));z.write(ROOT/'tests/browser/site-ui-environment.js','probe/environment.js')
 z.writestr('probe/controller.html','<!doctype html><body>Probe</body>')
 for name in ['background-video.mp4','background-audio.mp4']:z.write(ROOT/'tests/fixtures'/name,'probe/'+name)
log=(OUT/'firefox.log').open('w',encoding='utf8');process=subprocess.Popen([r'C:\Program Files\Mozilla Firefox\firefox.exe','-no-remote','-headless','-profile',str(profile),'-marionette'],env={**os.environ,'MOZ_HEADLESS':'1','MOZ_REMOTE_ALLOW_SYSTEM_ACCESS':'1'},stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
m=Marionette(port=port,socket_timeout=60);result={}
def wait(script,seconds=25):
 deadline=time.time()+seconds
 while time.time()<deadline:
  try:
   value=m.execute_script(script)
   if value:return value
  except Exception:pass
  time.sleep(.2)
 raise AssertionError('UI condition timed out: '+script)
def click(host,selector):
 node=m.execute_script('return document.querySelector(arguments[0]).shadowRoot.querySelector(arguments[1]);',script_args=[host,selector]);assert node;node.click()
def probe(script):
 handle=m.current_window_handle;m.switch_to_window(controller);m.set_context('content')
 try:return m.execute_async_script('const done=arguments[arguments.length-1];const bg=window.wrappedJSObject.browser.extension.getBackgroundPage();Promise.resolve((bg.wrappedJSObject??bg).noTabProbe.'+script+').then(x=>done(x===undefined?null:JSON.parse(JSON.stringify(x))));')
 finally:m.switch_to_window(handle);m.set_context('content')
try:
 for _ in range(150):
  try:m.start_session(capabilities={'pageLoadStrategy':'eager'},timeout=30);break
  except Exception:time.sleep(.1)
 result['firefoxVersion']=m.session_capabilities['browserVersion'];m.set_window_rect(width=1440,height=1000);Addons(m).install(str(package),temp=True)
 m.navigate(f'moz-extension://{uuid}/probe/controller.html');controller=m.current_window_handle
 m.open(type='tab');m.switch_to_window(m.window_handles[-1]);m.set_context('content');m.navigate('https://www.youtube.com/watch?v=jNQXAC9IVRw');youtube=m.current_window_handle
 wait("return !!document.querySelector('#ytdl-quality-host')?.shadowRoot.querySelector('[data-choice]');",50)
 m.execute_script("document.querySelectorAll('video').forEach(v=>v.pause());")
 result['beforeLikes']=m.execute_script("return document.querySelector('#ytdl-inline-host').parentElement.firstElementChild.id==='ytdl-inline-host';");assert result['beforeLikes']
 click('#ytdl-inline-host','[data-role="toggle"]');wait("return !document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('.menu').hidden;")
 wait("return document.querySelector('#ytdl-quality-host')?.shadowRoot.querySelector('[data-choice=\"137:140\"]');")
 result['plainButton']=m.execute_script("return document.querySelector('#ytdl-inline-host').shadowRoot.querySelector('[data-role=toggle]').textContent==='Скачать';");assert result['plainButton']
 def anchored():
  return m.execute_script("const a=document.querySelector('#ytdl-inline-host').shadowRoot.querySelector('[data-role=toggle]').getBoundingClientRect(),h=document.querySelector('#ytdl-quality-host'),b=h.getBoundingClientRect();return h.parentElement===document.body&&Math.min(Math.abs(b.top-a.bottom-8),Math.abs(a.top-b.bottom-8))<2;")
 assert anchored();m.execute_script('scrollBy(0,100);');time.sleep(.2);assert anchored();result['scrollAnchored']=True
 m.execute_script("document.querySelector('#ytdl-quality-host').shadowRoot.querySelector('[data-choice]').click();")
 time.sleep(.3);assert not probe('inspect()')['jobs'];result['syntheticClickIgnored']=True
 click('#ytdl-quality-host','[data-choice]');time.sleep(.5);state=probe('inspect()');assert state['jobs'][-1]['state']=='downloading',str(state);result['trustedQualityClick']=True
 (OUT/'inline.png').write_bytes(m.screenshot(format='binary'))
 m.open(type='tab');m.switch_to_window(m.window_handles[-1]);m.set_context('content');m.navigate(f'http://127.0.0.1:{server.server_port}/');ordinary=m.current_window_handle
 wait("return document.querySelector('#ytdl-widget-host')?.shadowRoot.textContent.includes('Загрузка');")
 result['ordinarySiteVisible']=m.execute_script("const h=document.querySelector('#ytdl-widget-host'),r=h.getBoundingClientRect();return getComputedStyle(h).display!=='none'&&r.right<=innerWidth&&r.bottom<=innerHeight;");assert result['ordinarySiteVisible']
 click('#ytdl-widget-host','header button');assert m.execute_script("return document.querySelector('#ytdl-widget-host').shadowRoot.querySelector('.jobs').hidden;");click('#ytdl-widget-host','header button');result['collapse']=True
 probe('releaseParallel()');wait("return document.querySelector('#ytdl-widget-host')?.shadowRoot.textContent.includes('Скачано');")
 state=probe('inspect()');assert state['jobs'][-1]['state']=='complete'and len(state['downloads'])==1;result['complete']=True
 saved=Path(state['downloads'][0]['filename']);decode=subprocess.run([str(ROOT/'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),'-v','error','-i',str(saved),'-f','null','-'],capture_output=True,text=True);assert decode.returncode==0 and not decode.stderr;result['independentDecode']=True
 (OUT/'widget.png').write_bytes(m.screenshot(format='binary'))
 wait("return getComputedStyle(document.querySelector('#ytdl-widget-host')).display==='none';",8);result['autoCloseAfterCompletion']=True
 m.switch_to_window(youtube);m.set_context('content');probe("setMode('cancel')");time.sleep(1.1);click('#ytdl-quality-host','[data-choice]');time.sleep(.5)
 m.switch_to_window(ordinary);m.set_context('content');wait("return !!document.querySelector('#ytdl-widget-host')?.shadowRoot.querySelector('[data-cancel]');");click('#ytdl-widget-host','[data-cancel]');wait("return document.querySelector('#ytdl-widget-host')?.shadowRoot.textContent.includes('Отменено');");result['ordinarySiteCancel']=True
 click('#ytdl-widget-host','[data-role=hide-widget]');wait("return getComputedStyle(document.querySelector('#ytdl-widget-host')).display==='none';");m.switch_to_window(youtube);m.set_context('content');wait("return getComputedStyle(document.querySelector('#ytdl-widget-host')).display==='none';");result['globalCloseAcrossTabs']=True
 state=probe('inspect()');assert state['stats']['createdTabs']==0 and len(state['downloads'])==1;result['noRunnerTabs']=True
except Exception as e:
 import traceback
 result['fatal']=str(e);result['trace']=traceback.format_exc()
finally:
 try:m.delete_session()
 except Exception:pass
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill()
 server.shutdown();log.close();(OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(result,ensure_ascii=True),flush=True)
if result.get('fatal'):sys.exit(1)
