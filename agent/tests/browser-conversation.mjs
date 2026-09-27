import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {AssistantSessions,serveAssistant} from '@eval/runtime/assistant';
import {GatewayAssistantModels} from '../../dist/apps/host/src/assistant-models.js';
import {assistantEndpoints} from '@eval/assistant/server';
const directory=await mkdtemp(tmpdir()+'/assistant-conversation-');
const shots=process.cwd()+'/.artifacts/agent-conversation';await mkdir(shots,{recursive:true});
const config={provider:'gateway',model:'analysis-a',thinking:'low',contextWindow:32000,maxOutputTokens:2048};
const models=new GatewayAssistantModels(directory,config,async()=>[{id:'analysis-a',name:'analysis-a'},{id:'analysis-b',name:'analysis-b'}]);
const selected=[];
const thinkingGate=Promise.withResolvers();
const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(new AssistantSessions({directory,url,model:config,models,systemPrompt:'test',tools:[],driver:async({event,model})=>({
 async prompt(text){
  selected.push(model);const callId="lookup-"+selected.length;
  await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
  await event({type:'message_start',message:{role:'assistant'}});
  const tagged='<think>先核对引用，再查询正式结果。</think>';
  for(const delta of ['<thi','nk>先核对引用，','再查询正式结果。</thi','nk>']){
   await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});await delay(40);
  }
  if (selected.length === 1) await thinkingGate.promise;
  await event({type:'message_end',message:{role:'assistant',provider:'gateway',model:model.model,usage:{input:90,output:20,cacheRead:10,cacheWrite:0,totalTokens:120},content:[{type:'text',text:tagged},{type:'toolCall',id:callId,name:'list_data',arguments:{limit:5}}],stopReason:'toolUse'}});
  await event({type:'tool_execution_start',toolCallId:callId,toolName:'list_data',args:{limit:5}});await delay(150);
  await event({type:'message_end',message:{role:'toolResult',toolCallId:callId,content:[{type:'text',text:'{"items":[{"runId":"run-alpha","accepted":12}],"total":1}'}],isError:false}});
  await event({type:'turn_end'});await event({type:'turn_start'});await event({type:'message_start',message:{role:'assistant'}});
  await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'## 查询完成\n\n共有 12 条正式结果。'}});
  await event({type:'message_end',message:{role:'assistant',provider:'gateway',model:model.model,usage:{input:90,output:20,cacheRead:10,cacheWrite:0,totalTokens:120},content:[{type:'text',text:'## 查询完成\n\n共有 12 条正式结果。'}],stopReason:'stop'}});
  await event({type:'turn_end'});await event({type:'agent_end'});
 },async steer(){},async abort(){},async dispose(){}
})}))});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 page.setDefaultTimeout(10000);
 await page.goto(server.url);const input=page.locator('[contenteditable=true]');await input.fill('查询评测结果');await input.press('Enter');
 await page.getByRole('button', {name:/^正在分析，用时/}).waitFor();
 assert(!(await page.locator('body').innerText()).includes('深度求索'));
 thinkingGate.resolve();
 await page.getByRole('heading',{name:'查询完成',exact:true}).waitFor();await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});await delay(200);
 await page.screenshot({path:shots+'/conversation.png',fullPage:true});
 assert((await page.locator('body').innerText()).includes('240 tok'));
 assert((await page.locator('body').innerText()).includes('缓存命中 10%'));
 assert.equal(await page.locator('[data-variant=think]').count(),1,'reasoning must use the upstream collapsible reasoning row');
 assert.equal(await page.getByRole('button',{name:/analysis-a/}).count(),1,'the configured gateway model must have an upstream selection control');

 // The upstream Turn process owns both the thought and the business tool.
 await page.locator('[data-turn-process]').click();
 await page.locator('[data-process-activity][aria-expanded=false]').first().click();
 const thinking=page.locator('[data-variant=think]');await thinking.waitFor({state:'visible'});
 await thinking.getByRole('button').first().click();
 await thinking.getByText('先核对引用，再查询正式结果。',{exact:true}).last().waitFor();
 assert(!(await page.locator('body').innerText()).includes('<think>'));
 await page.getByRole('button',{name:/查询评测数据/}).first().click();
 await page.getByText('run-alpha',{exact:true}).first().waitFor();
 await page.screenshot({path:shots+'/conversation-expanded.png',fullPage:true});
 await page.getByRole('button',{name:'设置',exact:true}).click();
 const settings=page.getByRole('dialog',{name:'设置',exact:true});
 await settings.getByText('语言',{exact:true}).waitFor();
 assert.equal(await settings.getByText('外观',{exact:true}).count(),0);
 await settings.getByRole('button',{name:'增大字号',exact:true}).click();
 await settings.getByRole('button',{name:'排队发送',exact:true}).click();
 await page.getByRole('menuitem',{name:'插话发送',exact:true}).click();
 await settings.getByRole('button',{name:'插话发送',exact:true}).waitFor();
 await page.waitForFunction(()=>document.body.style.getPropertyValue('--dsh-content-font-size')==='15px');
 await settings.getByRole('button',{name:'标准',exact:true}).click();
 await page.getByRole('menuitem',{name:'完全展开',exact:true}).click();
 await settings.getByRole('button',{name:'详细',exact:true}).click();
 await page.getByRole('menuitem',{name:'简洁',exact:true}).click();
 await settings.getByRole('button',{name:'中文',exact:true}).click();
 await page.getByRole('menuitem',{name:'English',exact:true}).click();
 await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 await page.reload();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Steer',exact:true}).waitFor();
 await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Verbose',exact:true}).waitFor();
 await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Compact',exact:true}).waitFor();
 await page.waitForFunction(()=>document.body.style.getPropertyValue('--dsh-content-font-size')==='15px');
 await page.getByRole('button',{name:'English',exact:true}).click();
 await page.getByRole('menuitem',{name:'中文',exact:true}).click();
 await settings.waitFor();
 await page.screenshot({path:shots+'/settings-general.png',fullPage:true});
 await page.setViewportSize({width:768,height:900});
 await page.screenshot({path:shots+'/settings-narrow.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await settings.getByRole('button',{name:'常用模型',exact:true}).click();
 await page.getByRole('button',{name:'勾选常用模型',exact:true}).click();
 const picker=page.getByRole('dialog').last();
 assert(await picker.getByRole('checkbox',{name:'analysis-a',exact:true}).isChecked());
 await picker.getByRole('checkbox',{name:'analysis-b',exact:true}).check();
 await picker.getByRole('button',{name:'保存选择',exact:true}).click();
 await settings.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:/analysis-a/}).click();
 await page.getByRole('menuitem',{name:/^模型/}).click();
 await page.getByRole('menuitemradio',{name:'analysis-b',exact:true}).click();
 await page.getByRole('button',{name:/analysis-b/}).waitFor();
 await page.getByRole('button',{name:/analysis-b/}).click();
 await page.getByRole('menuitem',{name:/推理等级/}).click();
 await page.getByRole('menuitemradio',{name:'high',exact:true}).click();
 await page.getByRole('button',{name:/analysis-b.*high/}).waitFor();
 await page.reload();await page.getByRole('button',{name:/analysis-b.*high/}).waitFor();
 await page.locator('[contenteditable=true]').fill('再次查询');await page.locator('[contenteditable=true]').press('Enter');
 await page.getByRole('heading',{name:'查询完成',exact:true}).nth(1).waitFor();assert.equal(selected.at(-1).model,'analysis-b');assert.equal(selected.at(-1).thinking,'high');
 assert.deepEqual(errors,[]);
 console.log('Gateway favorites, model selection, reasoning, structured tools, usage and reload: passed');

}finally{thinkingGate.resolve();await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
