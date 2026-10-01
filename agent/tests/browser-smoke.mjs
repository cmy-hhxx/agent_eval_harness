import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { serveAssistant, AssistantSessions } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';
const directory=await mkdtemp(tmpdir()+'/assistant-browser-'),shots=process.cwd()+'/.artifacts/agent-browser';
await mkdir(shots,{recursive:true});
let executions=0,sessions;
const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(sessions=new AssistantSessions({directory,url,model:{provider:'test',model:'test'},systemPrompt:'test',tools:[],driver:async({event})=>{
 let stopped=false;
 return {async prompt(text){
  executions++;stopped=false;
  await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
  await event({type:'message_start',message:{role:'assistant'}});
  let output='';const chunks=text==='停止测试'?Array.from({length:300},()=> '进行中 '):['## 分析结果\n\n','证据一致。\n\n','```ts\n','const accepted = true;\n','```\n'];
  for(const delta of chunks){if(stopped)break;output+=delta;await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});await delay(40);}
  await event({type:'message_end',message:{role:'assistant',provider:'test',model:'test',content:[{type:'text',text:output}],stopReason:stopped?'aborted':'stop'}});
  await event({type:'turn_end'});await event({type:'agent_end'});
 },async steer(){},async abort(){stopped=true;},async dispose(){}};
}}))});
let browser,referenceServer;
try{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'dark',locale:'zh-CN'}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(server.url);const input=page.locator('[contenteditable=true]');await input.waitFor();
 assert.equal(await page.evaluate(()=>'dshDesktop' in globalThis),false,'the Web product does not expose a desktop bridge');
 assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'),null);
 assert.equal(await page.title(),'新对话 — Eris');
 const marks=page.locator('img[data-brand=eris]');
 assert.equal(await marks.count(),2,'the sidebar and empty hero both display the original Eris mark');
 assert(await marks.evaluateAll(images=>images.every(img=>img.complete && img.naturalWidth>0)));
 await page.getByText('Eris',{exact:true}).last().waitFor();
 await page.evaluate(()=>new Promise((resolve,reject)=>{const icon=new Image();icon.onload=resolve;icon.onerror=()=>reject(new Error('Eris favicon did not load'));icon.src=document.querySelector('link[rel=icon]').href;}));
 await page.screenshot({path:shots+'/eris-welcome.png',fullPage:true,animations:'disabled',caret:'hide'});
 assert(!/DeepSeek|Harness/.test(await page.locator('body').innerText()));
 await input.fill('请分析本地评测结果');await input.press('Enter');
 await page.getByRole('heading',{name:'分析结果',exact:true}).waitFor();
 await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
 await page.locator('code').filter({hasText:'const accepted'}).first().waitFor();
 await page.emulateMedia({colorScheme:'light'});await page.emulateMedia({colorScheme:'dark'});
 assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'),null);
 const before=executions;await page.reload();await page.getByRole('heading',{name:'分析结果',exact:true}).waitFor();assert.equal(executions,before);
 await page.screenshot({path:shots+'/assistant-light.png',fullPage:true,animations:'disabled',caret:'hide'});
 // Compare the unmodified upstream baseline with identical Session events.
 // Composer copy and unavailable controls are explicit product differences.
 if(process.env.AGENT_VISUAL_REFERENCE==='1'){
  referenceServer=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/reference-web',endpoints:url=>assistantEndpoints(new AssistantSessions({...sessions.options,url}))});
  const reference=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'light',locale:'zh-CN'});
  const now=Date.now()+120000;await page.clock.setFixedTime(now);await reference.clock.setFixedTime(now);
  await page.emulateMedia({colorScheme:'light'});await reference.goto(referenceServer.url);
  await reference.getByRole('treeitem').filter({hasText:'请分析本地评测结果'}).last().click();
  await reference.getByRole('heading',{name:'分析结果',exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);await reference.evaluate(()=>document.fonts.ready);
  await page.mouse.move(1400,950);await reference.mouse.move(1400,950);await delay(500);
  const options={clip:{x:0,y:0,width:1440,height:720},animations:'disabled',caret:'hide'};
  const actual=await page.screenshot({...options,path:shots+'/product.png'});
  const original=await reference.screenshot({...options,path:shots+'/upstream.png'});
  assert(actual.equals(original),'sidebar, header, conversation, Markdown and code-block pixels must match the upstream light UI');
  await reference.close();
 }
 await input.fill('停止测试');await input.press('Enter');await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({timeout:5000}).catch(async error=>{console.log(await page.locator('body').innerText(),await sessions.list('local'),executions,errors);throw error;});await delay(150);await page.getByRole('button',{name:'停止生成',exact:true}).click();await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
 const bob=await browser.newPage();await bob.goto(server.url+'/u/bob/');await bob.locator('[contenteditable=true]').waitFor();assert(! (await bob.locator('body').innerText()).includes('请分析本地评测结果'));await bob.close();
 assert.deepEqual(errors,[]);await writeFile(shots+'/result.json',JSON.stringify({light:true,erisBrand:true,noDeepseekLogo:true,stream:true,markdown:true,refresh:true,stop:true,userIsolation:true,visualReference:process.env.AGENT_VISUAL_REFERENCE==='1'},null,2));
 console.log('Browser checks passed; artifacts: '+shots);
}finally{await browser?.close();await referenceServer?.close();await server.close();await rm(directory,{recursive:true,force:true});}
