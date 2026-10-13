(() => {
  'use strict';
  // 仓库元数据及源码提交来自 GitHub API；日期是查询日期，不是发布日期。
  const repositories = {
  "harbor": {
    "name": "harbor-framework/harbor",
    "url": "https://github.com/harbor-framework/harbor",
    "stars": 6055,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "4778ceba98314a3b0fe119249f7ac84fc0af08b7",
    "createdAt": "2025-08-04T23:28:26Z",
    "pushedAt": "2026-10-13T04:41:29Z"
  },
  "promptfoo": {
    "name": "promptfoo/promptfoo",
    "url": "https://github.com/promptfoo/promptfoo",
    "stars": 25952,
    "license": "MIT",
    "date": "2026-10-13",
    "commit": "6174c1028bee6f055667f16a88676bfdd6160920",
    "createdAt": "2023-04-28T15:48:49Z",
    "pushedAt": "2026-10-13T06:04:07Z"
  },
  "deepeval": {
    "name": "confident-ai/deepeval",
    "url": "https://github.com/confident-ai/deepeval",
    "stars": 18776,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "016946f6d770f8bc4e2f63f665140aea527d6641",
    "createdAt": "2023-08-10T05:35:04Z",
    "pushedAt": "2026-10-12T19:31:54Z"
  },
  "ragas": {
    "name": "vibrantlabsai/ragas",
    "url": "https://github.com/vibrantlabsai/ragas",
    "stars": 16003,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "298b68274234c060deacab3cf5fb52aa3a20e885",
    "createdAt": "2023-05-08T17:48:04Z",
    "pushedAt": "2026-02-24T07:47:19Z"
  },
  "inspect": {
    "name": "UKGovernmentBEIS/inspect_ai",
    "url": "https://github.com/UKGovernmentBEIS/inspect_ai",
    "stars": 2991,
    "license": "MIT",
    "date": "2026-10-13",
    "commit": "81c1668d31030eebf7ff55e8376c2650b4f811ed",
    "createdAt": "2023-11-14T14:53:11Z",
    "pushedAt": "2026-10-13T01:47:14Z"
  },
  "google": {
    "name": "google/adk-python",
    "url": "https://github.com/google/adk-python",
    "stars": 21790,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "6a3828325b6f9feb429aa9e73e86837ad9acecdd",
    "createdAt": "2025-04-01T20:44:40Z",
    "pushedAt": "2026-10-13T06:22:40Z"
  },
  "openai": {
    "name": "openai/evals",
    "url": "https://github.com/openai/evals",
    "stars": 19594,
    "license": "MIT；数据集另见许可",
    "date": "2026-10-13",
    "commit": "8eac7a7de5215c907fbddc30efdaf316913eccdd",
    "createdAt": "2023-01-23T20:51:04Z",
    "pushedAt": "2026-04-14T15:29:57Z"
  },
  "langsmith": {
    "name": "langchain-ai/langsmith-sdk",
    "url": "https://github.com/langchain-ai/langsmith-sdk",
    "stars": 1077,
    "license": "MIT · 仅 SDK",
    "date": "2026-10-13",
    "commit": "a155e95489c536c84ebdb02cc1490111b13221c4",
    "createdAt": "2023-05-30T19:03:00Z",
    "pushedAt": "2026-10-13T02:03:07Z"
  },
  "langfuse": {
    "name": "langfuse/langfuse",
    "url": "https://github.com/langfuse/langfuse",
    "stars": 35731,
    "license": "MIT 核心 / 商业扩展",
    "date": "2026-10-13",
    "commit": "3a2551dd35be1796f7d3b023d57913fcfc7e819d",
    "createdAt": "2023-05-18T17:47:09Z",
    "pushedAt": "2026-10-13T06:38:25Z"
  },
  "phoenix": {
    "name": "Arize-ai/phoenix",
    "url": "https://github.com/Arize-ai/phoenix",
    "stars": 11817,
    "license": "ELv2 · 源码公开",
    "date": "2026-10-13",
    "commit": "00ceb32e63b053bc4f53420fbf9f26f944edbc27",
    "createdAt": "2022-11-09T23:44:35Z",
    "pushedAt": "2026-10-13T03:19:27Z"
  },
  "opencompass": {
    "name": "open-compass/opencompass",
    "url": "https://github.com/open-compass/opencompass",
    "stars": 7507,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "82ae5056595473b6fce59ca6b7ae053f0c533dde",
    "createdAt": "2023-06-15T12:42:58Z",
    "pushedAt": "2026-10-12T12:15:58Z"
  },
  "evalscope": {
    "name": "modelscope/evalscope",
    "url": "https://github.com/modelscope/evalscope",
    "stars": 3531,
    "license": "Apache-2.0",
    "date": "2026-10-13",
    "commit": "8cb880fc0ef8059a5936bc8da78be821261229bb",
    "createdAt": "2023-12-07T06:10:49Z",
    "pushedAt": "2026-10-13T06:38:40Z"
  },
  "lmharness": {
    "name": "EleutherAI/lm-evaluation-harness",
    "url": "https://github.com/EleutherAI/lm-evaluation-harness",
    "stars": 14200,
    "license": "MIT",
    "date": "2026-10-13",
    "commit": "d6de81643928d653435c431bae19945d41d32520",
    "createdAt": "2020-08-28T00:09:15Z",
    "pushedAt": "2026-09-14T10:51:06Z"
  },
  "pi": {
    "name": "earendil-works/pi",
    "url": "https://github.com/earendil-works/pi",
    "stars": 114719,
    "license": "MIT",
    "date": "2026-10-13"
  },
  "retail": {
    "name": "xqun3/agent-evaluation",
    "url": "https://github.com/xqun3/agent-evaluation",
    "stars": 8,
    "license": "MIT",
    "date": "2026-10-13",
    "commit": "7ea69a365e68e43bc05aa936abff834dd38ca72c"
  },
  "weather": {
    "name": "Anya2089/Weather_Report_Agent_with_Agentboard_Eval",
    "url": "https://github.com/Anya2089/Weather_Report_Agent_with_Agentboard_Eval",
    "stars": 6,
    "date": "2026-10-13",
    "commit": "950d15dbd74426f3391a3a136e21b93b63ea144a"
  },
  "exam": {
    "name": "Anya2089/exam_generator_strands",
    "url": "https://github.com/Anya2089/exam_generator_strands",
    "date": "2026-10-13",
    "commit": "ef4bd9deb398d27c93943e935de2219e15caf650"
  }
};
  const node = (id, column, row, title, detail, kind = 'step') => ({id, column, row, title, detail:detail.split('|'), kind});
  const edge = (from, to, label = '', route = '', offset = 0) => ({from, to, label, route, offset});
  const article = id => ({article:id});
  const code = (repository, path, lines, title) => ({title, url:`${repositories[repository].url}/blob/${repositories[repository].commit}/${path}${lines ? '#L' + lines.replace(':','-L') : ''}`});
  const graph = (id, title, sources, nodes, edges) => ({id, title, sources, nodes, edges});
  const workflows = [
    {id:'meituan',title:'美团',kind:'业务实践',object:'业务 Agent',input:'任务、预期行为、轨迹',grading:'原子判据 + 人工 / AI',output:'逐项结论、质量问题',graphs:[
      graph('meituan-calibration','01 · 标准与裁判校准',[article('meituan')],[
        node('goal',1,0,'业务目标','任务目标 → 可核验要求'),
        node('rubric',1,1,'原子判据','结果、过程、效率、安全|按项判断：是、否、未知'),
        node('human',1,2,'人人对齐','专家背靠背标注|核对分歧与边界样本'),
        node('revise',2,2,'修订标准','澄清歧义、补充示例'),
        node('machine',1,3,'人机对齐','同一批样本做人评与机评|核对结论及判断依据'),
        node('judge',2,3,'调整 AI 裁判','修改评测提示词与判据'),
        node('ready',1,4,'规模化评测','校准后的标准与评测器|持续观察未知项和分歧'),
      ],[edge('goal','rubric'),edge('rubric','human'),edge('human','revise','有分歧'),edge('revise','rubric','重标','right'),edge('human','machine','已对齐'),edge('machine','judge','有偏差'),edge('judge','machine','复评','pair',22),edge('machine','ready','已对齐'),edge('ready','rubric','未知项 / 新边界','left')]),
      graph('meituan-operation','02 · 样本、评测与业务迭代',[article('meituan')],[
        node('online',0,0,'线上采集','真实请求、用户反馈|Good Case / Bad Case'),
        node('sandbox',2,0,'沙箱采集','复现任务与受控场景'),
        node('clean',1,1,'清洗样本','去重、分类、补齐上下文'),
        node('case',1,2,'组装评测材料','任务 + 预期行为 + Trace|保留最终结果与环境状态'),
        node('evaluate',1,3,'人工 / AI 评测','按标准逐项核验|长任务同时看结果和过程'),
        node('qa',1,4,'质量检查','复核标准与评测结果'),
        node('repair',2,4,'纠正评测问题','修订标准或评测器'),
        node('analysis',1,5,'分析与归因','定位模型、工具和流程问题'),
        node('improve',1,6,'调整 Agent','提示词 / Skill|策略 / 模型'),
        node('observe',1,7,'回归与线上观察','固定样本复测、A/B 验证|新增案例回到采集环节'),
      ],[edge('online','clean'),edge('sandbox','clean'),edge('clean','case'),edge('case','evaluate'),edge('evaluate','qa'),edge('qa','repair','有误评'),edge('repair','evaluate','重评','right'),edge('qa','analysis','通过'),edge('analysis','improve'),edge('improve','observe'),edge('observe','online','新增案例','left')]),
    ]},
    {id:'aws',title:'亚马逊 AWS',kind:'官方文章的三个案例',object:'零售 / 天气 / 考题 Agent',input:'任务、环境、预期状态',grading:'状态核对、过程指标',output:'成功率、轨迹、执行统计',graphs:[
      graph('aws-retail','01 · 零售客服：τ-bench + Strands',[article('aws'),code('retail','main.py','','运行入口'),code('retail','env_litellm.py','','环境与状态评估'),code('retail','auto_error_identification.py','','失败归因')],[
        node('task',1,0,'任务与预期动作','零售任务、用户指令|业务规则与初始数据库'),
        node('init',1,1,'初始化一轮 Trial','重置环境、创建 Agent|配置用户模拟模型'),
        node('user',0,2,'模拟用户','按任务逐步提供信息|满足目标后结束对话'),
        node('agent',1,2,'Strands Agent','读取对话并决定行动'),
        node('tool',2,2,'零售工具','查询 / 退货 / 修改订单|更新业务数据'),
        node('state',1,3,'状态核对','参考动作在初始数据上执行|比较预期与实际最终状态'),
        node('result',1,4,'任务结果','逐任务 Reward / 成功率|多次执行的可靠性'),
        node('failure',2,4,'失败归因','轨迹、任务、参考动作|交给模型分析失败原因'),
        node('trace',1,5,'记录与分析','对话、工具调用、耗时|文章示例接入 Langfuse'),
      ],[edge('task','init'),edge('init','agent'),edge('user','agent','提问','pair',-22),edge('agent','user','回复','pair',22),edge('agent','tool','调用','pair',-22),edge('tool','agent','返回','pair',22),edge('agent','state','对话结束'),edge('state','result'),edge('result','failure','失败'),edge('result','trace'),edge('failure','trace')]),
      graph('aws-weather','02 · 天气 Agent：AgentBoard 控制循环',[article('aws'),code('weather','agentboard/tasks/tool.py','183:270','EvalTool 与指标'),code('weather','agentboard/environment/weather_env.py','','WeatherEnv'),code('weather','agentboard/agents/vanilla_agent.py','','VanillaAgent')],[
        node('reset',1,0,'EvalTool 初始化','读取任务与难度|重置 Agent、环境、计数'),
        node('agent',1,1,'VanillaAgent','目标 + 历史观察 → LLM|生成动作与参数'),
        node('env',1,2,'WeatherEnv','解析动作，检查调用格式'),
        node('tools',2,2,'weather_toolkits','校验参数、调用天气 API|返回结果或 ERROR'),
        node('update',1,3,'更新观察与进度','记录动作、奖励、轨迹|累计非错误调用次数'),
        node('done',1,4,'任务完成或步数耗尽？','done / max_steps','decision'),
        node('log',2,4,'TaskLogger','逐步观察、奖励提升记录|score_state'),
        node('summary',1,5,'SummaryLogger','成功率、进度、调用有效率|easy / hard 分组'),
      ],[edge('reset','agent'),edge('agent','env'),edge('env','tools','有效动作','pair',-22),edge('tools','env','观察','pair',22),edge('env','update','含格式错误'),edge('update','done'),edge('update','log'),edge('done','agent','否：观察回传','left'),edge('done','summary','是'),edge('log','summary')]),
      graph('aws-exam','03 · 考题生成：TaskManager 记录执行质量',[article('aws'),code('exam','exam_generator/agent.py','','Agent 与步骤生命周期'),code('exam','exam_generator/utils/task_manager.py','','TaskManager'),code('exam','README.md','299:465','回调与评测报告')],[
        node('request',1,0,'创建工作流','生成请求 → workflow_id|添加并启动生成步骤'),
        node('agent',1,1,'Strands Agent','规划考试内容|题目生成与格式校验工具'),
        node('callback',1,2,'工具调用回调','关联工作流、步骤、工具|记录输入、开始与结束时间'),
        node('success',0,3,'调用成功','保存输出和耗时'),
        node('failure',2,3,'调用异常','保存错误、失败状态|处理尚未完成的调用'),
        node('complete',1,4,'结束步骤与工作流','completed / failed|汇总工具与步骤状态'),
        node('report',1,5,'生成执行报告','完成率、工具成功率|总耗时、平均工具耗时'),
      ],[edge('request','agent'),edge('agent','callback'),edge('callback','success','成功'),edge('callback','failure','异常'),edge('success','agent','还有工具调用','left'),edge('success','complete','任务结束'),edge('failure','complete'),edge('complete','report')]),
    ]},
    {id:'bytedance',title:'字节 · Data Agent',tab:'字节',kind:'业务实践',object:'数据分析 Agent',input:'问题、数据、SQL、报告',grading:'规则、图匹配、Agent 裁判',output:'能力分、组件分、业务结果',graphs:[
      graph('byte-levels','01 · 三层评测与样本回流',[article('bytedance'),article('bytedanceMirror')],[
        node('base',0,0,'基础能力','函数调用、推理、代码|幻觉、指令遵循等基准'),
        node('component',1,0,'组件能力','检索 / Schema Linking|规划 / 分析 / 报告模块'),
        node('business',2,0,'端到端能力','完整业务问题|过程、SQL、最终报告'),
        node('selection',0,1,'模型选型','同类 Benchmark 比较'),
        node('localize',1,1,'组件定位','隔离模块输入与输出|分析单环节准确性'),
        node('judge',2,1,'业务专项评测','SQL 语义检查|报告多维度评审'),
        node('platform',1,2,'评测平台汇总','数据集、规则 / 模型算子|人工评测、指标与归因对比'),
        node('cases',1,3,'线上案例回流','新增会话 → Case 分析|标注后加入评测集'),
      ],[edge('base','selection'),edge('component','localize'),edge('business','judge'),edge('selection','platform'),edge('localize','platform'),edge('judge','platform'),edge('platform','cases'),edge('cases','business','新增业务样本','right')]),
      graph('byte-sql','02 · SQL：两种语义评估方法',[article('bytedanceMirror')],[
        node('sql',1,0,'候选 SQL 与参考 SQL','保留数据库语义和查询目标'),
        node('rel',0,1,'RelPM 路径','AST → Apache Calcite|转换为关系代数 RelNode'),
        node('graph',2,1,'FuncEvalGMN 路径','构建 SQL 语义图|候选图与参考图配对'),
        node('normalize',0,2,'规则归一化','处理等价表达|按语义结构做部分匹配'),
        node('gmn',2,2,'GMN 图匹配模型','学习两张图的对应关系|估计功能语义相似性'),
        node('relscore',0,3,'RelPM 得分','规则加权的部分匹配分'),
        node('gmnscore',2,3,'FuncEvalGMN 得分','模型预测的语义评估分'),
      ],[edge('sql','rel','方法一'),edge('sql','graph','方法二'),edge('rel','normalize'),edge('normalize','relscore'),edge('graph','gmn'),edge('gmn','gmnscore')]),
      graph('byte-report','03 · 报告：Critic、Reflect 与工具核验',[article('bytedanceMirror')],[
        node('input',1,0,'完整评审材料','问题、报告、分析过程|数据上下文、指标与评分点'),
        node('critic',1,1,'Critic 初评','沿计算与分析链找问题|不同角色 / 模型独立评审'),
        node('tools',2,1,'ReAct 核验工具','代码复算、专业计算|核对数据、单位、公式'),
        node('reflect',1,2,'Reflect 复查','检查漏判、误判|复盘评分依据与推理过程'),
        node('chief',1,3,'主裁判汇总','审阅多条评分链|结合参考答案作最终判断'),
        node('human',0,3,'人工审阅','可读性、图表展示|深度与丰富度等未覆盖项'),
        node('result',1,4,'评分与错误定位','逐项结论和问题证据|对照人工标注检查机评'),
      ],[edge('input','critic'),edge('critic','tools','查证','pair',-22),edge('tools','critic','结果','pair',22),edge('critic','reflect'),edge('reflect','critic','复核问题','center-left'),edge('reflect','chief'),edge('input','human','人工维度','left'),edge('human','result'),edge('chief','result')]),
    ]},
    {id:'harbor',title:'Harbor',kind:'开源执行框架',repository:'harbor',object:'环境内执行的 Agent',input:'Task、Agent、模型、次数',grading:'环境测试 → Reward',output:'Trial 结果、轨迹、Job 指标',graphs:[
      graph('harbor-job','01 · Job：任务展开、调度与重试',[code('harbor','src/harbor/job.py','','Job'),code('harbor','src/harbor/job_plan.py','','Trial 配置展开'),code('harbor','src/harbor/trial/queue.py','194:255','并发与异常重试'),article('harborJobs')],[
        node('task',0,0,'Task / Dataset','指令、task.toml、环境|测试、可选参考解'),
        node('config',2,0,'Job 配置','Agent / 模型 / 尝试次数|并发数、重试与指标'),
        node('resolve',1,1,'解析并取得任务','解析数据集与本地任务|校验配置、加载指标'),
        node('matrix',1,2,'展开 Trial 配置','任务 × Agent × 次数|恢复时识别已有完成结果'),
        node('queue',1,3,'TrialQueue','信号量限制并发|按配置限制 Agent 并发'),
        node('trial',1,4,'创建并执行 Trial','单步 / 多步任务|执行细节见下一张图'),
        node('check',1,5,'存在可重试异常？','检查异常类型与剩余次数','decision'),
        node('retry',2,5,'退避后重试','清理该次 Trial 目录|重新创建 Trial'),
        node('aggregate',1,6,'按评测组合聚合','Agent + 模型 + 数据集|Reward 指标与异常统计'),
        node('result',1,7,'保存 Job 结果','config / result.json|保留逐 Trial 产物与日志'),
      ],[edge('task','resolve'),edge('config','resolve'),edge('resolve','matrix'),edge('matrix','queue'),edge('queue','trial'),edge('trial','check'),edge('check','retry','是'),edge('retry','queue','重新排队','right'),edge('check','aggregate','否'),edge('aggregate','result')]),
      graph('harbor-trial','02 · Trial：环境与 Agent 生命周期',[code('harbor','src/harbor/trial/trial.py','488:574','生命周期与清理'),code('harbor','src/harbor/trial/single_step.py','37:110','单步执行'),code('harbor','src/harbor/trial/multi_step.py','70:148','多步执行')],[
        node('prepare',1,0,'准备隔离环境','校验 Agent 能力|构建、启动与健康检查'),
        node('install',1,1,'准备 Agent','安装与配置、注入 Skills|可选模拟用户与 Bridge'),
        node('run',1,2,'执行任务指令','Agent 在环境中调用工具|受任务时限与预算约束'),
        node('timeout',2,2,'超时 / 非零退出','记录执行异常|仍同步输出并进入验证'),
        node('collect',1,3,'同步轨迹与产物','Agent 日志、执行记录|任务声明的文件与环境证据'),
        node('verify',1,4,'运行 Verifier','共享环境或独立环境|若禁用验证则跳过'),
        node('next',1,5,'还有任务步骤？','多步 Task：检查停止条件|按配置继续会话或新建会话','decision'),
        node('final',1,6,'收尾并落盘','关闭 Bridge、停止环境|result.json 与异常信息'),
      ],[edge('prepare','install'),edge('install','run'),edge('run','timeout','异常'),edge('run','collect','执行结束'),edge('timeout','collect'),edge('collect','verify'),edge('verify','next'),edge('next','run','是：下一步','left'),edge('next','final','否 / 停止条件')]),
      graph('harbor-verifier','03 · Verifier：从环境证据到 Reward',[code('harbor','src/harbor/trial/single_step.py','88:110','验证环境选择'),code('harbor','src/harbor/trial/trial.py','','独立验证环境与产物交接'),code('harbor','src/harbor/verifier/verifier.py','166:268','测试执行与 Reward'),article('harborVerifier')],[
        node('mode',1,0,'选择验证环境','由任务配置决定','decision'),
        node('shared',0,1,'shared','使用 Agent 原环境|直接检查完成后的状态'),
        node('separate',2,1,'separate','先收集产物并停止原环境|新建验证环境、传入产物'),
        node('tests',1,2,'准备测试','通常上传 tests/|镜像自带测试时跳过上传'),
        node('execute',1,3,'执行测试脚本','默认 tests/test.sh|保存 stdout 与验证日志'),
        node('reward',1,4,'读取 Reward 文件','优先 reward.json|否则读取 reward.txt'),
        node('invalid',2,4,'缺失 / 空 / 无效值','抛出验证异常|交由 Trial / Job 处理'),
        node('result',1,5,'VerifierResult','一个或多个数值 Reward|写入 Trial，再汇总 Job'),
      ],[edge('mode','shared','shared'),edge('mode','separate','separate'),edge('shared','tests'),edge('separate','tests'),edge('tests','execute'),edge('execute','reward'),edge('reward','invalid','无效'),edge('reward','result','有效')]),
      graph('harbor-pi','04 · Harbor 自带的 Pi 适配器',[code('harbor','src/harbor/agents/installed/pi.py','131:199','安装 Pi'),code('harbor','src/harbor/agents/installed/pi.py','377:499','运行与会话产物'),code('harbor','src/harbor/agents/installed/pi.py','501:565','轨迹与用量转换')],[
        node('install',1,0,'安装 Pi','在任务环境中准备运行时|使用指定版本与模型连接'),
        node('config',1,1,'写入运行配置','自定义模型、MCP、Skills|按配置设置最大轮数'),
        node('run',1,2,'调用 Pi CLI','pi --print --mode json|指定会话目录与任务指令'),
        node('session',1,3,'读取 Pi 会话','收集会话 JSONL 与输出|识别本次运行新增事件'),
        node('atif',0,4,'转换执行轨迹','用户、模型、工具调用|ATIF：trajectory.json'),
        node('usage',2,4,'提取用量','Token、费用等上下文指标|续接会话避免重复计数'),
        node('trial',1,5,'回到 Trial','轨迹与用量供记录和分析|成败仍由 Verifier 检查'),
      ],[edge('install','config'),edge('config','run'),edge('run','session'),edge('session','atif'),edge('session','usage'),edge('atif','trial'),edge('usage','trial')]),
    ]},
  ];
  workflows.push(
    {id:'anthropic',title:'Anthropic',kind:'公开评测方法',object:'多步任务 Agent',input:'Task、环境、成功条件',grading:'代码 / 模型 / 人工裁判',output:'轨迹、结果、重复可靠性',graphs:[
      graph('anthropic-evals','Task → Trial → Grader → 可靠性',[article('anthropic')],[
        node('task',1,0,'设计 Task','输入、环境、成功条件|区分能力集与回归集'),
        node('trial',1,1,'运行多次 Trial','独立环境、工具与 Agent|每次尝试保留完整记录'),
        node('trace',0,2,'Transcript','模型消息、工具调用|中间结果与执行过程'),
        node('outcome',2,2,'Outcome','环境最终状态与交付物|区别于 Agent 自报完成'),
        node('evidence',1,3,'准备判分证据','轨迹 + 结果 + 任务标准|按任务选择裁判组合'),
        node('code',0,4,'代码裁判','测试、状态断言|格式与约束检查'),
        node('model',1,4,'模型裁判','清晰 Rubric、参考材料|按项检查语义质量'),
        node('human',2,4,'人工裁判','校准自动裁判|抽查难例与主观维度'),
        node('score',1,5,'汇总一次 Trial','按任务组合所选裁判|二元、加权或其他评分'),
        node('reliability',1,6,'重复运行统计','pass@k：至少一次成功|pass^k：全部 k 次成功'),
        node('review',2,6,'检查失败轨迹','区分执行、任务、裁判问题|修订后重新评测'),
      ],[edge('task','trial'),edge('trial','trace'),edge('trial','outcome'),edge('trace','evidence'),edge('outcome','evidence'),edge('evidence','code'),edge('evidence','model'),edge('evidence','human'),edge('code','score'),edge('model','score'),edge('human','score'),edge('score','reliability'),edge('reliability','review'),edge('review','task','校准与补样','right')]),
    ]},
    {id:'openai',title:'OpenAI Evals',tab:'OpenAI Evals',kind:'开源评测框架',repository:'openai',object:'模型 / 自定义 Solver',input:'注册配置、JSONL 样本',grading:'Eval 类定义的评分逻辑',output:'样本事件、汇总指标',graphs:[
      graph('openai-evals','开源 Evals 的执行与判分',[code('openai','evals/cli/oaieval.py','','oaieval 入口'),code('openai','evals/eval.py','41:250','Eval / SolverEval'),code('openai','evals/elsuite/basic/match.py','','Match 示例'),code('openai','evals/elsuite/modelgraded/classify.py','','模型裁判示例')],[
        node('registry',1,0,'oaieval 读取注册配置','completion_fn + Eval|加载参数、数据与随机种子'),
        node('create',1,1,'创建评测组件','Registry 实例化 Eval|模型接口 + Recorder'),
        node('samples',1,2,'加载与分发样本','JSONL → 样本 ID|逐样本独立随机状态'),
        node('run',1,3,'eval_sample','调用 completion_fn|Solver 按样本独立复制'),
        node('match',0,4,'规则评测示例','输出与 ideal 对照|记录匹配事件'),
        node('judge',2,4,'模型评测示例','候选输出 + 评分提示词|解析裁判分类 / 分数'),
        node('record',1,5,'Recorder 收集事件','样本、模型响应、判分记录'),
        node('metrics',1,6,'Eval.run 汇总','计算该 Eval 的最终指标|写入评测日志'),
      ],[edge('registry','create'),edge('create','samples'),edge('samples','run'),edge('run','match','按 Eval 类型'),edge('run','judge','按 Eval 类型'),edge('match','record'),edge('judge','record'),edge('record','metrics')]),
    ]},
    {id:'google',title:'Google ADK',kind:'开源 Agent 框架',repository:'google',object:'ADK Agent 与会话',input:'EvalSet、预期调用与回答',grading:'轨迹 / 回答指标与阈值',output:'逐轮分数、Case 状态',graphs:[
      graph('google-adk','评测集推理与逐轮评分',[code('google','src/google/adk/evaluation/agent_evaluator.py','','AgentEvaluator'),code('google','src/google/adk/evaluation/local_eval_service.py','','LocalEvalService'),code('google','src/google/adk/evaluation/trajectory_evaluator.py','37:174','轨迹匹配策略'),article('google')],[
        node('input',1,0,'加载 EvalSet 与配置','测试会话、初始状态|期望调用、回答、评分准则'),
        node('infer',1,1,'perform_inference','逐 Case 创建并运行会话|限制并发、采集实际事件'),
        node('turns',1,2,'整理实际 Invocations','每轮用户输入、Agent 回答|工具调用、会话 ID 与状态'),
        node('trajectory',0,3,'工具轨迹指标','EXACT / IN_ORDER|ANY_ORDER 等匹配策略'),
        node('response',2,3,'回答质量指标','文本相似度或模型 Rubric|按所选指标配置执行'),
        node('score',1,4,'逐轮与整体评分','实际行为对照参考行为|每个指标保留分数与说明'),
        node('threshold',1,5,'阈值与状态判定','记录成功 / 失败等状态|推理失败保留错误'),
        node('result',1,6,'保存 EvalSet 结果','逐 Case、逐指标可回看|CLI、测试断言、UI 使用'),
      ],[edge('input','infer'),edge('infer','turns'),edge('turns','trajectory'),edge('turns','response'),edge('trajectory','score'),edge('response','score'),edge('score','threshold'),edge('threshold','result')]),
    ]},
    {id:'inspect',title:'Inspect AI',kind:'开源评测框架',repository:'inspect',object:'模型与工具型 Agent',input:'Dataset、Solver、Scorer',grading:'任务定义的 Scorer',output:'样本分数、指标、EvalLog',graphs:[
      graph('inspect-execution','Task 执行与样本评分',[code('inspect','src/inspect_ai/_eval/task/run.py','','任务、样本、日志与清理'),code('inspect','src/inspect_ai/solver/_basic_agent.py','','工具循环示例'),code('inspect','src/inspect_ai/scorer/_metrics/aggregate.py','','Epoch 与指标聚合'),article('inspect')],[
        node('task',1,0,'定义 Task','数据集、Solver、Scorer|模型、工具、预算、Epochs'),
        node('sample',1,1,'展开样本与 Epoch','初始化 TaskState|准备消息和可选 Sandbox'),
        node('solver',1,2,'运行 Solver / Agent','生成模型响应|工具循环由所选执行器决定'),
        node('tools',2,2,'执行工具','宿主工具或隔离环境|返回观察与错误'),
        node('stop',1,3,'提交或达到预算','保留消息、输出与状态|异常按策略记录或重试'),
        node('scorer',1,4,'Scorer 判分','TaskState + Target|代码断言或模型评分'),
        node('samplelog',1,5,'保存样本并清理','Transcript、分数、用量|释放样本环境'),
        node('aggregate',1,6,'聚合 Epoch 与指标','reducer 合并重复样本|输出 EvalLog 与统计指标'),
      ],[edge('task','sample'),edge('sample','solver'),edge('solver','tools','工具请求','pair',-22),edge('tools','solver','观察','pair',22),edge('solver','stop'),edge('stop','scorer'),edge('scorer','samplelog'),edge('samplelog','aggregate')]),
    ]},
    {id:'promptfoo',title:'promptfoo',kind:'开源评测工具',repository:'promptfoo',object:'提示词、模型、应用接口',input:'Prompts × Providers × Tests',grading:'断言、代码、模型',output:'得分、通过率、对比结果',graphs:[
      graph('promptfoo-evaluate','组合用例、调用与断言汇总',[code('promptfoo','src/evaluator.ts','','Evaluator 执行链'),code('promptfoo','src/assertions/index.ts','','断言与评分组合'),article('promptfoo')],[
        node('config',1,0,'读取评测配置','提示词、Providers、用例|变量、断言、并发、重复数'),
        node('matrix',1,1,'展开测试组合','渲染模板、准备上下文|按配置读取调用缓存'),
        node('provider',1,2,'调用 Provider','模型 API 或自定义应用|保存响应、时延与 Token'),
        node('error',2,2,'调用失败','记录错误与失败结果'),
        node('transform',1,3,'转换输出','执行配置的输出变换|为断言组装评测上下文'),
        node('deterministic',0,4,'确定性断言','字符串 / JSON / 代码|格式、数值与业务规则'),
        node('llm',2,4,'模型断言','LLM Rubric / 事实检查|按标准评价输出'),
        node('combine',1,5,'合并断言结果','分数、权重、阈值|记录通过状态与失败原因'),
        node('result',1,6,'跨候选比较与报告','需要时执行比较型断言|汇总质量、成本与时延'),
      ],[edge('config','matrix'),edge('matrix','provider'),edge('provider','error','异常'),edge('provider','transform','正常响应'),edge('transform','deterministic'),edge('transform','llm'),edge('deterministic','combine'),edge('llm','combine'),edge('combine','result'),edge('error','result','错误记录','right')]),
    ]},
    {id:'deepeval',title:'DeepEval',kind:'开源评测框架',repository:'deepeval',object:'LLM 应用与 Agent 组件',input:'Test Case 或 Trace / Span',grading:'Metrics、Expectations',output:'得分、原因、测试状态',graphs:[
      graph('deepeval-execution','端到端与组件评测两条入口',[code('deepeval','deepeval/evaluate/evaluate.py','212:335','evaluate 入口'),code('deepeval','deepeval/evaluate/execute/e2e.py','','Test Case 评测'),code('deepeval','deepeval/evaluate/execute/agentic.py','','Trace / Span 评测'),article('deepeval')],[
        node('case',0,0,'端到端 Test Case','输入、实际输出、参考输出|上下文 / 对话 / 工具调用'),
        node('trace',2,0,'组件执行 Trace','Agent / LLM / Tool|Span 输入输出、父子关系'),
        node('casecriteria',0,1,'绑定任务指标','选择适用 Metrics|检查必需的样本字段'),
        node('spancriteria',2,1,'绑定组件指标','将指标放在对应组件|保持与实际调用的关联'),
        node('measure',1,2,'计算指标','同步或受控异步执行|按配置复用缓存、处理异常'),
        node('score',1,3,'保留逐指标结果','score、reason、error|耗时与评测成本'),
        node('threshold',1,4,'测试判定','按阈值与 Expectations|区分 flaky、错误与失败'),
        node('result',1,5,'测试结果与报告','assert_test 接入测试|evaluate 汇总并输出报告'),
      ],[edge('case','casecriteria'),edge('trace','spancriteria'),edge('casecriteria','measure'),edge('spancriteria','measure'),edge('measure','score'),edge('score','threshold'),edge('threshold','result')]),
    ]},
    {id:'langsmith',title:'LangSmith SDK',tab:'LangSmith',kind:'开源客户端；平台另行提供',repository:'langsmith',object:'应用函数与已有实验',input:'Dataset、Target、Evaluators',grading:'逐样本 / 汇总 / 成对裁判',output:'实验 Run、Feedback、对照',graphs:[
      graph('langsmith-sdk','开源 SDK：离线实验与对照',[code('langsmith','python/langsmith/evaluation/_runner.py','','evaluate / comparative'),code('langsmith','python/langsmith/evaluation/evaluator.py','','RunEvaluator'),article('langsmith')],[
        node('input',1,0,'evaluate 入口','数据集 + Target 函数|或读取已有实验的 Runs'),
        node('schedule',1,1,'创建实验与样本任务','按 num_repetitions 展开|设置 max_concurrency'),
        node('target',1,2,'执行 Target','样本 input → 应用输出|记录 Run 与 Trace'),
        node('evaluators',1,3,'逐样本 Evaluators','输入、输出、参考答案|返回分数、标签与说明'),
        node('feedback',1,4,'保存 Run 与 Feedback','结果关联数据集样本|按配置上传平台'),
        node('summary',0,5,'Summary Evaluators','对整组 Runs 计算统计量'),
        node('compare',2,5,'成对实验评测','按样本匹配多个实验|成对比较可随机化顺序'),
        node('result',1,6,'实验对照','比较样本与总体结果|选择版本、模型、提示词'),
      ],[edge('input','schedule'),edge('schedule','target'),edge('target','evaluators'),edge('evaluators','feedback'),edge('feedback','summary'),edge('feedback','compare'),edge('summary','result'),edge('compare','result')]),
    ]},
    {id:'ragas',title:'Ragas',kind:'开源指标与实验框架',repository:'ragas',object:'Agent 工具使用与目标',input:'多轮记录、参考调用 / 目标',grading:'匹配算法与 LLM 判断',output:'按所选指标分别出分',graphs:[
      graph('ragas-agent-metrics','Agent 三类指标的实际计算',[code('ragas','src/ragas/metrics/collections/tool_call_accuracy/metric.py','','ToolCallAccuracy'),code('ragas','src/ragas/metrics/collections/tool_call_f1/metric.py','','ToolCallF1'),code('ragas','src/ragas/metrics/collections/agent_goal_accuracy/metric.py','','AgentGoalAccuracy')],[
        node('trace',1,0,'准备 Agent 执行记录','多轮消息与工具调用|按指标提供参考调用或目标'),
        node('accuracy',0,1,'调用准确性','提取实际 / 参考调用|核对工具名序列'),
        node('f1',1,1,'调用 F1','按工具名与参数配对|集合匹配，不要求顺序'),
        node('goal',2,1,'目标达成','从对话提取最终状态|有参考 / 无参考两种判据'),
        node('args',0,2,'参数核对','strict_order 控制顺序|按参考参数计算匹配比例'),
        node('pr',1,2,'计算 P / R','匹配数对实际 / 参考数|计算调和平均'),
        node('judge',2,2,'LLM 判断','最终状态与参考目标比较|或核对对话中用户目标'),
        node('accuracyscore',0,3,'Accuracy','序列不匹配则为 0|否则结合参数匹配得分'),
        node('f1score',1,3,'F1','工具调用精确率与召回率|空调用按实现规则处理'),
        node('goalscore',2,3,'Goal Accuracy','目标达成的二元得分'),
      ],[edge('trace','accuracy'),edge('trace','f1'),edge('trace','goal'),edge('accuracy','args'),edge('args','accuracyscore'),edge('f1','pr'),edge('pr','f1score'),edge('goal','judge'),edge('judge','goalscore')]),
    ]},
    {id:'langfuse',title:'Langfuse',kind:'开源核心 + 商业扩展',repository:'langfuse',object:'线上 Trace 与实验记录',input:'事件、过滤条件、评测模板',grading:'模型裁判；另有代码评测',output:'Score、关联 Trace、状态',graphs:[
      graph('langfuse-worker','源码中的 LLM-as-a-Judge 调度链',[code('langfuse','worker/src/features/evaluation/evalService.ts','105:175','调度结构'),code('langfuse','worker/src/features/evaluation/evalService.ts','300:918','筛选、采样与队列'),code('langfuse','worker/src/features/evaluation/evalService.ts','925:1400','裁判执行与结果'),code('langfuse','LICENSE','','许可范围')],[
        node('event',1,0,'评测触发事件','Trace 或 Dataset Run|或界面发起历史评测'),
        node('filter',1,1,'读取规则并筛选','ACTIVE、时间范围、环境|目标对象与过滤条件'),
        node('sample',1,2,'验证目标与采样','核对 Trace、Observation|按采样率决定是否入队'),
        node('queue',1,3,'创建评测执行任务','去重后写入 PENDING|延迟队列调度执行'),
        node('template',1,4,'编译裁判请求','读取模板与模型配置|提取变量、构造结构化输出'),
        node('judge',1,5,'调用裁判模型','解析分数 / 标签 / 说明|校验评测输出'),
        node('error',2,5,'执行异常','可重试错误交回队列|无效配置记录阻断 / 失败'),
        node('score',1,6,'写入 Score 与状态','关联 Trace、Observation|实验比较或线上质量分析'),
      ],[edge('event','filter'),edge('filter','sample'),edge('sample','queue','命中且被采样'),edge('queue','template'),edge('template','judge'),edge('judge','error','异常'),edge('error','queue','允许重试','right'),edge('judge','score','有效结果')]),
    ]},
    {id:'phoenix',title:'Arize Phoenix',tab:'Phoenix',kind:'源码公开 · ELv2',repository:'phoenix',object:'应用实验与执行 Trace',input:'Dataset、Task、Evaluators',grading:'代码或 LLM Evaluator',output:'Run、评分、解释、Trace',graphs:[
      graph('phoenix-experiments','实验执行与评测重跑',[code('phoenix','packages/phoenix-client/src/phoenix/client/resources/experiments/__init__.py','','实验执行与结果写入'),code('phoenix','packages/phoenix-client/src/phoenix/client/resources/experiments/evaluators.py','','Evaluator 适配'),code('phoenix','LICENSE','','ELv2 许可')],[
        node('dataset',1,0,'选择 Dataset','指定数据集版本|准备 Task 与评测函数'),
        node('experiment',1,1,'创建 Experiment','展开样本 × repetitions|设置并发与任务超时'),
        node('task',1,2,'逐样本运行 Task','input → 应用输出|采集任务 Trace'),
        node('run',1,3,'保存 Experiment Run','输出、时延、错误|关联 Dataset Example'),
        node('eval',1,4,'运行 Evaluators','输入、输出、参考答案|代码或模型计算评分'),
        node('retry',2,4,'评测已有实验','保留原 Task 输出|替换 / 补充 Evaluators'),
        node('annotations',1,5,'保存评测结果','分数、标签、解释|评测错误与关联 Trace'),
        node('compare',1,6,'实验比较','按样本查看输出与评分|定位失败到执行轨迹'),
      ],[edge('dataset','experiment'),edge('experiment','task'),edge('task','run'),edge('run','eval'),edge('run','retry'),edge('retry','eval','重新判分','pair',22),edge('eval','annotations'),edge('annotations','compare')]),
    ]},
    {id:'opencompass',title:'OpenCompass',kind:'开源模型评测框架',repository:'opencompass',object:'模型基准能力',input:'模型、数据集、推理 / 评测配置',grading:'客观指标或模型裁判',output:'分数据集结果与汇总表',graphs:[
      graph('opencompass-pipeline','配置 → 推理 → 评分 → 汇总',[code('opencompass','opencompass/cli/main.py','','配置、分片与 Runner'),code('opencompass','opencompass/tasks/openicl_infer.py','','推理任务'),code('opencompass','opencompass/tasks/openicl_eval.py','','评测任务'),code('opencompass','docs/en/user_guides/config_based_evaluation.md','','配置说明')],[
        node('config',1,0,'加载配置','模型、数据集、Prompt|检索器、推理器、评测器'),
        node('partition',1,1,'Partitioner 拆分任务','模型 × 数据集 / 分片|Runner 选择本地或集群'),
        node('infer',1,2,'推理任务','读取数据、构造提示|按推理器生成或计算概率'),
        node('prediction',1,3,'保存 Predictions','样本输出进入评测任务|也可独立复用已有预测'),
        node('post',1,4,'后处理与对齐','提取答案、读取参考答案|按数据集规则清洗输出'),
        node('objective',0,5,'客观评测器','精确匹配、代码测试|数学或任务专用指标'),
        node('subjective',2,5,'主观评测器','裁判模型按 Rubric|评分或候选比较'),
        node('summary',1,6,'Summarizer','按数据集 / 分组聚合|生成汇总表与评测明细'),
      ],[edge('config','partition'),edge('partition','infer'),edge('infer','prediction'),edge('prediction','post'),edge('post','objective'),edge('post','subjective'),edge('objective','summary'),edge('subjective','summary')]),
    ]},
    {id:'evalscope',title:'EvalScope',kind:'开源综合评测框架',repository:'evalscope',object:'模型、Agent、多模态应用',input:'TaskConfig、Benchmark、样本',grading:'Benchmark Review / Judge',output:'样本得分、性能与汇总报告',graphs:[
      graph('evalscope-native','01 · Native 评测链',[code('evalscope','evalscope/run.py','26:56','后端分发'),code('evalscope','evalscope/run.py','141:239','模型评测与报告'),code('evalscope','evalscope/evaluator/evaluator.py','','样本执行与 Review')],[
        node('config',1,0,'读取 TaskConfig','选择 Native 后端|模型、数据集、评测参数'),
        node('benchmark',1,1,'准备 Benchmark','加载样本、子集与任务逻辑|模型接口或 AgentRunner'),
        node('pool',1,2,'构建样本工作队列','新样本：预测并判分|已有预测：按配置只重评'),
        node('predict',1,3,'Predict','模型生成或 Agent 执行|保存输出、状态与性能数据'),
        node('cache',2,3,'已有预测 / 分数','校验缓存对应的评测身份|按重评选项复用'),
        node('review',1,4,'Review / Judge','规则或裁判模型|按基准逻辑生成样本分'),
        node('persist',1,5,'逐样本落盘','预测与评分 JSONL|保留失败与执行状态'),
        node('aggregate',1,6,'聚合与报告','子集分、总体分、性能统计|表格与 HTML 报告'),
      ],[edge('config','benchmark'),edge('benchmark','pool'),edge('pool','predict','待推理'),edge('pool','cache','可复用'),edge('predict','review'),edge('cache','review','仅重评'),edge('review','persist'),edge('persist','aggregate')]),
      graph('evalscope-agent','02 · AgentLoop 的执行分支',[code('evalscope','evalscope/api/agent/loop.py','80:139','主循环'),code('evalscope','evalscope/api/agent/loop.py','175:303','解析与工具执行')],[
        node('context',1,0,'初始化 LoopContext','消息、策略、工具执行器|最大步数与提示重试预算'),
        node('generate',1,1,'调用模型','追加响应快照|记录耗时与生成事件'),
        node('parse',1,2,'策略解析输出','提交、工具动作、解析错误','decision'),
        node('tools',0,3,'执行工具动作','按顺序执行调用|将观察与错误写回消息'),
        node('nudge',2,3,'无动作或格式错误','预算内追加纠正提示|预算耗尽则结束'),
        node('end',1,4,'结束循环','显式 / 隐式提交|上下文超限或达到最大步数'),
        node('result',1,5,'返回 AgentLoopResult','最终响应、消息与轨迹|交给 Benchmark Review'),
      ],[edge('context','generate'),edge('generate','parse'),edge('parse','tools','工具动作'),edge('parse','nudge','无有效动作'),edge('tools','generate','下一轮','left'),edge('nudge','generate','尚有预算','right'),edge('parse','end','已提交'),edge('nudge','end','预算耗尽'),edge('generate','end','上下文 / 步数超限','center-left'),edge('end','result')]),
    ]},
    {id:'lmharness',title:'lm-evaluation-harness',tab:'lm-eval',kind:'开源模型基准框架',repository:'lmharness',object:'语言模型基准能力',input:'Task、数据、few-shot、模型',grading:'Task.process_results',output:'指标、误差估计、样本结果',graphs:[
      graph('lm-harness','基准请求与指标计算',[code('lmharness','lm_eval/evaluator.py','488:704','请求、响应与指标'),code('lmharness','lm_eval/api/task.py','','Task 与请求构造')],[
        node('task',1,0,'加载任务与模型','Task / Group、数据集|随机种子、few-shot 配置'),
        node('prompt',1,1,'构造样本请求','取测试文档与示例|生成上下文与请求实例'),
        node('likelihood',0,2,'loglikelihood','候选答案条件概率|选择题等任务'),
        node('rolling',1,2,'滚动似然','loglikelihood_rolling|困惑度等任务'),
        node('generation',2,2,'generate_until','按停止条件生成文本|开放式回答任务'),
        node('model',1,3,'模型批量执行','按请求类型分组与重复次数|收集每条请求的响应'),
        node('filter',1,4,'应用 Filters','按任务提取 / 筛选回答|可对重复响应作组合处理'),
        node('metric',1,5,'process_results','文档 + 过滤后输出|生成逐样本任务指标'),
        node('aggregate',1,6,'汇总任务与分组','Task 聚合函数|按配置估计标准误差'),
        node('result',1,7,'输出结果','总体指标、配置、样本明细|用于模型能力对照'),
      ],[edge('task','prompt'),edge('prompt','likelihood'),edge('prompt','rolling'),edge('prompt','generation'),edge('likelihood','model'),edge('rolling','model'),edge('generation','model'),edge('model','filter'),edge('filter','metric'),edge('metric','aggregate'),edge('aggregate','result')]),
    ]}
  );
  window.ReportResearchFlows = {repositories, workflows};
})();
