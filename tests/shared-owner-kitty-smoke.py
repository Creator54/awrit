"""Linux/Kitty owner integration smoke. Build bundles/preloads/toolbar first.

AWRIT_ELECTRON or electron on PATH is required; PROBE_REPO optionally tests a
relocated build. PROBE_LAUNCHER optionally tests an installed launcher instead of
Node directly. PROBE_ISOLATED=1 verifies an explicit profile is isolated.
"""
import os,json,time,tempfile,subprocess,threading,http.server,signal,socket,shutil
from urllib.parse import parse_qs, urlparse

electron=os.environ.get('AWRIT_ELECTRON') or shutil.which('electron')
if not electron:raise SystemExit('Provide AWRIT_ELECTRON or electron on PATH')
from pathlib import Path
root=Path(tempfile.mkdtemp(prefix='awrit-runtime-',dir='/tmp'));print(root,flush=True)
repo=Path(os.environ.get('PROBE_REPO',str(Path(__file__).resolve().parents[1])));(root/'home').mkdir()
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=b'''<body style="background:#164965;color:white;font:26px sans-serif"><input id="i"><div>PRODUCTION SHARED OWNER</div><script>i.focus();let t=performance.now();let before=sessionStorage.getItem('pane');sessionStorage.setItem('pane',location.pathname);let shared=localStorage.getItem('shared');localStorage.setItem('shared','yes');document.cookie='shared=yes;path=/';fetch('/state?'+new URLSearchParams({pane:location.pathname,ms:performance.now()-t,before,shared,cookie:document.cookie}));i.oninput=()=>fetch('/input?'+new URLSearchParams({pane:location.pathname,value:i.value}));window.onresize=()=>fetch('/resize?'+new URLSearchParams({pane:location.pathname,width:innerWidth,height:innerHeight}));setInterval(()=>document.body.style.background=Date.now()%1000<500?'#164965':'#654916',200);</script>'''
  if self.path.startswith(('/state?','/input?','/resize?')):
   with open(root/'page.log','a') as f:f.write(self.path+'\n')
  self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
s=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=s.serve_forever,daemon=True).start()
env={k:v for k,v in os.environ.items() if not k.startswith(('KITTY_','AWRIT_'))};env.update(HOME=str(root/'home'),XDG_CONFIG_HOME=str(root/'config'),XDG_DATA_HOME=str(root/'data'),AWRIT_ELECTRON=electron,AWRIT_OWNER_ENTRY=str(repo/'dist/browserOwner/main.js'),AWRIT_IPC_SOCKET=str(root/'agent.sock'))
endpoint='unix:'+str(root/'kitty.sock');log=open(root/'process.log','w');k=None
try:
 k=subprocess.Popen(['kitty','--config','NONE','-o','allow_remote_control=yes','-o','enabled_layouts=splits','--listen-on',endpoint,'sh','-c','sleep 180'],env=env,stdout=log,stderr=log)
 def rc(*args):
  r=subprocess.run(['kitten','@','--to',endpoint,*args],capture_output=True,text=True,timeout=5)
  if r.returncode:raise RuntimeError(r.stderr)
  return r.stdout
 for _ in range(60):
  try:source=json.loads(rc('ls'))[0]['tabs'][0]['windows'][0]['id'];break
  except Exception:time.sleep(.1)
 panes=[]
 for n in range(2):
  command=[os.environ['PROBE_LAUNCHER']] if os.environ.get('PROBE_LAUNCHER') else ['node',str(repo/'dist/terminal/main.js')]
  wid=rc('launch',f'--source-window=id:{source}','--location=vsplit',*(['--env=AWRIT_PROFILE='+str(root/'isolated-profile')] if n==1 and os.environ.get('PROBE_ISOLATED') else []),*command,f'http://127.0.0.1:{s.server_port}/pane{n+1}').strip();panes.append(wid);source=wid
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   if (root/'page.log').exists() and f'pane%2Fpane{n+1}' in (root/'page.log').read_text():break
   if (root/'page.log').exists() and f'pane=%2Fpane{n+1}' in (root/'page.log').read_text():break
   time.sleep(.05)
  else:raise RuntimeError('No page initialized')
  time.sleep(1)
 states=[line for line in (root/'page.log').read_text().splitlines() if line.startswith('/state?')]
 assert len(states)>=2,states
 assert ('shared=null' in states[1]) if os.environ.get('PROBE_ISOLATED') else ('shared=yes' in states[1]),states
 rc('send-text',f'--match=id:{panes[0]}','FIRST');rc('send-text',f'--match=id:{panes[1]}','SECOND');time.sleep(.5)
 rc('focus-window',f'--match=id:{panes[0]}');rc('resize-window',f'--match=id:{panes[0]}','--axis=horizontal','--increment=5');time.sleep(.7)
 def rpc(payload):
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
   peer.settimeout(5);peer.connect(str(root/'agent.sock'));peer.sendall((json.dumps(dict(payload,requestId='test'))+'\n').encode());data=b''
   while b'\n' not in data:data+=peer.recv(65536)
   return json.loads(data.split(b'\n')[0])
 ambiguous=rpc({'type':'capture:request'});assert ambiguous['ok'] is False and 'Ambiguous' in ambiguous['error'],ambiguous
 capture=rpc({'type':'capture:request','kittyWindowId':str(panes[1])});assert capture['ok'] and '/pane2' in capture['data']['url'],capture
 navigation=rpc({'type':'viewer:navigate','kittyWindowId':str(panes[1]),'target':f'http://127.0.0.1:{s.server_port}/navigated2'});assert navigation['ok'] and navigation['data']['navigated'],navigation
 first=rpc({'type':'capture:request','kittyWindowId':str(panes[0])});assert first['ok'] and '/pane1' in first['data']['url'],first
 if os.environ.get('PROBE_PAGES'):
  rc('send-key',f'--match=id:{panes[0]}','ctrl+t');time.sleep(1)
  new_page=rpc({'type':'viewer:navigate','kittyWindowId':str(panes[0]),'target':f'http://127.0.0.1:{s.server_port}/newpage1'});assert new_page['ok'],new_page
  time.sleep(.5)
  selected=rpc({'type':'capture:request','kittyWindowId':str(panes[0])});assert '/newpage1' in selected['data']['url'],selected
  sibling=rpc({'type':'capture:request','kittyWindowId':str(panes[1])});assert '/navigated2' in sibling['data']['url'],sibling
  rc('send-text',f'--match=id:{panes[0]}','\x1b[9;5u');time.sleep(.5)
  original=rpc({'type':'capture:request','kittyWindowId':str(panes[0])});assert '/pane1' in original['data']['url'],original.get('data',{}).get('url')
 time.sleep(.5)
 (root/'ipc-results.json').write_text(json.dumps({'ambiguous':ambiguous,'targeted':{k:v for k,v in capture['data'].items() if k!='base64'}},indent=2))
 rc('screenshot',str(root/'two-panes.png'))
 rc('close-window',f'--match=id:{panes[0]}');time.sleep(.5)
 rc('send-text',f'--match=id:{panes[1]}','SURVIVED');time.sleep(.5)
 entries=[(urlparse(line).path,parse_qs(urlparse(line).query)) for line in (root/'page.log').read_text().splitlines()]
 assert any(kind=='/input' and data.get('pane')==['/pane1'] and data.get('value')==['FIRST'] for kind,data in entries),entries
 assert any(kind=='/input' and data.get('pane')==['/pane2'] and data.get('value')==['SECOND'] for kind,data in entries),entries
 assert any(kind=='/input' and data.get('pane')==['/navigated2'] and data.get('value')==['SURVIVED'] for kind,data in entries),entries
 assert any(kind=='/resize' and data.get('pane')==['/pane1'] for kind,data in entries),entries
 assert any(kind=='/resize' and data.get('pane')==['/pane2'] for kind,data in entries),entries
 print((root/'page.log').read_text(),flush=True)
 rc('screenshot',str(root/'survivor.png'));rc('close-window',f'--match=id:{panes[1]}');time.sleep(2)
finally:
 if k is not None:
  k.terminate()
  try:k.wait(4)
  except subprocess.TimeoutExpired:k.kill();k.wait()
 s.shutdown();log.close();print('Evidence:',root,flush=True)
