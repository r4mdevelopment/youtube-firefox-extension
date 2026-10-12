"""Real Firefox smoke probe. Dependencies live in .superpowers/browser-libs.
Uses an isolated profile, temporary add-on, and localhost-only Marionette.
Never reads the user's Firefox profile or prints signed media URLs.
"""
import json
from datetime import date
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.superpowers/browser-libs'))
from marionette_driver.marionette import Marionette
from marionette_driver.addons import Addons

OUT = ROOT / '.superpowers/firefox-browser'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'downloads').mkdir(exist_ok=True)
subprocess.run(['node', '--input-type=module', '-e', "import {build} from 'esbuild'; await build({entryPoints:['tests/browser/media-probe.js'],outfile:'.superpowers/firefox-browser/media-probe.js',bundle:true,format:'iife',target:'firefox142'});"], cwd=ROOT, check=True)
SABR_PROBE = os.environ.get('SABR_PROBE') == '1'
DOWNLOAD_PROBE = os.environ.get('DOWNLOAD_PROBE') == '1'
if SABR_PROBE:
    subprocess.run(['node', '--input-type=module', '-e', "import {build} from 'esbuild'; await build({entryPoints:['tests/browser/sabr-extension-probe.js'],outfile:'.superpowers/firefox-browser/sabr-probe.js',bundle:true,format:'iife',target:'firefox142'});"], cwd=ROOT, check=True)
PROFILE = Path(tempfile.mkdtemp(prefix='profile-', dir=OUT))
PROFILE.mkdir(exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
prefs = {
    'marionette.port': port,
    'browser.shell.checkDefaultBrowser': False,
    'browser.aboutwelcome.enabled': False,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.download.folderList': 2,
    'browser.download.dir': str(OUT / 'downloads'),
    'browser.download.useDownloadDir': True,
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'extensions.webextensions.uuids': json.dumps({'youtube-mp4-downloader@local.invalid': 'ec495304-cc16-40cc-96cf-dac46b331d93'}),
}
(PROFILE / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k, v in prefs.items()), encoding='utf8')
package = OUT / 'extension.xpi'
with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in (ROOT / 'dist/firefox').rglob('*'):
        if file.is_file() and file.name != 'manifest.json':
            if DOWNLOAD_PROBE and file.relative_to(ROOT / 'dist/firefox').as_posix() == 'runner/runner.html':
                archive.writestr('runner/runner.html', file.read_text().replace('<script src="runner.js">', '<script src="../probe/no-save-dialog.js"></script><script src="runner.js">'))
            else: archive.write(file, file.relative_to(ROOT / 'dist/firefox'))
    manifest = json.loads((ROOT / 'dist/firefox/manifest.json').read_text())
    if DOWNLOAD_PROBE:
        manifest['background']['scripts'].insert(0, 'probe/no-save-dialog.js')
    if SABR_PROBE:
        if 'webRequest' not in manifest['permissions']: manifest['permissions'].append('webRequest')
        manifest['background']['scripts'].append('probe/sabr-probe.js')
        archive.write(OUT / 'sabr-probe.js', 'probe/sabr-probe.js')
    archive.writestr('manifest.json', json.dumps(manifest))
    if DOWNLOAD_PROBE:
        archive.writestr('probe/no-save-dialog.js', 'const api=browser.downloads; const save=api.download.bind(api); api.download=options=>save({...options,saveAs:false});')
    archive.write(OUT / 'media-probe.js', 'probe/media-probe.js')
    archive.writestr('probe/probe.html', '<!doctype html><html><body><script src="media-probe.js"></script></body></html>')
    for name in ['video-only.mp4', 'audio-only.mp4']:
        archive.write(ROOT / 'tests/fixtures' / name, 'probe/' + name)

results = {'date': date.today().isoformat(), 'checks': []}
log = (OUT / 'firefox.log').open('w', encoding='utf8')
env = {**os.environ, 'MOZ_HEADLESS': '1', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'}
process = subprocess.Popen([r'C:\Program Files\Mozilla Firefox\firefox.exe', '-no-remote', '-headless', '-profile', str(PROFILE), '-marionette'], env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
m = Marionette(port=port, socket_timeout=45)
try:
    for _ in range(150):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2): break
        except OSError: time.sleep(.2)
    m.start_session(capabilities={'pageLoadStrategy':'eager'}, timeout=30)
    results['firefoxVersion'] = m.session['browserVersion']
    m.timeout.page_load = 35
    m.timeout.script = 30
    addon_id = Addons(m).install(str(package), temp=True)
    results['checks'].append({'case': 'temporary addon install', 'result': 'PASS', 'id': addon_id})
    m.set_context('chrome')
    addon = m.execute_async_script('''
      const done = arguments[arguments.length - 1];
      const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      AddonManager.getAddonByID(arguments[0]).then(a => done({active:a.isActive, version:a.version, warnings:a.install?.error ?? null}));
    ''', script_args=[addon_id])
    results['addon'] = addon
    assert addon['active'], 'Installed extension is inactive'
    m.set_context('content')
    m.navigate('moz-extension://ec495304-cc16-40cc-96cf-dac46b331d93/probe/probe.html')
    m.timeout.script = 45
    media_checks = m.execute_async_script('''const done=arguments[arguments.length-1];
      window.wrappedJSObject.runMediaProbe().then(done,e=>done({error:e.message,code:e.code}));''')
    if isinstance(media_checks, list):
        import hashlib
        for check in media_checks:
            for download in check.get('downloads', []):
                saved = Path(download['filename'])
                assert saved.is_relative_to(OUT / 'downloads'), 'Download outside isolated test directory'
                assert hashlib.sha256(saved.read_bytes()).hexdigest() == check['sha256'], 'Saved file integrity mismatch'
        results['checks'].extend(media_checks)
    else:
        results['checks'].append({'case':'Firefox media probe','result':'FAIL',**media_checks})
    m.navigate('moz-extension://ec495304-cc16-40cc-96cf-dac46b331d93/probe/probe.html')
    results['checks'].append({'case': 'extension controller document startup', 'result': 'PASS' if m.execute_script('return typeof window.wrappedJSObject.browser') == 'object' else 'FAIL'})
    results['runnerStorage'] = m.execute_async_script('''
      const done = arguments[arguments.length - 1];
      window.wrappedJSObject.browser.storage.local.get('jobs').then(done, e=>done({error:e.message}));
    ''')
    m.execute_async_script("const done=arguments[arguments.length-1];window.wrappedJSObject.browser.storage.local.set({jobs:[]}).then(done);")
    results['backgroundVersion'] = m.execute_script("return window.wrappedJSObject.browser.runtime.getManifest().version")
    runner_handle = m.current_window_handle
    m.open(type='tab')
    m.switch_to_window(m.window_handles[-1])
    # Public sample, CC-licensed Blender project; used only for read-only extraction.
    try:
        m.navigate('https://www.youtube.com/watch?v=' + os.environ.get('SAMPLE_ID', 'aqz-KE-bpKQ'))
        for _ in range(30):
            state = m.execute_script('''
              const page = window.wrappedJSObject;
              const p = page.document.querySelector('#movie_player')?.getPlayerResponse?.() ?? page.ytInitialPlayerResponse;
              return {title:document.title, href:location.href, videoId:p?.videoDetails?.videoId ?? null,
                playability:p?.playabilityStatus?.status ?? null, formats:(p?.streamingData?.formats ?? []).map(f=>({itag:f.itag,mimeType:f.mimeType,hasUrl:!!f.url,hasCipher:!!f.signatureCipher})),
                adaptiveCount:p?.streamingData?.adaptiveFormats?.length ?? 0, bridgeInstalled:!!page.__ytdlBridgeInstalled,
                streamingKeys:Object.keys(p?.streamingData??{}), formatKeys:Object.keys(p?.streamingData?.adaptiveFormats?.[0]??{}),
                schema:{duration:p?.videoDetails?.lengthSeconds,titleType:typeof p?.videoDetails?.title,
                  prototype:Object.getPrototypeOf(p?.streamingData?.adaptiveFormats?.[0]??{})===page.Object.prototype,
                  invalid:(p?.streamingData?.adaptiveFormats??[]).flatMap(f=>['url','mimeType','contentLength','qualityLabel','audioQuality','signatureCipher','cipher'].filter(k=>f[k]!==undefined&&typeof f[k]!=='string').map(k=>({itag:f.itag,key:k,type:typeof f[k]})))},
                adaptive:(p?.streamingData?.adaptiveFormats??[]).map(f=>({itag:f.itag,mimeType:f.mimeType,quality:f.qualityLabel,hasUrl:!!f.url,hasCipher:!!f.signatureCipher}))};
            ''')
            if state['videoId'] or state['playability']: break
            time.sleep(.5)
        results['youtube'] = state
        if SABR_PROBE or DOWNLOAD_PROBE:
            for _ in range(40):
                playing=m.execute_script("const p=window.wrappedJSObject.document.querySelector('#movie_player');p?.mute?.();p?.playVideo?.();return p?.getCurrentTime?.()>0;")
                if playing: break
                time.sleep(.5)
            time.sleep(float(os.environ.get("LIVE_PLAY_SECONDS", "3")))
            results['playbackState'] = m.execute_script("const p=window.wrappedJSObject.document.querySelector('#movie_player');return {state:p?.getPlayerState?.(),time:p?.getCurrentTime?.()};")
        results['checks'].append({'case': 'live YouTube sample extraction', 'result': 'PASS' if state['videoId'] else 'FAIL'})
        m.switch_to_window(runner_handle)
        if SABR_PROBE:
            results['captureStats'] = m.execute_script("const b=window.wrappedJSObject.browser.extension.getBackgroundPage();return JSON.parse(JSON.stringify(b?.wrappedJSObject?.sabrProbeStats??b?.sabrProbeStats??{}));")
            m.timeout.script = 115
            results['sabrProbe'] = m.execute_async_script('''const done=arguments[arguments.length-1];
              window.wrappedJSObject.browser.runtime.sendMessage({type:'RUNNER_SABR_PROBE',full:arguments[0]}).then(done,e=>done({error:e.message}));''',script_args=[os.environ.get('SABR_FULL') == '1'])
        results['popupOpen'] = m.execute_async_script('''
          const done=arguments[arguments.length-1], api=window.wrappedJSObject.browser;
          (async()=>{const tabs=await api.tabs.query({url:'https://www.youtube.com/*'}); const tab=tabs.at(-1);
            const current=await api.tabs.sendMessage(tab.id,{type:'GET_CURRENT_METADATA'});
            const summary={tabId:tab.id,state:current.state,title:current.metadata?.payload?.title,formats:current.metadata?.payload?.adaptiveFormats?.length??0};
            await api.tabs.update(tab.id,{active:true}); await (api.action ?? api.browserAction).openPopup(); return summary;})().then(done,e=>done({error:e.message}));
        ''')
        m.set_context('chrome')
        results['popupBrowsers'] = m.execute_script("return [...document.querySelectorAll('browser')].map(b=>({id:b.id,cls:b.className,src:b.getAttribute('src')}))")
        time.sleep(1)
        for _ in range(20):
            results['popup'] = m.execute_async_script('''
          const done=arguments[arguments.length-1], popup=document.querySelector('browser.webextension-popup-browser');
          const mm=popup.messageManager;
          const listener=message=>{mm.removeMessageListener('YTDLProbe',listener);done(message.data);};
          mm.addMessageListener('YTDLProbe',listener);
          const code=`const d=content.document; sendAsyncMessage('YTDLProbe', {
            title:d.querySelector('#title')?.textContent,status:d.querySelector('#status')?.textContent,
            error:d.querySelector('#error')?.textContent,choices:[...d.querySelectorAll('#quality option')].map(x=>({value:x.value,text:x.textContent})),
            downloadDisabled:d.querySelector('#download')?.disabled});`;
          mm.loadFrameScript('data:application/javascript,'+encodeURIComponent(code),false);
        ''')
            if results['popup'].get('choices'): break
            time.sleep(.5)
        results['checks'].append({'case':'popup metadata and choices','result':'PASS' if results['popup'].get('title') == state['title'].removesuffix(' - YouTube') else 'FAIL'})
        results['checks'].append({'case':'live MP4 download availability','result':'PASS' if results['popup'].get('choices') else 'BLOCKED'})
        if DOWNLOAD_PROBE and results['popup'].get('choices'):
            download_started = time.perf_counter()
            m.execute_async_script('''const done=arguments[arguments.length-1],mm=document.querySelector('browser.webextension-popup-browser').messageManager;
              const listener=()=>{mm.removeMessageListener('YTDLClick',listener);done(true);};mm.addMessageListener('YTDLClick',listener);
              mm.loadFrameScript('data:application/javascript,'+encodeURIComponent(`const d=content.document;const options=[...d.querySelectorAll('#quality option')];d.querySelector('#quality').value=(options.find(o=>o.textContent.startsWith('${arguments[0]}p'))??options[0]).value;d.querySelector('#download').click();sendAsyncMessage('YTDLClick',true);`),false);''',script_args=[os.environ.get('QUALITY_HEIGHT','240')])
            if os.environ.get('CANCEL_PROBE')=='1':
                m.execute_async_script('''const done=arguments[arguments.length-1],mm=document.querySelector('browser.webextension-popup-browser').messageManager;
                  const listener=()=>{mm.removeMessageListener('YTDLCancel',listener);done(true);};mm.addMessageListener('YTDLCancel',listener);
                  mm.loadFrameScript('data:application/javascript,'+encodeURIComponent(`let ticks=0;const timer=content.setInterval(()=>{const b=content.document.querySelector('#cancel');if(!b.hidden&&!b.disabled||++ticks>100){content.clearInterval(timer);b.click();sendAsyncMessage('YTDLCancel',true);}},20);`),false);''')
            time.sleep(1)
            results['popupAfterClick'] = m.execute_async_script('''const done=arguments[arguments.length-1],mm=document.querySelector('browser.webextension-popup-browser').messageManager;
              const listener=m=>{mm.removeMessageListener('YTDLAfterClick',listener);done(m.data);};mm.addMessageListener('YTDLAfterClick',listener);
              mm.loadFrameScript('data:application/javascript,'+encodeURIComponent(`sendAsyncMessage('YTDLAfterClick',{status:content.document.querySelector('#status').textContent,error:content.document.querySelector('#error').textContent});`),false);''')
            m.set_context('content');m.switch_to_window(runner_handle)
            for _ in range(int(float(os.environ.get('DOWNLOAD_WAIT_SECONDS','45'))*2)):
                jobs=m.execute_async_script('''const done=arguments[arguments.length-1];window.wrappedJSObject.browser.storage.local.get('jobs').then(x=>done(x.jobs??[]));''')
                job=jobs[-1] if jobs else None
                if job and job['state'] in ['complete','failed','cancelled'] or results['popupAfterClick'].get('error'): break
                time.sleep(.5)
            results['downloadElapsedSeconds']=round(time.perf_counter()-download_started,2)
            results['downloadJob']=job
            expected=os.environ.get('EXPECTED_ERROR')
            passed=bool(job and (job['state']=='cancelled' if os.environ.get('CANCEL_PROBE')=='1' else job.get('error',{}).get('code')==expected if expected and job.get('error') else job['state']=='complete' and not expected))
            results['checks'].append({'case':('production popup cancellation without saved output' if os.environ.get('CANCEL_PROBE')=='1' else 'production popup download' + (' bounded failure: '+expected if expected else ' and MP4 save after popup closes')),'result':'PASS' if passed else 'FAIL'})
            if job and job.get('downloadId'):
                results['savedDownload']=m.execute_async_script('''const done=arguments[arguments.length-1];window.wrappedJSObject.browser.downloads.search({id:arguments[0]}).then(x=>done({filename:x[0].filename,bytes:x[0].fileSize,state:x[0].state}));''',script_args=[job['downloadId']])
                saved=Path(results['savedDownload']['filename'])
                assert saved.is_relative_to(OUT / 'downloads')
                decode=subprocess.run([str(ROOT/'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),'-v','error','-i',str(saved),'-f','null','-'],capture_output=True,text=True)
                results['checks'].append({'case':'independent full MP4 decode','result':'PASS' if decode.returncode==0 and not decode.stderr else 'FAIL'})
    except Exception as error:
        results['checks'].append({'case': 'live page/popup probe', 'result': 'FAIL', 'error': str(error)[:500]})
    m.set_context('chrome')
    results['consoleErrors'] = m.execute_script('''
      return Services.console.getMessageArray().filter(x=>x instanceof Ci.nsIScriptError &&
        /moz-extension/i.test(x.sourceName)).slice(-20).map(x=>({source:x.sourceName.split('?')[0],message:x.errorMessage.substring(0,500),line:x.lineNumber}));
    ''')
except Exception as error:
    results['fatal'] = str(error)[:1000]
finally:
    try: m.delete_session()
    except Exception: pass
    process.terminate()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired: process.kill()
    log.close()
    (OUT / 'smoke-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({key: results[key] for key in ['date', 'firefoxVersion', 'checks', 'popup', 'fatal'] if key in results}, ensure_ascii=True, indent=2), flush=True)
if results.get('fatal') or any(check['result'] == 'FAIL' for check in results['checks']): sys.exit(1)
if any(check['result'] == 'BLOCKED' for check in results['checks']): sys.exit(2)
