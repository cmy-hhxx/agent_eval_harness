import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AssistantSessions,serveAssistant} from '@eval/runtime/assistant';
import {GatewayAssistantModels,modelIdentity} from '../../dist/apps/host/src/assistant-models.js';
import {assistantEndpoints} from '@eval/assistant/server';

const directory=await mkdtemp(tmpdir()+'/eris-model-channels-');
const model={provider:'gateway',model:'gpt-6-luna',baseUrl:'https://first.invalid/v1',api:'openai-responses',apiKeyEnv:'FIRST_TEST_KEY',thinking:'high',contextWindow:512000,maxOutputTokens:2048};
const openai={...model,provider:'openai',model:'',baseUrl:'https://second.invalid/v1',apiKeyEnv:'SECOND_TEST_KEY'};
const models=new GatewayAssistantModels(directory,model,[{name:'评测网关',model},{name:'OpenAI',model:openai}],async()=>['gpt-6-luna','gpt-5.6-luna','gpt-5.6-luna-deeptopic-0825','gpt-6-sol','deepseek-chat'].map(id=>({id,name:id})));
await models.favorites('local',[modelIdentity('gateway','gpt-5.6-luna')]);
const used=[];
const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(new AssistantSessions({
 directory,url,model,models,systemPrompt:'test',tools:[],driver:async({model,event})=>({
  async prompt(text){
   used.push(model);
   await event({type:'agent_start'});await event({type:'turn_start'});
   await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
   await event({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'渠道选择成功'}],stopReason:'stop'}});
   await event({type:'turn_end'});await event({type:'agent_end'});
  },async steer(){},async abort(){},async dispose(){},
 }),
}))});
let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:960},locale:'zh-CN'});
 await page.goto(server.url);
 const input=page.locator('[contenteditable=true]');await input.waitFor();
 await page.getByRole('button',{name:/gpt-5.6-luna/}).click();
 await page.getByRole('menuitem',{name:/^模型/}).click();
 await page.getByText('OpenAI',{exact:true}).waitFor();
 assert.equal(await page.getByRole('menuitemradio').count(),10,'favorites from one channel must not hide another channel');
 assert.equal(await page.getByRole('menuitemradio',{name:'deepseek-chat',exact:true}).count(),2,'configured DeepSeek models remain selectable');
 assert.equal((await page.getByRole('menuitemradio').allTextContents())[0],'gpt-5.6-luna','favorites stay first within their channel');
 await page.getByRole('searchbox',{name:'搜索模型…',exact:true}).fill('gpt-6-luna');
 assert.equal(await page.getByRole('menuitemradio',{name:'gpt-6-luna',exact:true}).count(),2,'identical model IDs remain independently selectable among fuzzy matches');
 await page.getByRole('menuitemradio',{name:'gpt-6-luna',exact:true}).nth(1).click();
 await input.fill('验证渠道');await input.press('Enter');
 await page.getByText('渠道选择成功',{exact:true}).waitFor();
 assert.equal(used.length,1);assert.equal(used[0].provider,'openai');
 assert.equal(used[0].baseUrl,openai.baseUrl);assert.equal(used[0].apiKeyEnv,openai.apiKeyEnv);
 await page.reload();await page.getByRole('button',{name:/gpt-6-luna/}).waitFor();
 await page.getByRole('button',{name:/gpt-6-luna/}).click();await page.getByRole('menuitem',{name:/^模型/}).click();
 assert.equal(await page.getByRole('menuitemradio',{name:'gpt-6-luna',exact:true}).nth(1).getAttribute('aria-checked'),'true');
 console.log('Channel picker, favorite ordering, same-name routing and reload: passed');
} finally {await browser?.close();await server.close();await rm(directory,{recursive:true,force:true});}
