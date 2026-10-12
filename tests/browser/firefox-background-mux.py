"""Compare real active/inactive Firefox remux. Only isolated profiles and local fixtures."""
import json, os, socket, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'.superpowers/browser-libs'))
from marionette_driver.marionette import Marionette
from marionette_driver.addons import Addons
OUT=ROOT/'.superpowers/background-mux';OUT.mkdir(parents=True,exist_ok=True)
subprocess.run(['node','--input-type=module','-e',"import{build}from'esbuild';await build({entryPoints:['tests/browser/background-mux-probe.js'],outfile:'.superpowers/background-mux/probe.js',bundle:true,format:'iife',target:'firefox142'});"],cwd=ROOT,check=True)
profile=Path(tempfile.mkdtemp(prefix='profile-',dir=OUT))
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
uuid='ec495304-cc16-40cc-96cf-dac46b331d93'
prefs={'marionette.port':port,'browser.shell.checkDefaultBrowser':False,'browser.aboutwelcome.enabled':False,'extensions.webextensions.uuids':json.dumps({'youtube-mp4-downloader@local.invalid':uuid})}
(profile/'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)},{json.dumps(v)});'for k,v in prefs.items()),encoding='utf8')
package=OUT/'extension.xpi'
with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED)as z:
 for p in (ROOT/'dist/firefox').rglob('*'):
  if p.is_file():z.write(p,p.relative_to(ROOT/'dist/firefox'))
 z.write(OUT/'probe.js','probe/probe.js')
 z.writestr('probe/probe.html','<!doctype html><html><body>Background mux test<script src="probe.js"></script></body></html>')
 for name in ['background-video.mp4','background-audio.mp4']:z.write(ROOT/'tests/fixtures'/name,'probe/'+name)
result={'sampleSeconds':20,'runs':[]};log=(OUT/'firefox.log').open('w',encoding='utf8')
process=subprocess.Popen([r'C:\Program Files\Mozilla Firefox\firefox.exe','-no-remote','-headless','-profile',str(profile),'-marionette'],env={**os.environ,'MOZ_HEADLESS':'1','MOZ_REMOTE_ALLOW_SYSTEM_ACCESS':'1'},stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
m=Marionette(port=port,socket_timeout=60)
try:
 for _ in range(150):
  try:
   with socket.create_connection(('127.0.0.1',port),timeout=.2):break
  except OSError:time.sleep(.2)
 m.start_session(timeout=30);m.timeout.script=55
 result['firefoxVersion']=m.session['browserVersion'];Addons(m).install(str(package),temp=True)
 m.navigate(f'moz-extension://{uuid}/runner/runner.html')
 tab=m.execute_async_script('''const done=arguments[arguments.length-1];window.wrappedJSObject.browser.tabs.create({url:arguments[0],active:false}).then(t=>done(t.id));''',script_args=[f'moz-extension://{uuid}/probe/probe.html'])
 time.sleep(2)
 for active,cancel in [(False,False),(True,False),(False,True)]:
  m.execute_async_script('''const done=arguments[arguments.length-1],api=window.wrappedJSObject.browser;api.tabs.update(arguments[0],{active:arguments[1]}).then(done);''',script_args=[tab,active]) if active else None
  if not active:
   m.execute_async_script('''const done=arguments[arguments.length-1],api=window.wrappedJSObject.browser;api.tabs.query({}).then(t=>api.tabs.update(t.find(x=>x.url.endsWith('/runner/runner.html')).id,{active:true})).then(done);''')
  time.sleep(1)
  run=m.execute_async_script('''const done=arguments[arguments.length-1];window.wrappedJSObject.browser.runtime.sendMessage({type:'RUNNER_MUX_BENCHMARK',cancel:arguments[0]}).then(done,e=>done({error:e.message}));''',script_args=[cancel])
  result['runs'].append({'active':active,'cancel':cancel,**run});print(json.dumps(result['runs'][-1]),flush=True)
except Exception as error:result['fatal']=str(error)
finally:
 try:m.delete_session()
 except Exception:pass
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill()
 log.close();(OUT/'results.json').write_text(json.dumps(result,indent=2),encoding='utf8')
if result.get('fatal')or len(result['runs'])!=3:print(json.dumps(result));sys.exit(1)
assert all(r.get('exactPackets') for r in result['runs']if not r['cancel'])
assert result['runs'][0]['hiddenAtStart'] and not result['runs'][0]['visibleDuringMux']
assert not result['runs'][1]['hiddenAtStart']
assert result['runs'][2].get('error')=='CANCELLED'
# Generous bound for this tiny local fixture; the old clamped loop took13.5s.
assert result['runs'][0]['elapsedMs']<3000, 'Inactive remux still incurs background timer delays'
