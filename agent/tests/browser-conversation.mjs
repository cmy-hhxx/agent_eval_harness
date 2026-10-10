import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {AssistantSessions,serveAssistant} from '@eval/runtime/assistant';
import {readAssistantPreferences} from '@eval/data';
import {GatewayAssistantModels,modelIdentity} from '../../dist/apps/host/src/assistant-models.js';
import {chartTemplates} from '../src/client/chart-templates.js';
import {assistantEndpoints} from '@eval/assistant/server';
const directory=await mkdtemp(tmpdir()+'/assistant-conversation-');
const shots=process.cwd()+'/.artifacts/agent-conversation';await mkdir(shots,{recursive:true});
const config={provider:'gateway',model:'gpt-6-luna',thinking:'low',contextWindow:512000,maxOutputTokens:2048};
const modelIds=['gpt-6-luna','gpt-5.6-luna','gpt-6-luna-preview','gpt-6-luna-fast','gpt-6-luna-latest','gpt-5.6-luna-deeptopic-0825'];
const lunaName='Luna Deeptopic';
const luna={...config,provider:'openai',model:'gpt-5.6-luna-deeptopic-0825',thinking:'high'};
const models=new GatewayAssistantModels(directory,config,[{name:'评测网关',model:config},{name:'OpenAI',model:luna,models:[{id:luna.model,name:lunaName}],efforts:['off','low','high','max']}],async config=>(config.provider==='openai'?[luna.model]:modelIds.slice(0,-1)).map(id=>({id,name:id})));
const selected=[];
let sourceReads=0;let sourceAvailable=true;
let webSearches=0;let webReads=0;
let chartDisplays=0;
const chartData={type:'pie',title:'FAST：已裁决胜场',scope:'已裁决的 11 场 FAST 对战',unit:'场',source:'正式对比结果',categories:['A组Fast','B组Fast'],series:[{name:'胜场',values:[6,5]}]};
const templateExamples={
 '时间趋势':{type:'line',title:'时间趋势（测试示例）',scope:'离线测试；2026-01-01 至 2026-01-21',unit:'示例值',source:'浏览器测试数据，非评测结论',categories:['2026-01-01','2026-01-02','2026-01-03','2026-01-11','2026-01-21'],series:[{name:'A组Fast',values:[1.25,1.35,null,1.42,1.6]},{name:'B组Fast',values:[1.1,null,1.45,1.3,1.5]}]},
 '结果组成':{type:'pie',title:'结果组成（测试示例）',scope:'离线测试；12 条互斥示例记录',unit:'条',source:'浏览器测试数据，非评测结论',categories:['A组胜','B组胜','双方均好','双方均差','待定'],series:[{name:'组成',values:[5,3,2,2,0]}]},
};
templateExamples['多系列趋势']={...templateExamples['时间趋势'],title:'多系列趋势（测试示例）',series:[templateExamples['时间趋势'].series[1],templateExamples['时间趋势'].series[0],{name:'C组Fast',values:[1.7,1.75,1.8,1.85,1.9]},{name:'参照Fast',values:[.8,.85,.9,.95,1]}]};
templateExamples['长数字组成']={type:'pie',title:'长数字组成（测试示例）',scope:'离线测试；长数值与极小非零类别，不代表真实场数',unit:'示例值',source:'浏览器测试数据，非评测结论',categories:['双方均差','经营现金流与利润口径不一致且关键推导缺失'.repeat(4),'A组胜','双方均好'],series:[{name:'组成',values:[1,999999999999999.9,1,0]}]};
templateExamples['问题矩阵']={type:'heatmap',title:'问题矩阵（测试示例）',scope:'离线测试；相同三个检查项',unit:'次',source:'浏览器测试数据，非评测结论',categories:['事实','来源','格式'],series:[{name:'A组Fast',values:[3,0,5]},{name:'B组Fast',values:[2,null,8]}],annotations:[{categoryIndex:2,seriesIndex:1,note:'格式问题较多'}]};
templateExamples['双档战绩']={type:'heatmap',title:'两档正式对战结果',scope:'离线测试；相同结果分类',unit:'场',source:'浏览器测试数据，非评测结论',categories:['Fast','Expert'],series:[{name:'A组胜',values:[56,104]},{name:'B组胜',values:[96,81]},{name:'双方都好',values:[61,49]},{name:'双方都差',values:[11,13]}]};
const modelColors={'A组Fast':'rgb(30, 78, 140)','B组Fast':'rgb(242, 95, 59)','C组Fast':'rgb(107, 127, 106)','参照Fast':'rgb(71, 118, 168)'};
const chartTool={name:'show_chart',readOnly:true,description:'Show structured chart',inputSchema:{type:'object'},execute:async(chart=chartData)=>{chartDisplays++;return {content:[{type:'text',text:JSON.stringify({kind:'chart',chart})}]};}};
const searchArgs={queries:[{query:'央行政策利率公告',domains:['pbc.gov.cn']},{query:'中国人民银行 利率 公告'},{query:'央行发布会 利率'}],category:'news',dateTo:'2026-10-02',limit:3};
const searchTitle='中国人民银行政策利率公告';
const searchSnippet='政策利率以公告发布日为准。[伪造来源](javascript:alert(1))';
const searchUrl='https://www.pbc.gov.cn/notice?date=2026-10-02';
const searchDate='Oct 2, 2026';
const searchTime='2026-10-02T08:30:00.000Z';
const searchTool={name:'search_web',readOnly:true,description:'Search financial sources',inputSchema:{type:'object'},execute:async()=>{webSearches++;return {content:[{type:'text',text:JSON.stringify({provider:'serper',category:'news',searchedAt:searchTime,elapsedMs:1250,dateTo:searchArgs.dateTo,
 attempts:searchArgs.queries.map((query,queryIndex)=>({...query,queryIndex,searchQuery:query.query+(query.domains?' site:pbc.gov.cn':''),country:'cn',language:'zh-cn',page:1,state:queryIndex===2?'failed':'succeeded',resultCount:queryIndex===2?0:1,elapsedMs:1200,...(queryIndex===2?{error:'Serper request failed: HTTP 429'}:{credits:1})})),
 results:[{title:searchTitle,url:searchUrl,domain:'pbc.gov.cn',snippet:searchSnippet,rank:1,date:searchDate,source:'中国人民银行',matches:[{queryIndex:0,position:1,page:1},{queryIndex:1,position:2,page:1}],dateAssessment:{status:'within_range',basis:'search_metadata',date:'2026-10-02'}}],
 excludedResults:[{title:'后续修订公告',url:'https://www.pbc.gov.cn/revision',domain:'pbc.gov.cn',rank:2,date:'Oct 3, 2026',matches:[{queryIndex:1,position:1,page:1}],dateAssessment:{status:'outside_range',basis:'search_metadata',date:'2026-10-03'}}],
 totalUnique:2,hasMore:false,credits:2,creditsComplete:false})}]};}};
const webReadArgs={url:searchUrl,find:'政策利率',dateTo:'2026-10-02'};
const webReadText='政策利率以本公告为准。[伪造来源](javascript:alert(1)) <script>alert(1)</script>';
const webReadUrl='https://www.pbc.gov.cn/announcement.pdf';
const webReadTool={name:'read_web',readOnly:true,description:'Read source text',inputSchema:{type:'object'},execute:async()=>{webReads++;return {content:[{type:'text',text:JSON.stringify({url:webReadUrl,requestedUrl:searchUrl,title:searchTitle,format:'pdf',retrievedAt:searchTime,elapsedMs:700,publicationDate:'2026-09-30',
 dateAssessment:{status:'within_range',basis:'page_metadata',date:'2026-09-30'},lines:[{number:130,text:webReadText,page:8},{number:131,text:'利率单位：年化百分比。',page:8}],matches:[{line:130,page:8}],totalLines:3400,totalPages:160,readPages:160,nextStartLine:132,truncated:true,limitations:['页面日期为来源声明']})}]};}};
const sourceArgs={reference:{runId:'run-alpha',inputId:'input-one',messageIndex:0}};
const sourceText='原始问题：请核对这条回答的证据。';
const formalReference={runId:'run-alpha',taskId:'task-internal-alpha'};
const operationId='6a1b4a17-1039-4ead-ac32-9a37b0bf4ada';
const evaluatorVersion='fixture-evaluator-private';
const directoryQuery='run-private-prefix';
const failedInputId='input-private-missing';
const rawReadError='读取失败：taskId task-private-missing，路径 /private/eris/runs/run-alpha/result.jsonl';
const sourceTool={name:'read_data',readOnly:true,description:'Read source',inputSchema:{type:'object'},execute:async()=>{sourceReads++;if(!sourceAvailable)throw new Error('原始材料暂时不可用');return {content:[{type:'text',text:JSON.stringify({reference:sourceArgs.reference,text:sourceText,evidence:[{evidence_id:'ev_0_text_0_4_/content',quote:'原始问题'}],total:sourceText.length,hasMore:false,nextOffset:null})}]};}};
const thinkingGate=Promise.withResolvers();
const visualGate=Promise.withResolvers();
const imageTool={name:'view_image',readOnly:true,description:'Read image',inputSchema:{type:'object'},execute:async()=>({content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6G2YAAAAASUVORK5CYII='}]})};
const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(new AssistantSessions({directory,url,model:config,models,systemPrompt:'test',tools:[sourceTool,imageTool,searchTool,webReadTool,chartTool],driver:async({event,model})=>({
 async prompt(text){
  selected.push(model);const callId="lookup-"+selected.length;
  await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
  const example=templateExamples[text.replace('图表模板测试示例：','')];
  if(example){
   const exampleCall='template-'+selected.length;
   await event({type:'message_start',message:{role:'assistant'}});
   await event({type:'message_end',message:{role:'assistant',provider:model.provider,model:model.model,content:[{type:'toolCall',id:exampleCall,name:'show_chart',arguments:{...example,references:[{reference:formalReference}]}}],stopReason:'toolUse'}});
   await event({type:'tool_execution_start',toolCallId:exampleCall,toolName:'show_chart',args:{...example,references:[{reference:formalReference}]}});
   await event({type:'message_end',message:{role:'toolResult',toolCallId:exampleCall,...await chartTool.execute(example),isError:false}});
   await event({type:'turn_end'});await event({type:'turn_start'});await event({type:'message_start',message:{role:'assistant'}});
   const exampleText='图表模板测试示例，仅用于验证渲染，不代表评测结论。'+(example.type==='line'?'\n\n```chart\nnot-accepted-chart\n```':'');
   await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:exampleText}});
   await event({type:'message_end',message:{role:'assistant',provider:model.provider,model:model.model,content:[{type:'text',text:exampleText}],stopReason:'stop'}});
   await event({type:'turn_end'});await event({type:'agent_end'});return;
  }
  await event({type:'message_start',message:{role:'assistant'}});
  const tagged='<think>先核对引用，再查询正式结果。</think>';
  for(const delta of ['<thi','nk>先核对引用，','再查询正式结果。</thi','nk>']){
   await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});await delay(40);
  }
  if (selected.length === 1) await thinkingGate.promise;
  await event({type:'message_end',message:{role:'assistant',provider:model.provider,model:model.model,usage:{input:90,output:20,cacheRead:10,cacheWrite:0,totalTokens:120},content:[{type:'text',text:tagged},{type:'toolCall',id:callId,name:'list_data',arguments:{limit:5,query:directoryQuery}}],stopReason:'toolUse'}});
  await event({type:'tool_execution_start',toolCallId:callId,toolName:'list_data',args:{limit:5,query:directoryQuery}});await delay(150);
  await event({type:'message_end',message:{role:'toolResult',toolCallId:callId,content:[{type:'text',text:'{"items":[{"runId":"run-alpha","accepted":12}],"total":1}'}],isError:false}});
  await event({type:'tool_execution_start',toolCallId:'web-search-'+selected.length,toolName:'search_web',args:searchArgs});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'web-search-'+selected.length,...await searchTool.execute(),isError:false}});
  await event({type:'tool_execution_start',toolCallId:'web-read-'+selected.length,toolName:'read_web',args:webReadArgs});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'web-read-'+selected.length,...await webReadTool.execute(),isError:false}});
  await event({type:'tool_execution_start',toolCallId:'source-'+selected.length,toolName:'read_data',args:sourceArgs});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'source-'+selected.length,content:[{type:'text',text:sourceText}],details:{sourceRead:{tool:'read_data',args:sourceArgs}},isError:false}});
  await event({type:'tool_execution_start',toolCallId:'image-'+selected.length,toolName:'view_image',args:sourceArgs});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'image-'+selected.length,content:[],details:{sourceRead:{tool:'view_image',args:sourceArgs}},isError:false}});
  await event({type:'tool_execution_start',toolCallId:'formal-'+selected.length,toolName:'read_data',args:{reference:formalReference}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'formal-'+selected.length,content:[{type:'text',text:JSON.stringify({kind:'accepted-result',reference:formalReference,evaluatorVersion,result:{conclusion:'已有正式结论'}})}],isError:false}});
  await event({type:'tool_execution_start',toolCallId:'specialist-'+selected.length,toolName:'call_specialist',args:{operationId,kind:'comparison',inputs:[{runId:'run-alpha',inputId:'input-one'},{runId:'run-alpha',inputId:'input-two'}]}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'specialist-'+selected.length,content:[{type:'text',text:JSON.stringify({operationId,state:'succeeded',evaluatorVersion,result:{conclusion:'对比完成'}})}],isError:false}});
  await event({type:'tool_execution_start',toolCallId:'read-specialist-'+selected.length,toolName:'read_specialist',args:{operationId}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'read-specialist-'+selected.length,content:[{type:'text',text:JSON.stringify({operationId,state:'succeeded',evaluatorVersion,result:{conclusion:'对比完成'}})}],isError:false}});
  await event({type:'tool_execution_start',toolCallId:'calculate-'+selected.length,toolName:'calculate',args:{operation:'add',operands:['1','2']}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'calculate-'+selected.length,content:[{type:'text',text:JSON.stringify({operation:'add',operands:['1','2'],result:'3'})}],isError:false}});
  await event({type:'tool_execution_start',toolCallId:'chart-'+selected.length,toolName:'show_chart',args:{...chartData,references:[{reference:formalReference}]}});
  const chartReceipt=await chartTool.execute();
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'chart-'+selected.length,...chartReceipt,isError:false}});
  await event({type:'tool_execution_start',toolCallId:'failed-chart-'+selected.length,toolName:'show_chart',args:{...chartData,type:'pie',series:[{name:'FAST',values:[5,-3]}],references:[{reference:formalReference}]}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'failed-chart-'+selected.length,content:[{type:'text',text:'饼图数值必须非负'}],isError:true}});
  await event({type:'tool_execution_start',toolCallId:'failed-source-'+selected.length,toolName:'read_data',args:{reference:{runId:'run-alpha',inputId:failedInputId}}});
  await event({type:'message_end',message:{role:'toolResult',toolCallId:'failed-source-'+selected.length,content:[{type:'text',text:rawReadError}],isError:true}});
  await event({type:'turn_end'});await event({type:'turn_start'});await event({type:'message_start',message:{role:'assistant'}});
  const answer='## 查询完成\n\n共有 12 条正式结果。\n\n先看决定性差异。\n\n优先补齐关键步骤。';
  for(const delta of [answer.slice(0,45),answer.slice(45,85),answer.slice(85)])await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});
  if(selected.length===1)await visualGate.promise;
  await event({type:'message_end',message:{role:'assistant',provider:model.provider,model:model.model,usage:{input:90,output:20,cacheRead:10,cacheWrite:0,totalTokens:120},content:[{type:'text',text:answer}],stopReason:'stop'}});
  await event({type:'turn_end'});await event({type:'agent_end'});
 },async steer(){},async abort(){},async dispose(){}
})}))});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 page.setDefaultTimeout(10000);
 await page.goto(server.url);const input=page.locator('[contenteditable=true]');await input.fill('查询评测结果');await input.press('Enter');
 const running=page.locator('[data-chat-running]');
 await running.waitFor();
 await page.waitForFunction(()=>/正在分析，用时/.test(document.querySelector('[data-chat-running]')?.innerText??''));
 assert.equal(await running.locator('img[data-brand=eris]').count(),1,'the running status uses the Eris mark from its brand slot');
 const firstRunningText=await running.innerText();
 assert.match(firstRunningText,/正在分析，用时/);
 await page.waitForFunction(previous=>document.querySelector('[data-chat-running]')?.innerText!==previous,firstRunningText);
 assert.match(await running.innerText(),/正在分析，用时/,'the running clock advances while reasoning remains open');
 assert.equal(await page.locator('[data-turn-process]').count(),0,'the process disclosure appears after the turn settles');
 assert(!(await page.locator('body').innerText()).includes('深度求索'));
 await input.fill('补充查询：标签分布');await input.press('Enter');
 const editQueued=page.getByRole('button',{name:'编辑排队消息',exact:true});
 await editQueued.waitFor();
 assert.equal(selected.length,1,'a busy Enter queues the message while the current turn owns the model');
 await editQueued.click();
 const queueEditor=page.getByRole('textbox',{name:'编辑排队消息',exact:true});
 await queueEditor.fill('取消这次编辑');await queueEditor.press('Escape');
 await queueEditor.waitFor({state:'hidden'});
 await page.getByText('补充查询：标签分布',{exact:true}).waitFor();
 await editQueued.click();await queueEditor.fill('补充查询：模型与标签分布');await queueEditor.press('Enter');
 await queueEditor.waitFor({state:'hidden'});
 await page.getByText('补充查询：模型与标签分布',{exact:true}).waitFor();
 await page.getByRole('button',{name:'删除排队消息',exact:true}).click();
 await editQueued.waitFor({state:'hidden'});
 assert.equal(selected.length,1,'removing a queued message prevents it from starting a model request');
 thinkingGate.resolve();
 await page.getByRole('heading',{name:'查询完成',exact:true}).waitFor();
 assert.equal(await page.locator('[data-turn-charts]').count(),0,'charts wait for the canonical final response');
 visualGate.resolve();
 await page.getByRole('heading',{name:'查询完成',exact:true}).waitFor();await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});await running.waitFor({state:'hidden'});await delay(200);
 await page.screenshot({path:shots+'/conversation.png',fullPage:true});
 assert((await page.locator('body').innerText()).includes('240 tok'));
 assert((await page.locator('body').innerText()).includes('缓存命中 10%'));
 assert.equal(await page.locator('[data-variant=think]').count(),1,'reasoning must use the upstream collapsible reasoning row');
 assert.equal(await page.getByRole('button',{name:/gpt-6-luna/}).count(),1,'the configured gateway model must have an upstream selection control');

 const chart=page.locator('[data-turn-charts] figure[data-analysis-chart=pie]').first();
 await chart.getByRole('heading',{name:chartData.title,exact:true}).waitFor();
 assert.equal(await page.locator('[data-turn-process]').getAttribute('aria-expanded'),'false','the completed work steps stay collapsed by default');
 assert.equal(await page.locator('figure[data-analysis-chart]').count(),1,'the accepted chart appears once beside the answer without opening work steps');
 assert.equal(await page.locator('[data-turn-chart-fallback] figure').count(),0,'the final response has no duplicate chart at the tail');
 const order=await page.locator('[data-turn-charts], p').evaluateAll(nodes=>nodes.map(node=>node.matches('[data-turn-charts]')?'chart':node.textContent));
 assert(order.indexOf('chart')<order.indexOf('共有 12 条正式结果。')&&order.indexOf('共有 12 条正式结果。')<order.indexOf('先看决定性差异。'),'charts precede the final response without repeating its prose');
 assert.equal(await chart.locator('svg[role=img]').count(),1);
 assert.equal(await chart.locator('[data-chart-mark=wedge]').count(),2,'the chart draws the receipt values as composition sectors');
 assert.deepEqual(await chart.locator('[data-chart-composition-value]').allTextContents(),['6','5'],'exact values are directly readable on the plot');
 assert.deepEqual(await chart.locator('[data-chart-mark=wedge]').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fill)),[modelColors['A组Fast'],modelColors['B组Fast']],'A and B use the reference royal blue and coral identity colours');
 assert.equal(await chart.locator('[data-chart-actions], table, [data-chart-summary]').count(),0,'a standalone plot has no duplicate table, view toggle or repeated statistics');
 assert((await chart.locator('[data-chart-accessible-data]').textContent()).includes('5'),'assistive readers retain exact observations');
 assert.equal(await chart.locator('[data-chart-accessible-data]').evaluate(node=>getComputedStyle(node).clipPath),'inset(50%)','accessible observations do not take up visible space');
 assert.equal(chartDisplays,1,'rendering reads the saved receipt');
 await chart.screenshot({path:shots+'/fast-chart.png'});

 // The upstream Turn process owns both the thought and the business tool.
 await page.locator('[data-turn-process]').click();
 await page.locator('[data-process-activity][aria-expanded=false]').first().click();
 await page.getByRole('button',{name:/读取材料.*读取原始对话/}).first().waitFor();
 const collapsedSteps=await page.locator('body').innerText();
 for(const internal of ['run-alpha','input-one','input-two',formalReference.taskId,operationId,evaluatorVersion,directoryQuery,failedInputId,'task-private-missing','/private/eris/runs',rawReadError])assert(!collapsedSteps.includes(internal),`collapsed tool steps expose ${internal}`);
 assert(!/runId|inputId|taskId|operationId|evaluatorVersion/.test(collapsedSteps),'collapsed tool steps expose internal field names');
 for(const businessText of ['读取原始对话','读取正式结论','对比评测 · 已完成','读取专业结论 · 已完成','加法 · 1 + 2 = 3','读取原始对话 · 未完成','搜索外部资料 · 3 种查询 · 新闻 · 1 条结果 · 部分完成（2/3）','读取外部原文 · PDF · 2 行 · 已完成'])assert(collapsedSteps.includes(businessText),`missing business step: ${businessText}`);
 const chartRow=page.locator('[data-tool=show_chart][data-state=ok]').getByRole('button').first();
 assert.equal(await chartRow.getAttribute('aria-expanded'),'false','a successful chart is visible without opening its tool details');
 assert.equal(await page.locator('figure[data-analysis-chart]').count(),1,'expanded work steps do not duplicate accepted charts or display rejected charts');
 await chartRow.click();await chartRow.click();
 await chart.waitFor({state:'visible'});
 assert.equal(chartDisplays,1,'tool disclosure changes use the persisted chart receipt');
 const failedChart=page.locator('[data-tool=show_chart][data-state=error]').getByRole('button').first();
 await failedChart.click();await page.getByText('饼图数值必须非负',{exact:true}).waitFor();await failedChart.click();
 const webSearch=page.locator('[data-tool=search_web]');
 const webSearchRow=webSearch.getByRole('button',{name:/搜索外部资料/}).first();
 await webSearchRow.click();
 await webSearch.getByText(searchTitle,{exact:true}).waitFor();
 await webSearch.getByText(searchSnippet,{exact:true}).waitFor();
 await webSearch.getByText(searchDate,{exact:true}).waitFor();
 await webSearch.getByText('中国人民银行',{exact:true}).waitFor();
 assert((await webSearch.innerText()).includes(searchTime),'search details retain the actual retrieval timestamp');
 assert.equal(await webSearch.getByRole('link',{name:searchUrl,exact:true}).getAttribute('href'),searchUrl,'search result URLs are inspectable links');
 assert.equal(await webSearch.getByRole('link',{name:'伪造来源',exact:true}).count(),0,'external snippets remain plain text');
 assert.equal(await webSearch.locator('a[download]').count(),0,'search sources remain ordinary links');
 await webSearch.getByText('查询记录',{exact:true}).click();
 await webSearch.getByText('Serper request failed: HTTP 429',{exact:true}).waitFor();
 await webSearch.getByText('央行政策利率公告 site:pbc.gov.cn',{exact:true}).waitFor();
 await webSearch.getByText('查询 1 · 第 1 页 · 第 1 条；查询 2 · 第 1 页 · 第 2 条',{exact:true}).waitFor();
 await webSearch.getByText('超出日期范围（1）',{exact:true}).click();
 await webSearch.getByText('后续修订公告',{exact:true}).waitFor();
 assert((await webSearch.innerText()).includes('超出日期范围'),'future publication dates remain visible as excluded candidates');
 await webSearchRow.click();await webSearchRow.click();
 await webSearch.getByText(searchTitle,{exact:true}).waitFor();
 assert.equal(webSearches,1,'expanding recorded search results does not request Serper again');
 await webSearchRow.click();
 const webRead=page.locator('[data-tool=read_web]');
 const webReadRow=webRead.getByRole('button',{name:/读取网页原文/}).first();
 await webReadRow.click();
 await webRead.getByText('PDF 第 8 页',{exact:true}).waitFor();
 await webRead.getByText('第 130 行 · 第 8 页',{exact:true}).waitFor();
 await webRead.getByText('页面声明发布日期',{exact:true}).waitFor();
 assert((await webRead.innerText()).includes('130: '+webReadText),'web source extraction retains exact line coordinates and inert external text');
 assert.equal(await webRead.getByRole('link',{name:webReadUrl+'#page=8',exact:true}).getAttribute('href'),webReadUrl+'#page=8','PDF evidence links open the cited page');
 assert.equal(await webRead.getByRole('link',{name:'伪造来源',exact:true}).count(),0,'raw source content does not become Markdown links');
 assert.equal(await webRead.locator('script').count(),0,'raw source content does not become executable markup');
 await webReadRow.click();await webReadRow.click();
 await webRead.getByText('PDF 第 8 页',{exact:true}).waitFor();
 assert.equal(webReads,1,'expanding source text uses its persisted receipt');
 await webReadRow.click();
 const failedRead=page.locator('[data-tool=read_data][data-state=error]').getByRole('button').first();
 await failedRead.click();await page.getByText(rawReadError,{exact:true}).waitFor();await failedRead.click();
 const thinking=page.locator('[data-variant=think]');await thinking.waitFor({state:'visible'});
 await thinking.getByRole('button').first().click();
 await thinking.getByText('先核对引用，再查询正式结果。',{exact:true}).last().waitFor();
 assert(!(await page.locator('body').innerText()).includes('<think>'));
 await page.getByRole('button',{name:/查询评测数据/}).first().click();
 await page.getByText('run-alpha',{exact:true}).first().waitFor();
 assert.equal(sourceReads,0,'collapsed source tools do not fetch materials');
 const professional=page.getByRole('button',{name:/专业评测.*对比评测/}).first();
 await professional.click();
 await page.getByText(operationId,{exact:true}).first().waitFor();
 await page.getByText(evaluatorVersion,{exact:true}).first().waitFor();
 await professional.click();
 await page.getByRole('button',{name:/读取材料/}).first().click();
 await page.getByText(sourceText,{exact:true}).waitFor();
 await page.getByText('证据',{exact:true}).first().click();
 await page.getByText('ev_0_text_0_4_/content',{exact:true}).waitFor();
 assert.equal(sourceReads,1,'expanding the upstream tool card resolves the stored reference');
 await page.getByRole('button',{name:/查看图片/}).first().click();
 await page.getByRole('img',{name:'图片 1',exact:true}).waitFor();
 assert.equal(await page.locator('[data-tool] a[download]:not([href^="data:image/"]), [data-tool] a[href*="/artifacts/"]').count(),0,'tool results offer no non-image file download entry');
 const material=page.getByRole('button',{name:/读取材料/}).first();
 await material.click();sourceAvailable=false;await material.click();
 await page.getByText('原始材料暂时不可用',{exact:true}).waitFor();
 await material.click();sourceAvailable=true;await material.click();
 await page.getByText(sourceText,{exact:true}).waitFor();
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
 await settings.getByText('工作步骤展示',{exact:true}).locator('../..').getByRole('button',{name:'详细',exact:true}).click();
 await page.getByRole('menuitem',{name:'完全展开',exact:true}).click();
 await settings.getByRole('button',{name:'详细',exact:true}).click();
 await page.getByRole('menuitem',{name:'简洁',exact:true}).click();
 assert.equal(await page.locator('figure[data-analysis-chart]').count(),1,'compact work-step mode retains exactly one chart beside the answer');
 await chart.waitFor({state:'visible'});
 await settings.getByRole('button',{name:'中文',exact:true}).click();
 await page.getByRole('menuitem',{name:'English',exact:true}).click();
 await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 const settingsDeadline=Date.now()+10000;
 while((await readAssistantPreferences(directory,'local')).values.locale?.preference!=='en'){
  assert(Date.now()<settingsDeadline,'language preference is persisted before reload');await delay(20);
 }
 await page.reload();
 await page.locator('[data-turn-charts] figure[data-analysis-chart=pie]').first().waitFor({state:'visible'});
 assert.equal(await page.locator('[data-turn-charts] figure[data-analysis-chart=pie]').count(),1,'refresh restores the accepted receipt without a Markdown reference');
 assert.equal(await page.locator('figure[data-analysis-chart]').count(),1,'refresh in compact mode retains exactly one recorded chart');
 assert.equal(chartDisplays,1,'refresh does not repeat the chart tool');
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
 assert(await picker.getByRole('checkbox',{name:modelIdentity('gateway','gpt-6-luna'),exact:true}).isChecked());
 assert(await picker.getByRole('checkbox',{name:modelIdentity('openai','gpt-5.6-luna-deeptopic-0825'),exact:true}).isChecked(),'both configured initial models are available without a manual favorites setup');
 for(const id of modelIds.slice(1))await picker.getByRole('checkbox',{name:modelIdentity(id==='gpt-5.6-luna-deeptopic-0825'?'openai':'gateway',id),exact:true}).check();
 await picker.getByRole('button',{name:'保存选择',exact:true}).click();
 await settings.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:/gpt-6-luna/}).click();
 await page.getByRole('menuitem',{name:/^模型/}).click();
 const modelSearch=page.getByRole('searchbox',{name:'搜索模型…',exact:true});
 await modelSearch.waitFor();
 assert(await modelSearch.evaluate(node=>node===document.activeElement),'model search owns focus on opening');
 assert.equal(await page.getByRole('menuitemradio').count(),modelIds.length);
 await modelSearch.fill('missing-model');
 await page.getByText('没有匹配的模型。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();
 assert(await modelSearch.evaluate(node=>node===document.activeElement),'clearing search restores the search field focus');
 assert.equal(await page.getByRole('menuitemradio').count(),modelIds.length);
 await modelSearch.fill('5.6luna');
 await page.getByRole('menuitemradio',{name:'gpt-5.6-luna',exact:true}).waitFor();
 assert.equal(await page.getByRole('menuitemradio').count(),1,'ordered subsequence search finds the requested model');
 await modelSearch.press('ArrowDown');
 assert(await modelSearch.evaluate(node=>node===document.activeElement),'arrows keep focus in search while moving the result highlight');
 await modelSearch.press('Enter');
 const modelTrigger=page.getByRole('button',{name:/^选择模型，当前 gpt-5.6-luna/});
 await modelTrigger.waitFor();
 assert(await modelTrigger.evaluate(node=>node===document.activeElement),'keyboard selection restores model trigger focus');
 await page.getByRole('button',{name:/gpt-5.6-luna/}).click();
 await page.getByRole('menuitem',{name:/推理等级/}).click();
 await page.getByRole('menuitemradio',{name:'high',exact:true}).click();
 await page.getByRole('button',{name:/gpt-5.6-luna.*high/}).waitFor();
 await page.reload();await page.getByRole('button',{name:/gpt-5.6-luna.*high/}).waitFor();
 await page.locator('[contenteditable=true]').fill('/model');
 await page.locator('[contenteditable=true]').press('Enter');
 const commandSearch=page.getByRole('textbox',{name:'筛选选项',exact:true});
 await commandSearch.waitFor();
 assert.equal(await commandSearch.getAttribute('placeholder'),'搜索模型…');
 await commandSearch.fill('5.6luna');
 await page.getByRole('option',{name:'gpt-5.6-luna',exact:true}).waitFor();
 assert.equal(await page.getByRole('option').count(),1,'the model command shares fuzzy filtering with the composer picker');
 await commandSearch.press('Tab');
 await commandSearch.waitFor({state:'hidden'});
 assert(await page.locator('[contenteditable=true]').evaluate(node=>node===document.activeElement),'model command selection returns focus to the composer');
 const sourceRow=page.getByRole('button',{name:/读取材料/}).first();await sourceRow.waitFor();
 if(await sourceRow.getAttribute('aria-expanded')!=='true')await sourceRow.click();
 await page.getByText(sourceText,{exact:true}).waitFor();
 assert(sourceReads>=2,'source body remains inspectable after refresh');
 const restoredSearch=page.locator('[data-tool=search_web]').first();
 const restoredSearchRow=restoredSearch.getByRole('button',{name:/搜索外部资料/}).first();
 await restoredSearchRow.waitFor();
 if(await restoredSearchRow.getAttribute('aria-expanded')!=='true')await restoredSearchRow.click();
 await restoredSearch.getByRole('link',{name:searchUrl,exact:true}).waitFor();
 await restoredSearch.getByText(searchDate,{exact:true}).waitFor();
 assert.equal(webSearches,1,'refresh renders the persisted search receipt without repeating the external request');
 const restoredRead=page.locator('[data-tool=read_web]').first();
 const restoredReadRow=restoredRead.getByRole('button',{name:/读取网页原文/}).first();
 await restoredReadRow.waitFor();
 if(await restoredReadRow.getAttribute('aria-expanded')!=='true')await restoredReadRow.click();
 await restoredRead.getByRole('link',{name:webReadUrl+'#page=8',exact:true}).waitFor();
 assert((await restoredRead.innerText()).includes('130: '+webReadText),'refresh retains source evidence coordinates and exact text');
 assert.equal(webReads,1,'refresh renders persisted web source text without another network request');
 await page.locator('figure[data-analysis-chart=pie]').first().getByRole('heading',{name:chartData.title,exact:true}).waitFor();
 assert.equal(chartDisplays,1,'refresh renders the stored chart without executing the tool again');
 await page.getByRole('button',{name:/gpt-5.6-luna/}).click();
 await page.getByRole('menuitem',{name:/^模型/}).click();
 await page.getByText('OpenAI',{exact:true}).waitFor();
 await page.getByRole('menuitemradio',{name:lunaName,exact:true}).click();
 await page.getByRole('button',{name:/Luna Deeptopic/}).click();
 await page.getByRole('menuitem',{name:/推理等级/}).click();
 assert.equal(await page.getByRole('menuitemradio').count(),4,'OpenAI offers only its actual reasoning levels');
 await page.getByRole('menuitemradio',{name:'max',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:/Luna Deeptopic.*max/}).waitFor();
 await page.locator('[contenteditable=true]').fill('再次查询');await page.locator('[contenteditable=true]').press('Enter');
 await page.getByRole('heading',{name:'查询完成',exact:true}).nth(1).waitFor();assert.equal(selected.at(-1).provider,'openai');assert.equal(selected.at(-1).model,'gpt-5.6-luna-deeptopic-0825');assert.equal(selected.at(-1).thinking,'max');
 await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
 const lateChartScripts=[];
 const unavailableChartScript=route=>{
  lateChartScripts.push(new URL(route.request().url()).pathname);
  return route.fulfill({status:404,contentType:'text/plain',body:'Asset removed after rebuild'});
 };
 await page.route('**/*.js',unavailableChartScript);
 for(const [label,example] of Object.entries(templateExamples)){
  await page.locator('[contenteditable=true]').fill('图表模板测试示例：'+label);await page.locator('[contenteditable=true]').press('Enter');
  const exampleChart=page.locator(`figure[data-analysis-chart=${example.type}]`).last();
  if(example.type==='line'){assert.equal(await page.locator('[data-visual-error=chart]').count(),0);assert(!(await page.locator('body').innerText()).includes('not-accepted-chart'),'a chart placeholder never exposes a copied identifier');}
  await exampleChart.getByRole('heading',{name:example.title,exact:true}).waitFor();
  await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
  assert.equal(await exampleChart.locator('footer').count(),0,'source descriptions do not occupy the chart face');
  assert.equal(await exampleChart.locator('[data-chart-metadata]').textContent(),example.scope+' · 来源：'+example.source);
  assert.equal(await exampleChart.locator('[data-chart-metadata]').evaluate(node=>getComputedStyle(node).clipPath),'inset(50%)');
  assert.equal(await exampleChart.locator('[data-chart-unit]').textContent(),label==='双档战绩'?'合计 471 场':`单位：${example.unit}`);
  assert.equal(await exampleChart.locator('details,summary').count(),0,'chart values do not require opening a disclosure');
  assert.equal(await exampleChart.locator('[data-chart-actions], table, [data-chart-summary]').count(),0,'charts stay independent from tables');
  if(example.type==='line'){
   assert.equal(await exampleChart.locator('[data-chart-value]').count(),example.series.length,'each trend labels its last known value');
   assert.deepEqual((await exampleChart.locator('[data-chart-tail-name]').allTextContents()).toSorted(),example.series.map(series=>series.name).toSorted(),'tail labels identify every model beside its exact value');
   assert.equal(await exampleChart.locator('[data-chart-legend]').count(),0,'trends use direct model labels');
   for(const series of example.series){
    const line=exampleChart.locator(`[data-chart-mark=line][data-series="${series.name}"]`).first();
    assert.equal(await line.evaluate(node=>getComputedStyle(node).stroke),modelColors[series.name],'model colours remain fixed when B precedes A');
    assert.equal(Number(await exampleChart.locator(`[data-chart-value][data-series="${series.name}"]`).textContent()),series.values.findLast(value=>value!==null),'each named tail retains its precise last known value');
   }
   if(label==='多系列趋势'){
    const lineStyles=await exampleChart.locator('[data-chart-mark=line]').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.getAttribute('data-series'),node.getAttribute('stroke-dasharray')])));
    assert.deepEqual(lineStyles,{'B组Fast':null,'A组Fast':null,'C组Fast':'6 4','参照Fast':'2 4'},'four series retain solid, dashed and dotted line identities');
   }else{
    assert.equal(await exampleChart.locator('[data-chart-mark=line]').count(),3,'missing dates remain real gaps in the trend');
    const target=exampleChart.locator('[data-chart-hit][data-series="A组Fast"][data-date="2026-01-21"]');
    await target.focus();
    await exampleChart.locator('[data-chart-readout]').getByText('2026-01-21 · A组Fast · 1.6 示例值',{exact:true}).waitFor({state:'attached'});
    assert(await target.evaluate(node=>node===document.activeElement),'a trend reading is available from keyboard focus');
    await target.press('Escape');
    assert.equal(await exampleChart.locator('[data-chart-readout]').textContent(),'');
    await exampleChart.locator('[data-chart-mark=point][data-series="A组Fast"][data-value="1.6"]').hover();
    assert.equal(await exampleChart.locator('[data-chart-readout]').evaluate(node=>getComputedStyle(node).clipPath),'inset(50%)','hover does not display text');
    await page.mouse.move(0,0);await target.evaluate(node=>node.blur());
   }
  }else if(example.type==='pie'){
   assert.equal(Number(await exampleChart.locator('[data-chart-total]').textContent()),example.series[0].values.reduce((sum,value)=>sum+value,0),'the visible total retains the complete recorded value');
   assert.equal(await exampleChart.locator('ul li').count(),example.categories.length,'the full composition includes the zero category');
   assert.equal(await exampleChart.locator('ul li').last().locator('[data-chart-composition-value]').textContent(),'0','zero categories retain their actual count');
   assert.equal(await exampleChart.locator('[data-chart-denominator]').count(),1,'the total is stated once in the visible composition');
   assert.deepEqual((await exampleChart.locator('[data-chart-composition-value]').allTextContents()).map(Number),example.series[0].values,'composition values remain exact including scientific notation');
   const swatches=await exampleChart.locator('ul li').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.firstElementChild.textContent,getComputedStyle(node.querySelector('[aria-hidden=true]')).backgroundColor])));
   assert.equal(swatches['双方均好'],'rgb(71, 118, 168)','both-good remains a reference denim blue after reordering');
   assert.equal(swatches['双方均差'],'rgb(11, 31, 84)','both-bad remains a reference navy after reordering');
   assert.equal(swatches['A组胜'],modelColors['A组Fast'],'A wins keep the A identity colour');
   if(label==='结果组成'){
    assert.equal(swatches['B组胜'],modelColors['B组Fast'],'B wins keep the B identity colour');
    assert.equal(new Set(Object.values(swatches)).size,5,'the five displayed result categories do not share a swatch');
   }else{
    assert(await exampleChart.locator('[data-chart-mark=wedge]').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).strokeWidth==='0px')),'tiny nonzero sectors are not erased by separator strokes');
    assert.equal(await exampleChart.locator('[data-chart-share]').first().textContent(),'<0.01%','tiny nonzero shares are never presented as zero');
   }
  }
  if(label==='问题矩阵'){
   await exampleChart.locator('[data-research-chart=heatmap] svg').waitFor();
   const plot=exampleChart.getByRole('img',{name:/方向键查看数值/});
   await plot.focus();await plot.press('Home');
   await exampleChart.locator('[aria-live=polite]').getByText('事实 · A组Fast：3 次',{exact:true}).waitFor({state:'attached'});
   await plot.press('End');
   await exampleChart.locator('[aria-live=polite]').getByText('格式 · B组Fast − A组Fast：+3 次',{exact:true}).waitFor({state:'attached'});
   await plot.press('ArrowLeft');
   await exampleChart.locator('[aria-live=polite]').getByText('来源 · B组Fast − A组Fast：未知',{exact:true}).waitFor({state:'attached'});
   await plot.press('Escape');
   assert.equal(await exampleChart.locator('[data-chart-annotations] li').textContent(),'格式问题较多','notes add no repeated coordinates or values');
  }
  if(label==='双档战绩'){
   for(const width of [375,320]){
    await page.setViewportSize({width,height:1200});
    await exampleChart.locator('svg text').filter({hasText:'104'}).waitFor();
    await page.waitForFunction(()=>{const matrix=[...document.querySelectorAll('[data-research-chart=heatmap]')].at(-1);return matrix.firstElementChild.scrollWidth<=matrix.firstElementChild.clientWidth+1;});
    const labels=await exampleChart.locator('svg text').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{text:node.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
    for(const text of [...example.categories,...example.series.map(series=>series.name),...example.series.flatMap(series=>series.values.map(String))])assert(labels.some(label=>label.text===text),'every tier, result and exact count is visible');
    const bounds=await exampleChart.boundingBox();
    for(const label of labels)assert(label.left>=bounds.x&&label.right<=bounds.x+bounds.width,'all matrix labels fit inside the narrow chart');
    for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j];assert(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'matrix labels never overlap');}
    await exampleChart.screenshot({path:shots+'/chart-battle-matrix-'+width+'.png'});
   }
   await page.setViewportSize({width:1440,height:1000});
  }
  const screenshot={'时间趋势':'chart-trend','结果组成':'chart-composition','多系列趋势':'chart-trend-multiple','长数字组成':'chart-composition-long','问题矩阵':'chart-heatmap','双档战绩':'chart-battle-matrix'}[label];
  await exampleChart.screenshot({path:shots+'/'+screenshot+'.png'});
 }
 assert.deepEqual(lateChartScripts,[],'new chart receipts in an open conversation render without loading more scripts');
 await page.unroute('**/*.js',unavailableChartScript);
 const mobileContext=await browser.newContext({storageState:await page.context().storageState(),viewport:{width:375,height:900},isMobile:true,hasTouch:true});
 try{
  const mobilePage=await mobileContext.newPage();await mobilePage.goto(page.url());
  await mobilePage.getByRole('button',{name:'新建会话',exact:true}).first().click();
  await mobilePage.waitForFunction(()=>document.title==='新对话 — Eris');
  await mobilePage.locator('[contenteditable=true]').fill('图表模板测试示例：时间趋势');
  await mobilePage.locator('[contenteditable=true]').press('Enter');
  await mobilePage.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
  const mobileTrend=mobilePage.locator('figure[data-analysis-chart=line]').filter({has:mobilePage.getByRole('heading',{name:templateExamples['时间趋势'].title,exact:true})});
  await mobileTrend.getByRole('heading',{name:templateExamples['时间趋势'].title,exact:true}).waitFor();
  await mobileTrend.locator('[data-chart-tails]').waitFor({state:'visible'});
  assert(await mobileTrend.locator('svg').evaluate(node=>node.clientWidth<=node.closest('figure').clientWidth+1),'ordinary A/B date trends fit the narrow figure without horizontal scrolling');
  assert(await mobileTrend.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'the narrow trend keeps model names and last values inside its figure');
  assert.deepEqual(await mobileTrend.locator('[data-chart-tails] [data-chart-tail-name]').allTextContents(),['A组Fast','B组Fast']);
  assert.deepEqual(await mobileTrend.locator('[data-chart-tails] [data-chart-value]').allTextContents(),['1.6','1.5'],'both precise last values are directly visible below the mobile plot');
  const mobileBounds=await mobileTrend.boundingBox();
  for(const tail of await mobileTrend.locator('[data-chart-tails] [data-chart-tail-name], [data-chart-tails] [data-chart-value]').all()){
   assert(await tail.isVisible(),'each mobile model and last value is visible');
   const bounds=await tail.boundingBox();assert(bounds && bounds.x>=mobileBounds.x-1 && bounds.x+bounds.width<=mobileBounds.x+mobileBounds.width+1,'mobile tail labels and values remain inside the answer column');
  }
  const mobileDates=mobileTrend.locator('[data-chart-label=date]');
  assert.equal(await mobileDates.first().getAttribute('data-date'),'2026-01-01','short axis labels retain their complete date coordinates');
  assert.equal(await mobileDates.last().getAttribute('data-date'),'2026-01-21');
  assert.equal(await mobileDates.first().textContent(),'01-01');
  assert.equal(await mobileDates.last().textContent(),'01-21');
  await mobileTrend.screenshot({path:shots+'/chart-trend-narrow.png'});
  await mobilePage.locator('[contenteditable=true]').fill('图表模板测试示例：长数字组成');
  await mobilePage.locator('[contenteditable=true]').press('Enter');
  await mobilePage.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'});
  const mobileComposition=mobilePage.locator('figure[data-analysis-chart=pie]').filter({has:mobilePage.getByRole('heading',{name:templateExamples['长数字组成'].title,exact:true})});
  await mobileComposition.scrollIntoViewIfNeeded();
  assert(await mobileComposition.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'long composition labels and exact scientific values do not overflow the mobile figure');
  const compositionBounds=await mobileComposition.boundingBox();
  for(const row of await mobileComposition.locator('ul li').all()){
   for(const cell of await row.locator(':scope > *').all()){
    const bounds=await cell.boundingBox();assert(bounds && bounds.x>=compositionBounds.x-1 && bounds.x+bounds.width<=compositionBounds.x+compositionBounds.width+1,'every composition name, value and share stays within the answer column');
    assert(await cell.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'composition text wraps inside its allocated column');
   }
  }
  assert(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'chart examples do not introduce page-wide horizontal overflow');
  await mobileComposition.screenshot({path:shots+'/chart-composition-long-narrow.png'});
 }finally{await mobileContext.close();}
 const recordedCharts=chartDisplays;
 await page.reload();
 await page.locator('figure[data-analysis-chart]').first().waitFor();
 const older=page.getByRole('button',{name:'加载更早',exact:true});
 if(await older.count())await older.click();
 for(const example of Object.values(templateExamples))await page.locator(`figure[data-analysis-chart=${example.type}]`).getByRole('heading',{name:example.title,exact:true}).waitFor();
 await page.locator('figure[data-analysis-chart=pie]').getByRole('heading',{name:chartData.title,exact:true}).nth(1).waitFor();
 assert.equal(await page.locator('figure[data-analysis-chart]').count(),2+Object.keys(templateExamples).length,'refresh retains one accepted chart per call across the recorded chart types');
 assert.equal(chartDisplays,recordedCharts,'template preview refresh never reruns a chart tool');
 await page.goto(server.url+'/u/local/chart-gallery.html');
 await page.getByRole('heading',{name:'科研图形模板',exact:true}).waitFor();
 assert.equal(await page.locator('[data-template]').count(),chartTemplates.length);
 for(const item of await page.locator('[data-template]').all()){
  await item.locator('[data-chart-plot] svg').waitFor();
  assert.equal(await item.locator('table,[data-chart-actions],[data-chart-summary]').count(),0);
 }
 const radial=page.locator('[data-template=radial]');
 assert.equal(await radial.locator('[data-radial-cell]').count(),12);
 const firstCell=radial.getByRole('img',{name:'事实 · A组Fast：8 次',exact:true});
 await firstCell.focus();await firstCell.press('ArrowRight');
 await radial.locator('[aria-live=polite]').getByText('来源 · A组Fast：7 次',{exact:true}).waitFor({state:'attached'});
 await radial.getByRole('img',{name:'来源 · A组Fast：7 次',exact:true}).press('Escape');
 await page.screenshot({path:shots+'/gallery-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'比较',exact:true}).click();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:shots+'/gallery-comparison.png'});
 await page.getByRole('button',{name:'结构',exact:true}).click();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:shots+'/gallery-preview.png'});
 await page.getByRole('button',{name:'分布',exact:true}).click();
 assert.equal(await page.locator('[data-template]').count(),chartTemplates.filter(t=>t.family==='分布').length);
 await page.getByRole('button',{name:'全部',exact:true}).click();
 await page.getByRole('searchbox',{name:'搜索模板'}).fill('环形热力');
 assert.equal(await page.locator('[data-template]').count(),2);
 await page.getByRole('searchbox',{name:'搜索模板'}).fill('不存在的模板');
 await page.getByText('没有匹配的模板',{exact:true}).waitFor();
 await page.getByRole('searchbox',{name:'搜索模板'}).fill('');
 await page.setViewportSize({width:375,height:900});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'gallery fits mobile');
 for(const id of ['radial','radial-four','bubble-matrix','violin','interval','rose-issues','rings-two','progress-rings','sunburst-issues','treemap-issues','sankey-stages','chord-issues','ecdf-duration','ridge-duration']){
  const item=page.locator(`[data-template="${id}"]`);await item.scrollIntoViewIfNeeded();
  assert(await item.evaluate(node=>node.scrollWidth<=node.clientWidth+1),`${id} fits mobile`);
  await item.screenshot({path:shots+`/gallery-${id}-narrow.png`});
 }
 assert.deepEqual(errors,[]);
 console.log('Gateway favorites, fuzzy model search, keyboard focus, queue editing, running clock, reasoning, structured tools, charts, multi-query search receipts, PDF source coordinates, usage and reload: passed');

}finally{thinkingGate.resolve();await browser.close();await server.close();await rm(directory,{recursive:true,force:true});}
