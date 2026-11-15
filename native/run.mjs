import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PipeCdp } from './pipe.mjs';
const repo=process.env.PROOF_REPO ?? process.cwd();
const { launchArguments, launchEnvironment, SHELL_PREFIX }=await import(pathToFileURL(join(repo,'apps/linux/scripts/acceptance/lib/ardia.mjs')));
const { pipeLaunchArguments }=await import(pathToFileURL(join(repo,'scripts/linux/smoke.mjs')));
const { writeProfileSeed, sessionSeed }=await import(pathToFileURL(join(repo,'apps/linux/scripts/acceptance/lib/seed.mjs')));
const { until }=await import(pathToFileURL(join(repo,'apps/linux/scripts/acceptance/lib/util.mjs')));
const exec = promisify(execFile);
const root=process.env.PROOF_ROOT ?? '/tmp/ardia-1962-native';
const profile=root+'/profile';
const python=process.env.PROOF_PYTHON ?? '/tmp/ardia-1962-socket-proof/venv/bin/python';
await mkdir(root,{recursive:true});
await exec(python,['-c',`from pathlib import Path; import shutil,subprocess; repo=Path(${JSON.stringify(repo)}); root=Path(${JSON.stringify(root)}); shutil.copytree(repo/'apps/cli/ardia_cli',root/'before/ardia_cli',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__')); (root/'before/ardia_cli/control.py').write_bytes(subprocess.check_output(['git','-C',str(repo),'show','1f6f0bb01:apps/cli/ardia_cli/control.py']))`]);
const records=[];
const fixture=createServer((req,res)=>{
res.writeHead(200,{'Content-Type':'text/html'});
res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ardia Linux socket proof</title><style>body{font:24px sans-serif;padding:32px;background:#f3f5f7;color:#123}strong{display:block;color:#17623a;margin:24px 0}code{font-size:28px}</style><h1>Ardia Linux socket proof</h1><p>Actual Linux Ardia browser. Local test page.</p><strong id="size"></strong><pre id="proof" style="font-size:18px;white-space:pre-wrap">CLI verification is running...</pre><p>The CLI should resize its own offscreen tab to 390 x 844.</p><script>function show(){document.querySelector("#size").textContent=innerWidth+" x "+innerHeight}addEventListener("resize",show);show()</script>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${fixture.address().port}/`;
await mkdir(profile+'/home',{recursive:true});
await writeProfileSeed(profile,{session:sessionSeed({windows:[{id:'main',urls:[url]}],settings:{cliControl:true}}),documents:{'telemetry.json':JSON.stringify({sharing:false,askedAt:1})}});
const args=pipeLaunchArguments(launchArguments({scratch:profile,uiDir:process.env.PROOF_UI,ozone:process.env.PROOF_OZONE??"headless"}));
const log=openSync(root+'/browser-private.log','w');
const child=spawn(process.env.PROOF_EXECUTABLE ?? '/usr/bin/ardia',args,{env:launchEnvironment({scratch:profile,env:process.env.PROOF_OZONE==="x11"?{DISPLAY:process.env.DISPLAY}: {}}),stdio:['ignore',log,log,'pipe','pipe'],detached:true});
closeSync(log);
let exited=false;
child.on('exit',()=>exited=true);
const cdp=new PipeCdp(child);
async function cli(stage,args){
const env={...process.env,HOME:root+'/cli-home-'+stage,XDG_CONFIG_HOME:root+'/cli-home-'+stage+'/.config',XDG_STATE_HOME:root+'/cli-home-'+stage+'/.local/state',ARDIA_DATA_DIR:profile,ARDIA_WS:'',ARDIA_PORT:'',ARDIA_CDP_URL:'',ARDIA_TELEMETRY:'off',DO_NOT_TRACK:'1',PYTHONPATH:stage==='before'?root+'/before':join(repo,'apps/cli')};
await mkdir(env.HOME,{recursive:true});
let result;
try{result=await exec(python,['-m','ardia_cli','browse','--session','socket-'+stage,'--json',...args],{env,timeout:45000,maxBuffer:4*1024*1024});result.code=0;}
catch(error){result={stdout:error.stdout??'',stderr:error.stderr??'',code:error.code};}
let json;try{json=JSON.parse(result.stdout);}catch{}
const record={stage,args,exit:result.code,stdout:result.stdout,stderr:result.stderr,json};
records.push(record);await writeFile(root+'/commands.json',JSON.stringify(records,null,2));
console.log(JSON.stringify(record));
return record;
}
try{
const shell=await until(async()=>{
const {targetInfos}=await cdp.send('Target.getTargets');
for(const target of targetInfos.filter(t=>t.type==='page'&&t.url.startsWith(SHELL_PREFIX))){
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
if(await cdp.evaluate(sessionId,'!!globalThis.ardiaLinux?.store && !!document.querySelector("[data-ardia-linux-window]")').catch(()=>false))return {sessionId,target};
await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});
}
return false;
},{timeout:60000,interval:300,label:'native Ardia shell',abort:()=>exited?'browser exited':null});
console.log('Native shell ready');
console.log('Native version', await cdp.send('Browser.getVersion'));
console.log('Capabilities', (await cdp.evaluate(shell.sessionId,'globalThis.__ardiaHost.bootstrap.capabilities')).filter(x=>/cliTab|cliOffscreen|cliTake/.test(x))); 
await cdp.evaluate(shell.sessionId,'ardiaLinux.store.getState().updateSettings({cliControl:true}),true');
await until(()=>readFile(profile+'/ArdiaControl.json','utf8').then(()=>true).catch(()=>false),{timeout:20000,label:'native control discovery',abort:()=>exited?'browser exited':null});
await until(async()=>{const {targetInfos}=await cdp.send('Target.getTargets');return targetInfos.some(t=>t.type==='page'&&t.url===url&&t.title==='Ardia Linux socket proof');},{timeout:20000,label:'local page load'});
const {data:shellImage}=await cdp.send('Page.captureScreenshot',{format:'png'},shell.sessionId);
await writeFile(root+'/native-shell.png',Buffer.from(shellImage,'base64'));
console.log('Control windows', await exec(python,['-m','ardia_cli','windows','--data-dir',profile,'--json'],{env:{...process.env,PYTHONPATH:join(repo,'apps/cli'),DO_NOT_TRACK:'1'},timeout:15000}).catch(e=>({stdout:e.stdout,stderr:e.stderr,code:e.code})));
for(const stage of ['before','after']){
assert.equal((await cli(stage,['open',url])).exit,0);
const listed=await cli(stage,['tab','list']);
assert.equal(listed.exit,0);
if(stage==='before')assert.ok(listed.json.data.tabs.every(t=>t.appTabId===null));
else assert.ok(listed.json.data.tabs.some(t=>typeof t.appTabId==='string'), 'fixed CLI must map native tabs');
const viewport=await cli(stage,['set','viewport','390','844']);
if(stage==='before'){assert.notEqual(viewport.exit,0,'original source must fail viewport setup');assert.equal(viewport.json.code,'viewport_needs_hidden_tab');}
else{
assert.equal(viewport.exit,0,'fixed source must set viewport');
const dimensions=await cli(stage,['eval','({width:innerWidth,height:innerHeight,title:document.title})']);
assert.equal(dimensions.exit,0);
assert.deepEqual(dimensions.json.data.result,{width:390,height:844,title:'Ardia Linux socket proof'});
const own=listed.json.data.tabs.find(t=>t.openedBySession);
const seed=listed.json.data.tabs.find(t=>t.appTabId==='main-tab-0');
const {sessionId:seedSession}=await cdp.send('Target.attachToTarget',{targetId:seed.targetId,flatten:true});
const readback=dimensions.json.data.result;
await cdp.evaluate(seedSession,`document.getElementById('proof').textContent=${JSON.stringify('BEFORE: appTabId = null; viewport_needs_hidden_tab\nAFTER: appTabId = '+own.appTabId+'\nset viewport: success\nActual offscreen page readback: '+readback.width+' x '+readback.height+'\nPASS: socket fix verified against native Linux Ardia')};true`);
await until(()=>cdp.evaluate(seedSession,'document.getElementById("proof").textContent.includes("PASS:")'),{timeout:3000,label:'native proof page'});
if(process.env.PROOF_OZONE==='x11'){
await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x1200','-i',process.env.DISPLAY,'-frames:v','1',root+'/native-browser-proof.png'],{timeout:15000});
console.log('Captured actual native browser on isolated Xvfb display');
}
await cdp.send('Target.detachFromTarget',{sessionId:seedSession});
}
await cli(stage,['close']);
}
console.log('PASS: original CLI fails; fixed CLI maps and resizes a real Ardia tab; viewport readback matches.');
}finally{
for(const stage of ['before','after'])await cli(stage,['close','--all']).catch(()=>{});
await cdp.send('Browser.close').catch(()=>{});
await until(()=>exited,{timeout:10000,label:'native browser to exit'}).catch(()=>{if(!exited)process.kill(-child.pid,'SIGTERM');});
fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
