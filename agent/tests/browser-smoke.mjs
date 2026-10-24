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
const quoted='“消息出现时上涨、随后快速回吐”';
let releaseQuote;
const quotePause=new Promise(resolve=>{releaseQuote=resolve;});
const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(sessions=new AssistantSessions({directory,url,model:{provider:'test',model:'test'},systemPrompt:'test',tools:[],driver:async({event})=>{
 let stopped=false;
 return {async prompt(text){
  executions++;stopped=false;
  await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
  if(text==='请分析本地评测结果'){
   const args={view:'statistics'},callId='statistics';
   await event({type:'message_start',message:{role:'assistant'}});
   await event({type:'message_end',message:{role:'assistant',provider:'test',model:'test',content:[{type:'toolCall',id:callId,name:'list_data',arguments:args}],stopReason:'toolUse'}});
   await event({type:'tool_execution_start',toolCallId:callId,toolName:'list_data',args});
   await event({type:'message_end',message:{role:'toolResult',toolCallId:callId,content:[{type:'text',text:JSON.stringify({kind:'statistics',history:{status:'published',snapshotAt:'2026-10-12 12:16:54.950',requestDates:['2026-09-22','2026-10-11'],caseCount:12114,totalCaseCount:20554,progress:{completedBattleCount:22293,expectedBattleCount:35838,completedCaseCount:11753,battleCompletionRate:62.2,caseCompletionRate:57.18}},currentRuns:[],additive:false})}],isError:false}});
   await event({type:'turn_end'});await event({type:'turn_start'});
  }
  await event({type:'message_start',message:{role:'assistant'}});
  let output='';const chunks=text==='停止测试'?Array.from({length:300},()=> '进行中 '):['## 分析结果\n\n','证据一致。\n\n','所以，B的判断主要是把**',quoted+'**','当作题材交易兑现的行情信号。\n\n','| 指标 | 已完成 | 完成率 |\n','| --- | ---: | ---: |\n','| 对战 | 22,293 | 62.20% |\n','| 题目 | 11,753 | 57.18% |\n\n','```ts\n','const accepted = true;\n','```\n'];
  for(const delta of chunks){if(stopped)break;output+=delta;await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});if(delta===quoted+'**')await quotePause;await delay(40);}
  await event({type:'message_end',message:{role:'assistant',provider:'test',model:'test',content:[{type:'text',text:output}],stopReason:stopped?'aborted':'stop'}});
  await event({type:'turn_end'});await event({type:'agent_end'});
 },async steer(){},async abort(){stopped=true;},async dispose(){}};
}}))});
let browser,referenceServer;
try{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'dark',locale:'zh-CN'}),errors=[],assetRequests=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('request',request=>{if(request.method()==='POST'&&/upload/i.test(request.url()))assetRequests.push(request.url());});
 await page.goto(server.url);const input=page.locator('[contenteditable=true]');await input.waitFor();
 await input.evaluate(element=>{
  const transfer=new DataTransfer();transfer.items.add(new File(['synthetic source'],'eris-intake-check.png',{type:'image/png'}));
  element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  element.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
 });
 await delay(100);
 assert.equal(await input.innerText(),'','paste and drop cannot add files to the read-only composer');
 assert.equal(await page.getByRole('button',{name:/eris-intake-check/}).count(),0,'no attachment preview enters the draft');
 assert.deepEqual(assetRequests,[],'disabled attachment intake sends no asset uploads');
 assert.equal(executions,0,'attachment gestures do not submit a prompt');
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
 const strong=page.locator('strong').filter({hasText:quoted});
 await strong.waitFor();
 assert.equal(await strong.innerText(),quoted,'quoted Chinese text is bold before the streamed reply completes');
 assert(await page.getByRole('button',{name:'停止生成',exact:true}).isVisible());
 releaseQuote();
 await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
 assert.equal(await strong.locator('xpath=ancestor::p[1]').innerText(),'所以，B的判断主要是把'+quoted+'当作题材交易兑现的行情信号。','strong markers do not leak into the final prose');
 await page.locator('code').filter({hasText:'const accepted'}).first().waitFor();
 assert.equal(await page.getByRole('table').getByRole('row').count(),3,'streamed statistics Markdown renders as a table');
 await page.emulateMedia({colorScheme:'light'});await page.emulateMedia({colorScheme:'dark'});
 assert.equal(await page.locator('body').getAttribute('data-ds-dark-theme'),null);
 const before=executions;await page.reload();await page.getByRole('heading',{name:'分析结果',exact:true}).waitFor();assert.equal(executions,before);
 assert.equal(await strong.innerText(),quoted,'history preserves quoted Chinese strong emphasis');
 assert.equal(await page.getByRole('table').getByRole('cell',{name:'62.20%',exact:true}).count(),1,'history preserves the statistics table');
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
 await page.locator('[data-turn-process]').click();
 await page.locator('[data-process-activity][aria-expanded=false]').first().click();
 const statistics=page.locator('[data-tool=list_data]');
 await statistics.getByRole('button').first().click();
 await statistics.getByText('历史累计',{exact:true}).waitFor();
 for(const width of [1440,375]){
  await page.setViewportSize({width,height:960});
  await statistics.hover();
  const card=statistics.locator('[data-inspect]');
  const button=statistics.getByRole('button',{name:'查看',exact:true});
  await button.waitFor();
  const bounds=await card.boundingBox(),inspect=await button.boundingBox();
  assert(bounds.height>100,'statistics card contains visible progress rows');
  assert(inspect.x>=bounds.x&&inspect.y>=bounds.y&&inspect.x+inspect.width<=bounds.x+bounds.width&&inspect.y+inspect.height<=bounds.y+bounds.height,'the inspect button stays inside the statistics card');
  assert.equal(await card.locator('li').evaluateAll(items=>items.some(item=>!item.textContent.trim())),false,'statistics details have no empty items');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'statistics do not overflow the page');
  await statistics.screenshot({path:shots+`/statistics-${width}.png`,animations:'disabled',caret:'hide'});
 }
 assert.equal(executions,before,'opening historical statistics never invokes the model');
 await page.setViewportSize({width:1440,height:960});
 await page.locator('[data-turn-process]').click();
 await input.fill('停止测试');await input.press('Enter');await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({timeout:5000}).catch(async error=>{console.log(await page.locator('body').innerText(),await sessions.list('local'),executions,errors);throw error;});await delay(150);await page.getByRole('button',{name:'停止生成',exact:true}).click();await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
 const bob=await browser.newPage();await bob.goto(server.url+'/u/bob/');await bob.locator('[contenteditable=true]').waitFor();assert(! (await bob.locator('body').innerText()).includes('请分析本地评测结果'));await bob.close();
 assert.deepEqual(errors,[]);await writeFile(shots+'/result.json',JSON.stringify({light:true,erisBrand:true,noDeepseekLogo:true,stream:true,markdown:true,refresh:true,stop:true,userIsolation:true,visualReference:process.env.AGENT_VISUAL_REFERENCE==='1'},null,2));
 console.log('Browser checks passed; artifacts: '+shots);
}finally{releaseQuote();await browser?.close();await referenceServer?.close();await server.close();await rm(directory,{recursive:true,force:true});}
