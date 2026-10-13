// 由 scripts/research.mjs 从研究 Markdown 与 four-knowns 导出正文生成。
window.EvaluationResearchData = {
  "date": "2026-10-13",
  "sources": [
    {
      "id": "meituan",
      "number": 1,
      "title": "美团：Agent评测漫谈",
      "url": "https://tech.meituan.com/2026/08/07/Agent-Evaluation.html",
      "date": "履约技术团队，2026-08-07",
      "note": "标准治理、任务指标与闭环"
    },
    {
      "id": "bytedance",
      "number": 2,
      "title": "字节 / VeDI：Data Agent 自动化评测的三层框架与实战",
      "url": "https://developer.volcengine.com/articles/7587631610258784307",
      "date": "火山原页日期未可靠核实；原页检索内容与同文交叉阅读",
      "note": ""
    },
    {
      "id": "bytedanceMirror",
      "number": 3,
      "title": "字节跳动数据平台：同文全文",
      "url": "https://www.cnblogs.com/bytedata/p/19399354",
      "date": "2025-12-25",
      "note": "补齐三层、Critic/Reflect、SQL 与复算机制；此日期只属于同文页"
    },
    {
      "id": "aws",
      "number": 4,
      "title": "AWS：Agent 质量评估",
      "url": "https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/",
      "date": "董孝群等，2025-09-19",
      "note": "任务状态、过程与观测实例"
    },
    {
      "id": "qianwen",
      "number": 5,
      "title": "千问：AI Agent 评测方法",
      "url": "https://www.qianwenai.com/discover/ai-agent-evaluation-methods",
      "date": "作者和发布日期未标明",
      "note": "通用概念综述"
    },
    {
      "id": "qianwenOwner",
      "number": 6,
      "title": "阿里云：云市场服务商入驻协议 FY27 更新通知",
      "url": "https://help.aliyun.com/zh/marketplace/notice-of-update-to-the-cloud-marketplace-service-provider-onboarding-agreement-fiscal-year-2027",
      "date": "2026-05-15 生效",
      "note": "核实 qianwenai.com 平台关联"
    },
    {
      "id": "anthropicEval",
      "number": 7,
      "title": "Anthropic：Demystifying evals for AI agents",
      "url": "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
      "date": "2026-01-09",
      "note": "任务、试次、裁判和可靠性"
    },
    {
      "id": "anthropicInfra",
      "number": 8,
      "title": "Anthropic：Quantifying infrastructure noise in agentic coding evals",
      "url": "https://www.anthropic.com/engineering/infrastructure-noise",
      "date": "2026-02-05",
      "note": "运行条件混杂"
    },
    {
      "id": "anthropicContamination",
      "number": 9,
      "title": "Anthropic：Eval awareness in BrowseComp",
      "url": "https://www.anthropic.com/engineering/eval-awareness-browsecomp",
      "date": "2026-03-06",
      "note": "联网评测污染与评测识别"
    },
    {
      "id": "promptfoo",
      "number": 10,
      "title": "promptfoo FAQ",
      "url": "https://www.promptfoo.dev/docs/faq/",
      "date": "动态文档",
      "note": "本地、CLI、CI 定位"
    },
    {
      "id": "promptfooLicense",
      "number": 11,
      "title": "promptfoo Contributing",
      "url": "https://www.promptfoo.dev/docs/contributing/",
      "date": "动态文档",
      "note": "MIT 许可"
    },
    {
      "id": "promptfooCache",
      "number": 12,
      "title": "promptfoo Caching",
      "url": "https://www.promptfoo.dev/docs/configuration/caching/",
      "date": "动态文档",
      "note": "独立重复与缓存边界"
    },
    {
      "id": "inspect",
      "number": 13,
      "title": "Inspect AI 官方文档",
      "url": "https://inspect.aisi.org.uk/",
      "date": "动态文档",
      "note": "Task / Solver / Scorer 与本地评测"
    },
    {
      "id": "inspectRuntime",
      "number": 14,
      "title": "Inspect pyproject.toml",
      "url": "https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/pyproject.toml",
      "date": "动态源码",
      "note": "Python 与许可"
    },
    {
      "id": "deepeval",
      "number": 15,
      "title": "DeepEval 官方仓库",
      "url": "https://github.com/confident-ai/deepeval",
      "date": "动态源码",
      "note": "指标体系与 Apache 2.0"
    },
    {
      "id": "deepevalTS",
      "number": 16,
      "title": "DeepEval TypeScript beta",
      "url": "https://deepeval.com/blog/introducing-deepeval-typescript",
      "date": "页面未稳定标明日期",
      "note": "本地 TS、云可选、功能和数值限制"
    },
    {
      "id": "langsmith",
      "number": 17,
      "title": "LangSmith 自托管许可",
      "url": "https://support.langchain.com/articles/7011309930-how-do-i-obtain-a-self-hosted-langsmith-license-key",
      "date": "2025-10-30",
      "note": "Enterprise 边界"
    },
    {
      "id": "langsmithReview",
      "number": 18,
      "title": "LangSmith Annotation queues",
      "url": "https://docs.langchain.com/langsmith/annotation-queues",
      "date": "动态文档",
      "note": "人工/pairwise 审阅"
    },
    {
      "id": "tau",
      "number": 19,
      "title": "τ²-bench",
      "url": "https://arxiv.org/abs/2506.07982",
      "date": "2025-06-09",
      "note": "双控制环境与协调任务"
    },
    {
      "id": "agentreward",
      "number": 20,
      "title": "AgentRewardBench v2",
      "url": "https://arxiv.org/abs/2504.08942v2",
      "date": "2025-10-06",
      "note": "裁判独立评测"
    },
    {
      "id": "agentrx",
      "number": 21,
      "title": "AgentRx v2",
      "url": "https://arxiv.org/abs/2602.02475v2",
      "date": "2026-08-31",
      "note": "约束、证据和失败定位"
    },
    {
      "id": "whowhen",
      "number": 22,
      "title": "Who&When Pro v2",
      "url": "https://arxiv.org/abs/2607.09996v2",
      "date": "2026-10-09",
      "note": "受控注错轨迹与归因评测"
    },
    {
      "id": "pipl",
      "number": 23,
      "title": "中华人民共和国个人信息保护法",
      "url": "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
      "date": "2021-08-20",
      "note": "目的、必要性与信息保护"
    },
    {
      "id": "genai",
      "number": 24,
      "title": "生成式人工智能服务管理暂行办法",
      "url": "https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm",
      "date": "2023-07-13 发布，2023-08-15 施行",
      "note": "第二条适用范围"
    },
    {
      "id": "nist",
      "number": 25,
      "title": "NIST AI 600-1",
      "url": "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf",
      "date": "2024-07-26",
      "note": "自愿风险管理资料"
    },
    {
      "id": "promptfooInstall",
      "number": 26,
      "title": "promptfoo Installation",
      "url": "https://www.promptfoo.dev/docs/installation/",
      "date": "动态文档",
      "note": "Node 安装条件"
    },
    {
      "id": "inspectMetrics",
      "number": 27,
      "title": "Inspect Scoring metrics",
      "url": "https://inspect.aisi.org.uk/metrics.html",
      "date": "动态文档",
      "note": "重复、分组和统计"
    },
    {
      "id": "agentrxRuntime",
      "number": 28,
      "title": "Microsoft AgentRx 代码",
      "url": "https://github.com/microsoft/AgentRx",
      "date": "动态源码",
      "note": "运行依赖、认证和许可"
    }
  ],
  "reportHtml": "<blockquote>数据获取时间：2026-10-13（Asia/Shanghai）<br>调研深度：深度研究，面向建设决策与领导汇报<br>业务场景：在现有 TypeScript Host + Pi / Prime 上，提升真实业务回答与 Agent 交付的评测可信度。<br>重点关注：美团与字节的工程实践、轻量开源方法、人工校准和可验证的建设路径。<br>证据约定：事实来自原文、官方文档或本地实现；推断标注置信度；建议是待实施提案。未部署或实测外部候选框架。</blockquote>\n<h2 id=\"0-执行摘要\">0. 执行摘要</h2>\n<p><strong>建议保留现有轻量底座，优先完成“人工校准 → 分层实验 → 问题回归”。</strong> 我们已经具备共同判据、证据归因、匿名比较、待核、恢复与统计校准工具。要向公开先进方法靠拢，当前更重要的是产生可信的质量证据，并让真实问题进入修复与回归流程。这个判断基于本地实现与本轮工程资料，置信度高。</p>\n<p>“达到业内已知开源顶峰”应作为建设目标，以同任务、同材料、同预算的对照实验和外部复核证明。当前不能给出行业分位或宣称超越标杆：几家材料的任务、人工标准和指标均不相同，也没有统一的行业平均。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>领导需要判断的问题</th><th>本轮结论</th><th>建议决策</th></tr></thead><tbody><tr><td>是否需要换平台</td><td>现有 Host、Workflow、Agent、Data、Runtime 已能承载大部分优先改进</td><td>保留主链，外部工具先隔离小试</td></tr><tr><td>最先投什么</td><td>人工审定与代表性实验是可信度的关键缺口</td><td>先批准 8–12 周试点，指定工程与业务样本负责人</td></tr><tr><td>美团与字节学什么</td><td>美团：标准治理与样本闭环；字节：三层诊断与工具复算</td><td>每项方法映射到具体样本、动作与验收</td></tr><tr><td>如何证明进步</td><td>人工确认误判变化、配对实验、稳定性、成本和复发情况</td><td>每轮报告分母、范围、区间与已知失败</td></tr></tbody></table></div>\n<p><strong>当前证据范围。</strong> 离线汇报保存 30 题、84 份回答、42 场对局，其中 37 场正式、5 场待核。独立实验是固定 6 题 × 3 轮，仅重跑 Comparison，冻结既有 Criteria / Attribution；同位重复与换位分别为 5/6 一致，Wilson 95% 区间均为 43.6%–97.0%。这不是人工准确率，不是全链路可靠性，也不代表总体业务分布。事实依据为 <code>evaluation-report/README.md</code>、案例与实验快照。</p>\n<h2 id=\"1-横向四个知道\">1. 横向四个知道</h2>\n<h3 id=\"1-1-社会发展-2-3-年行业趋势\">1.1 社会发展 2-3 年行业趋势</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>趋势判断</th><th>依据</th><th>时间线与决策含义</th><th>置信度</th></tr></thead><tbody><tr><td>评估对象从回答扩展到任务交付</td><td>美团讨论结果、过程、效率、安全；Anthropic 区分任务、试次、裁判、轨迹与环境结果 <a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a><a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\" target=\"_blank\" rel=\"noopener noreferrer\">[7]</a></td><td>当前先定义业务任务成功；1 年内按需求增加状态验证</td><td>高：方向；中：投入回报</td></tr><tr><td>评测需要进入持续迭代流程</td><td>美团的样本质检闭环、字节的线上回流及人工/机器协作 <a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a><a class=\"research-cite\" href=\"https://developer.volcengine.com/articles/7587631610258784307\" target=\"_blank\" rel=\"noopener noreferrer\">[2]</a><a class=\"research-cite\" href=\"https://www.cnblogs.com/bytedata/p/19399354\" target=\"_blank\" rel=\"noopener noreferrer\">[3]</a></td><td>未来 2–3 年优先沉淀真实失败与修复回归，而非一次榜单</td><td>中：本报告预测</td></tr><tr><td>裁判本身成为验证对象</td><td>AgentRewardBench 检查不同裁判；AgentRx、Who&amp;When Pro 研究失败定位 <a class=\"research-cite\" href=\"https://arxiv.org/abs/2504.08942v2\" target=\"_blank\" rel=\"noopener noreferrer\">[20]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2602.02475v2\" target=\"_blank\" rel=\"noopener noreferrer\">[21]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2607.09996v2\" target=\"_blank\" rel=\"noopener noreferrer\">[22]</a></td><td>当前就应验证判词与归责；逐步加入受控故障</td><td>高：研究方向；中：迁移效果</td></tr><tr><td>质量收益必须和成本一起解释</td><td>Anthropic 的资源噪声研究说明运行条件会干扰结论 <a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/infrastructure-noise\" target=\"_blank\" rel=\"noopener noreferrer\">[8]</a></td><td>固定预算与执行条件，分开记录被评系统和评测器成本</td><td>高：方法要求</td></tr></tbody></table></div>\n<p><strong>资料缺口。</strong> 本轮未找到可可靠拆分“Agent 评测”这一细分领域的全球/中国市场规模、增长率或融资总额；不能套用整个生成式 AI 市场的数据。新兴场景包括分析研究、客服、代码与工具执行，但其商业规模不能从技术文章推算。下一步优先取内部每月评测量、误放行代价、人工审阅时间、发布频率与调用费用，以测算投入回报。</p>\n<h3 id=\"1-2-竞争对手的情况\">1.2 竞争对手的情况</h3>\n<p>这里的“同行”包括企业工程实践、开源框架和商业平台，定位不同，不排伪精确名次。公司团队规模、市场份额和采用率缺乏同口径数据，均不用于领先性判断。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>对标对象</th><th>技术路线与优势</th><th>证据与局限</th><th>本项目取舍</th></tr></thead><tbody><tr><td>美团</td><td>标准对齐、人机校准、生产案例回流与回归</td><td>2026-08-07 一手工程文章；自报一致率不能跨业务排名</td><td>优先借鉴标准治理和样本闭环</td></tr><tr><td>字节 / VeDI</td><td>基础能力、组件、端到端三层；Critic、Reflect 与 ReAct 复算</td><td>火山原页日期未可靠读到；同账户同文 2025-12-25；缺充分实验分母</td><td>优先借鉴分层定位；增加角色须经消融</td></tr><tr><td>AWS</td><td>任务状态、轨迹进度、执行观测等示例</td><td>2025-09-19 官方导读与实践；不是统一评测排行榜</td><td>补充结果与过程分开验证的思路</td></tr><tr><td>千问 AI 平台</td><td>任务、决策、交互、轨迹与输出的通用框架</td><td>无作者与发布日期，无独立数据集和实测结果</td><td>用于维度检查，不当成熟实测体系</td></tr><tr><td>轻量开源与协作方案</td><td>promptfoo、Inspect、DeepEval、LangSmith 各有分工</td><td>见 2.2；许可、部署与功能边界分别核实</td><td>借鉴或隔离小试，不整体迁移</td></tr></tbody></table></div>\n<p><strong>美团精读：标准必须能执行、能校准、能回流。</strong> 原文把业务与模型能力之间的任务指标作为桥梁，先通过专家独立评价对齐理解，再进行人机校准；把模糊要求拆成可核验项，保留未知并分析其原因。生产案例经过清洗、质检与归因进入闭环，长任务需要输入、预期行为和执行轨迹。对我们最直接的增量是运营已有人审和实验工具，而不是再造一个评分引擎。<a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a></p>\n<p>原子项尽量明确，与整题允许部分可用并不矛盾。我们应继续区分事实核验、核心交付与相对优劣；保留 partial、unknown、都好、都差与待核，避免按问题条数或对勾数投票。美团文章的高一致率是特定业务自报，未给出足以用于跨系统比较的样本构成和区间，本报告不复用为目标已达值。</p>\n<p><strong>字节精读：先分层找到问题，再用证据验证。</strong> 基础能力测选型，组件测定位，端到端测业务效果。深度分析采用 Critic 初评、Reflect 复查，并用 ReAct 编码复算；SQL 专域采用 Calcite / RelNode 等结构表示和匹配。它对我们的启发是把“哪个环节出了问题”从整体分数中分离，并优先为可计算事实提供可重复检查。<a class=\"research-cite\" href=\"https://developer.volcengine.com/articles/7587631610258784307\" target=\"_blank\" rel=\"noopener noreferrer\">[2]</a><a class=\"research-cite\" href=\"https://www.cnblogs.com/bytedata/p/19399354\" target=\"_blank\" rel=\"noopener noreferrer\">[3]</a></p>\n<p>现有归因、比较和独立核验与评测侧 Agent 化的方向相近；结构相似不能证明效果等价。是否增加异模型核验或 Reflect，要用同一人工保留集比较严重误判与增量成本。SQL 专域的复杂算法当前不值得直接引入。原文所谓“准确性”按其定义是错误检出精确率，不应与我们的重复一致率放在同一排名图。</p>\n<p><strong>AWS 与千问的证据定位。</strong> AWS 的不同案例提醒我们区分执行过程与最终任务状态，并明确执行监控不能包办内容体验评价。<a class=\"research-cite\" href=\"https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/\" target=\"_blank\" rel=\"noopener noreferrer\">[4]</a> 千问文章可用作指标维度和流程的概念检查表，本身没有提供可复现实证。<a class=\"research-cite\" href=\"https://www.qianwenai.com/discover/ai-agent-evaluation-methods\" target=\"_blank\" rel=\"noopener noreferrer\">[5]</a> 阿里云官方协议明确列出 qianwenai.com 关联平台；主体关联已核实，文章的证据权重仍按其内容判断。<a class=\"research-cite\" href=\"https://help.aliyun.com/zh/marketplace/notice-of-update-to-the-cloud-marketplace-service-provider-onboarding-agreement-fiscal-year-2027\" target=\"_blank\" rel=\"noopener noreferrer\">[6]</a></p>\n<p><strong>近六个月新增信息。</strong> 美团 2026-08 实践、AgentRx 2026-08 论文更新、Who&amp;When Pro 2026-10 更新值得跟进。<a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2602.02475v2\" target=\"_blank\" rel=\"noopener noreferrer\">[21]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2607.09996v2\" target=\"_blank\" rel=\"noopener noreferrer\">[22]</a> DeepEval 官方当前已有 TypeScript beta；页面未稳定标明发布日期，因此只记获取日，不擅称其在某月发布。<a class=\"research-cite\" href=\"https://deepeval.com/blog/introducing-deepeval-typescript\" target=\"_blank\" rel=\"noopener noreferrer\">[16]</a> 旧材料仍可解释方法，但不计为近六个月动态。</p>\n<h3 id=\"1-3-政策监控方向\">1.3 政策监控方向</h3>\n<p>本节只识别与样本、模型网关和未来服务形态直接相关的要求与治理动作，不代替具体法律适用审查。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>分组</th><th>官方依据与适用边界</th><th>对评测体系的动作</th></tr></thead><tbody><tr><td>🔴 红线：个人信息处理</td><td>《个人信息保护法》第六条的目的明确、最小必要，第五十一条的分类与保护措施；具体处理依据及跨境路径需结合数据流判断 <a class=\"research-cite\" href=\"https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm\" target=\"_blank\" rel=\"noopener noreferrer\">[23]</a></td><td>样本分级、必要脱敏；外部模型只发送必要材料；明确权限与保留期限</td></tr><tr><td>🟡 关注：是否对公众提供服务</td><td>生成式 AI 暂行办法第二条区分公众服务与未向公众提供服务的内部研发应用 <a class=\"research-cite\" href=\"https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm\" target=\"_blank\" rel=\"noopener noreferrer\">[24]</a></td><td>内部离线工具不自动等同公众服务；未来产品化时重新核查适用义务</td></tr><tr><td>🟡 关注：可信测量与反馈</td><td>NIST AI 600-1 是自愿风险管理资料，不是中国法律或合规证书 <a class=\"research-cite\" href=\"https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf\" target=\"_blank\" rel=\"noopener noreferrer\">[25]</a></td><td>保留评测来源、人工复核与风险记录，明确无法测量的范围</td></tr><tr><td>🟢 机遇：高质量评测资产</td><td>可信数据、可追溯与可复核的价值是本报告判断，置信度中</td><td>在授权范围内沉淀脱敏样本与回归协议；未核实地方补贴、基金与认证，不作承诺</td></tr></tbody></table></div>\n<p>国家法律、服务范围和国际自愿框架已经覆盖本阶段直接相关决策。地方政策、专项资金及更细分行业标准，需要在实际落地城市、业务主体与服务范围确定后补查；本报告不将其编成现成利好。</p>\n<h3 id=\"1-4-技术发展\">1.4 技术发展</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>阶段</th><th>主流方法与代表成果</th><th>当前瓶颈</th><th>本项目动作</th></tr></thead><tbody><tr><td>当前</td><td>规则/模型/人工组合；任务与轨迹分层；美团、字节、Anthropic 工程方法</td><td>任务歧义、裁判偏差、证据缺失、样本选择偏差</td><td>先跑人工基线，再按错误类型改进</td></tr><tr><td>近期 1 年（建议）</td><td>可执行结果断言、组件评测、重复试验、受控故障</td><td>注错与真实失败分布不同；唯一标准轨迹可能错杀合法路径</td><td>对高频业务补复算与约束，单独评估归因器</td></tr><tr><td>中期 2–3 年（预测）</td><td>长任务、多模态、用户协作与环境状态评测持续结合</td><td>可观测性、仿真真实性、成本和隔离边界</td><td>只为实际业务增加环境，不提前重建平台</td></tr></tbody></table></div>\n<p>关键开源生态包括 promptfoo、Inspect、DeepEval；方法可跨框架迁移。企业观测平台与 Agent runtime 并非同一种产品，部署观测系统也不自动产生正确判词。模型隐藏推理不是评测前提，优先依赖可见请求、工具返回、实际输入、最终交付与可验证状态。</p>\n<h2 id=\"2-纵向四个知道\">2. 纵向四个知道</h2>\n<h3 id=\"2-1-学术前沿与理论极限\">2.1 学术前沿与理论极限</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>论文</th><th>作者/机构与时间</th><th>核心贡献</th><th>工程转化与限制</th></tr></thead><tbody><tr><td>AgentRewardBench <a class=\"research-cite\" href=\"https://arxiv.org/abs/2504.08942v2\" target=\"_blank\" rel=\"noopener noreferrer\">[20]</a></td><td>Xing Han Lù 等，McGill-NLP 项目；首发 2025-04-11，v2 2025-10-06</td><td>对 web Agent 轨迹上的程序/LLM 裁判进行独立检查</td><td>建立我们的裁判保留集，预计 2–4 周起步；网页任务结论不能直接外推本业务</td></tr><tr><td>τ²-bench <a class=\"research-cite\" href=\"https://arxiv.org/abs/2506.07982\" target=\"_blank\" rel=\"noopener noreferrer\">[19]</a></td><td>Victor Barres、Honghua Dong 等；2025-06-09</td><td>用户与 Agent 均可改变共享状态，用组合任务区分推理与协调</td><td>1–3 月试一个可重置工具场景；当前离线回答不应被冒充为环境执行成功率</td></tr><tr><td>AgentRx <a class=\"research-cite\" href=\"https://arxiv.org/abs/2602.02475v2\" target=\"_blank\" rel=\"noopener noreferrer\">[21]</a></td><td>Shraddha Barke 等，Microsoft Research；首发 2026-02-02，v2 2026-08-31</td><td>结合轨迹、约束检查日志和证据诊断失败；v2 为 170 条轨迹、11 个场景</td><td>4–8 周构建受控归因小集；旧博客 115 条与新版口径不同，不混用</td></tr><tr><td>Who&amp;When Pro <a class=\"research-cite\" href=\"https://arxiv.org/abs/2607.09996v2\" target=\"_blank\" rel=\"noopener noreferrer\">[22]</a></td><td>Jiale Liu 等；首发 2026-07-10，v2 2026-10-09</td><td>重放成功前缀后注入故障，构建 12,326 条带标签轨迹，覆盖 3 类模态、26 个 benchmark</td><td>1–3 月设计责任组件/步骤检查；人工注错不能代表自然多因失败</td></tr></tbody></table></div>\n<p>论文数字仅描述研究对象，不是我们的测量结果。转化周期是规划估计，不是作者承诺。为统一证据口径，本表链接到原始论文版本，不使用未核实的会议等级或引用数；引用量尚未在统一来源核实。</p>\n<p><strong>理论上限。</strong> 开放业务不存在已知统一最高分。质量受来源完整性、任务歧义、人工一致性和状态可观测性限制；抽样区间无法覆盖裁判系统性偏差。稳定地给出同一结论仍可能是稳定地判断错误。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>实验</th><th>固定与改变</th><th>能回答的问题</th><th>不能外推的结论</th></tr></thead><tbody><tr><td>比较阶段重复</td><td>冻结标准、归因与回答，只重跑比较</td><td>最后一环是否随机变化</td><td>上游是否正确、业务是否完成</td></tr><tr><td>真实换位</td><td>匿名材料整体交换后重跑裁判</td><td>位置变化是否关联结论翻转</td><td>单次分歧必由位置偏差导致</td></tr><tr><td>评测全链路重复</td><td>固定被评材料，重跑标准、归因与比较</td><td>整条评测链路的波动</td><td>被测 Agent 多次任务都能完成</td></tr><tr><td>被测 Agent 重复</td><td>固定任务、初态与预算，重新生成执行轨迹</td><td>多次任务成功情况</td><td>不能从重复裁判同份回答计算这种可靠性</td></tr><tr><td>人工校准与消融</td><td>人先审原始来源，再核对裁判；每次只改一个因素</td><td>与审定依据符合程度、局部机制收益</td><td>无争议真值或所有业务普遍有效</td></tr></tbody></table></div>\n<p>Anthropic 区分 pass@k（至少一次成功）与 pass^k（全部成功）；它们针对重复任务试次，不能由重判同一份回答推导。<a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\" target=\"_blank\" rel=\"noopener noreferrer\">[7]</a> 实验还应控制资源噪声和评测污染：公开演示、开发和保留验证集分开，保留集不参与调参。<a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/infrastructure-noise\" target=\"_blank\" rel=\"noopener noreferrer\">[8]</a><a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/eval-awareness-browsecomp\" target=\"_blank\" rel=\"noopener noreferrer\">[9]</a></p>\n<h3 id=\"2-2-工业水平与标杆架构\">2.2 工业水平与标杆架构</h3>\n<p>选择五类有一手证据的工程参照：美团的标准与数据闭环、字节的数据分析分层、AWS 的任务/过程实例、Anthropic 的实验方法、Microsoft Research 的失败诊断。这里是能力参照，不是全球工程能力 Top 5 排名。缺少同题同预算结果，无法填写“业界最佳准确率、行业平均成本、市场占有率”。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>方案</th><th>核心能力</th><th>许可与运行条件（事实）</th><th>决策（建议）</th></tr></thead><tbody><tr><td>promptfoo <a class=\"research-cite\" href=\"https://www.promptfoo.dev/docs/faq/\" target=\"_blank\" rel=\"noopener noreferrer\">[10]</a><a class=\"research-cite\" href=\"https://www.promptfoo.dev/docs/contributing/\" target=\"_blank\" rel=\"noopener noreferrer\">[11]</a><a class=\"research-cite\" href=\"https://www.promptfoo.dev/docs/configuration/caching/\" target=\"_blank\" rel=\"noopener noreferrer\">[12]</a><a class=\"research-cite\" href=\"https://www.promptfoo.dev/docs/installation/\" target=\"_blank\" rel=\"noopener noreferrer\">[26]</a></td><td>声明式断言、回归、CI、本地对比</td><td>MIT；Node CLI，当前文档要求 Node ≥22.22；模型调用单独计费</td><td>优先隔离小试；独立重复关闭结果缓存，不迁移已有恢复/持久化</td></tr><tr><td>Inspect AI <a class=\"research-cite\" href=\"https://inspect.aisi.org.uk/\" target=\"_blank\" rel=\"noopener noreferrer\">[13]</a><a class=\"research-cite\" href=\"https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/pyproject.toml\" target=\"_blank\" rel=\"noopener noreferrer\">[14]</a><a class=\"research-cite\" href=\"https://inspect.aisi.org.uk/metrics.html\" target=\"_blank\" rel=\"noopener noreferrer\">[27]</a></td><td>Task / Solver / Scorer、重复、分组统计与区间</td><td>MIT；Python ≥3.10；基础 API 任务可本地执行，沙箱按任务另加</td><td>借鉴统计与实验组织，不增加独立 Python 评测主链</td></tr><tr><td>DeepEval <a class=\"research-cite\" href=\"https://github.com/confident-ai/deepeval\" target=\"_blank\" rel=\"noopener noreferrer\">[15]</a><a class=\"research-cite\" href=\"https://deepeval.com/blog/introducing-deepeval-typescript\" target=\"_blank\" rel=\"noopener noreferrer\">[16]</a></td><td>组件/轨迹评分、测试门禁</td><td>Apache 2.0；已有 TypeScript beta，可本地运行，云可选</td><td>可做第二个局部对照；TS 缺部分 Python 能力，跨语言数值同分不保证</td></tr><tr><td>AgentRx <a class=\"research-cite\" href=\"https://arxiv.org/abs/2602.02475v2\" target=\"_blank\" rel=\"noopener noreferrer\">[21]</a><a class=\"research-cite\" href=\"https://github.com/microsoft/AgentRx\" target=\"_blank\" rel=\"noopener noreferrer\">[28]</a></td><td>规范化轨迹、约束核查、有证据的失败诊断</td><td>MIT；Python ≥3.10；当前外部接入使用 Azure OpenAI / Azure AD</td><td>只借方法；认证与网关不能假定直接兼容</td></tr><tr><td>LangSmith <a class=\"research-cite\" href=\"https://support.langchain.com/articles/7011309930-how-do-i-obtain-a-self-hosted-langsmith-license-key\" target=\"_blank\" rel=\"noopener noreferrer\">[17]</a><a class=\"research-cite\" href=\"https://docs.langchain.com/langsmith/annotation-queues\" target=\"_blank\" rel=\"noopener noreferrer\">[18]</a></td><td>人工单条/pairwise 队列、实验比较</td><td>商业平台，完整自托管属 Enterprise；SDK 不等于平台许可</td><td>借鉴审阅流程，当前不部署</td></tr></tbody></table></div>\n<p>部署负担是根据官方依赖作出的工程判断，尚未实测。promptfoo 的轻量 CLI 不代表其基础分享服务适合多人生产；DeepEval 的 TS beta 不能默认等价于 Python 版。Harbor 类重环境编排不作为当前迁移目标。对可观测、数据平台或协作服务的取舍，以其节省人时是否超过维护成本为依据。</p>\n<p>Demo 到生产的差距在于：真实分布与标注治理、失败/未决覆盖、资源控制、权限边界以及发布反馈。工具数量和多 Agent 数量都不替代这些证据。</p>\n<h3 id=\"2-3-最佳架构与主要工程模块\">2.3 最佳架构与主要工程模块</h3>\n<p><strong>建议架构：业务样本 → 分层实验计划 → 现有评测链路 → 人工校准与统计 → 发布评审 → 失败回流。</strong> 其中业务分层、人工校准运营、发布评审与回归关联是本阶段拟补齐能力；原有评测核心保持职责边界。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>模块</th><th>已有实现与职责</th><th>最小增量</th><th>技术路线与边界</th></tr></thead><tbody><tr><td>样本与输入</td><td>Workflow 的 input / input-catalog 读取与选择</td><td>记录分层、授权、纳入理由；分开诊断、调优与保留集</td><td>保留 TypeScript、业务 ID/UUID 与来源引用，不复制原文到每个 run</td></tr><tr><td>判据与评测</td><td>Criteria → Attribution → Comparison</td><td>只在实验证明具体错误后修规则</td><td>Prompts 集中维护；影响判词必须更新 evaluatorVersion</td></tr><tr><td>独立复核</td><td>可选核验另记发现，不覆盖原判</td><td>按严重性、分歧与未知路由人审或异模型抽查</td><td>同模型独立会话不保证误差独立；不以投票替代证据</td></tr><tr><td>统计与校准</td><td>benchmark compare / summarize / gold-template / calibrate</td><td>审定数据、切片报告；需要时增加配对差值统计</td><td>现有汇总区间不自动构成机制改善的因果证明</td></tr><tr><td>问题闭环</td><td>Attribution 产问题，Clustering 管问题库</td><td>关联人工确认回归样本、修复责任人与复测结果</td><td>Attribution 不读问题库、不建类；聚类不是因果证明</td></tr><tr><td>Data 与 Runtime</td><td>文件锁、日志、Worker、双 SDK 与恢复</td><td>按样本/阶段记录失效与成本，按实测瓶颈扩容</td><td>外部统计 Schema 冻结；新增研究指标放实验报告，不擅自扩字段</td></tr></tbody></table></div>\n<p>10 倍规模先测排队、模型限流、阶段瓶颈和 IO，利用既有并发能力；100 倍规模再据数据决定分布式存储与鉴权。当前可信单机 HTTP 不能通过暴露端口直接变成远程服务；工作目录也不是安全沙箱。只有业务需要执行不可信任务时，才专项建设隔离。现状依据：<code>docs/architecture.md</code>。</p>\n<h3 id=\"2-4-自身定位与发展路径\">2.4 自身定位与发展路径</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>维度</th><th>我们当前（事实）</th><th>标杆能力要求</th><th>差距与下一步</th></tr></thead><tbody><tr><td>判据与证据</td><td>共同要求、来源坐标、数值与实体核验</td><td>可操作标准、可解释证据与专家一致</td><td>机械合法不证明语义正确，补双标和反例</td></tr><tr><td>裁判可信度</td><td>金标模板和校准工具已实现</td><td>人工保留集、逐类误判与稳定复测</td><td>现有汇报未有审定金标支撑准确率</td></tr><tr><td>稳定性</td><td>六题比较阶段重复/换位实验；成簇统计工具</td><td>覆盖业务切片，区分裁判与被评 Agent 重复</td><td>扩样本、评测阶段与真实任务运行范围</td></tr><tr><td>问题定位</td><td>模型、工具、上下文证据归因及问题库</td><td>定位结果经人工/受控错误验证</td><td>建归因小集，记录无证据硬归因情况</td></tr><tr><td>运行与效率</td><td>同 run 恢复、Pi/Prime、日志与用量</td><td>运行失败、质量错误、成本分别观测</td><td>同预算配对报告，费用无可靠口径时只报用量</td></tr><tr><td>业务闭环</td><td>自动取数/交付、聚类与回归工具分别存在</td><td>真实问题到修复复测的可追踪闭环</td><td>连接回归引用和发布评审，验证复发率变化</td></tr></tbody></table></div>\n<p>相对行业分位与行业平均均无可比数据。可以确认我们已具有证据约束的离线评测底座；尚不能证明整体判词质量达到哪一行业等级。置信度：高（实现与证据边界），中（达成路径）。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>时间</th><th>可达目标（建议）</th><th>里程碑</th><th>所需条件</th></tr></thead><tbody><tr><td>6 个月</td><td>核心业务的可信回归与发布依据</td><td>保留集、人审、全链路实验、成本报告常态化</td><td>稳定工程负责人和业务专家投入</td></tr><tr><td>1 年</td><td>多业务复用，按需扩展长任务与多模态</td><td>分域标准与样本负责人，有限环境状态验证</td><td>实际需求证明收益；数据与权限确认</td></tr><tr><td>2 年</td><td>可对外复核的垂直评测方法和资产</td><td>授权脱敏题集、协议、失败说明与对照实验</td><td>维护预算、数据授权、外部复核</td></tr></tbody></table></div>\n<h2 id=\"3-综合分析\">3. 综合分析</h2>\n<h3 id=\"3-1-swot-分析\">3.1 SWOT 分析</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>内外部维度</th><th>判断</th><th>决策含义</th></tr></thead><tbody><tr><td>优势</td><td>业务语义和证据链较深，轻量底座、恢复与模块边界已具备</td><td>在现有链路上投入验证，避免重复建设</td></tr><tr><td>短板</td><td>人工校准与代表性实验不足，局部稳定性不能外推整体</td><td>先验证评测器，再扩大自动化范围</td></tr><tr><td>机会</td><td>把最新公开方法转为适合本业务的小型可复核协议</td><td>形成高质量数据与缺陷回归资产</td></tr><tr><td>威胁</td><td>同源裁判偏差、评测污染、小样本过度解读与数据边界扩大</td><td>保留独立审定与验证集，显式记录未知和失效</td></tr></tbody></table></div>\n<h3 id=\"3-2-机会窗口\">3.2 机会窗口</h3>\n<p>当前最短路径是把已经实现的工具跑出可信证据。美团标准治理与字节分层诊断可以马上进入人工试点，Anthropic 的实验设计可以降低错误归因；近半年归因研究则为下一阶段验证 Attribution 提供方法。<a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a><a class=\"research-cite\" href=\"https://developer.volcengine.com/articles/7587631610258784307\" target=\"_blank\" rel=\"noopener noreferrer\">[2]</a><a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\" target=\"_blank\" rel=\"noopener noreferrer\">[7]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2602.02475v2\" target=\"_blank\" rel=\"noopener noreferrer\">[21]</a><a class=\"research-cite\" href=\"https://arxiv.org/abs/2607.09996v2\" target=\"_blank\" rel=\"noopener noreferrer\">[22]</a> 此判断置信度高，收益大小需本地试点测量。</p>\n<h3 id=\"3-3-风险提示\">3.3 风险提示</h3>\n<ul><li>⚠️ 运行成功、结构通过、引用有效均不等于语义正确；18/18 完成只能说明这次运行完成。</li><li>⚠️ 增加同模型角色可能重复共同错误；异模型核验也必须经人工校准。</li><li>⚠️ 未知下降可能伴随误判上升；不能为提高覆盖率强制裁决。</li><li>⚠️ 公开题、调优题与保留集混用会高估效果；保留集不用于提示词调参。</li><li>⚠️ 稳定性、自报精确率、任务成功率与人工一致性分母不同，不能混成一个总榜。</li><li>⚠️ 当前历史案例保留 r151/r152 来源；r153 是既有提示词快照。冻结上游的比较实验不代表全链路 r153。</li></ul>\n<h3 id=\"3-4-行动建议\">3.4 行动建议</h3>\n<p>以下为内部建设建议，不是行业标准；本次只改研究与展示，尚未实施这些评测改进。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>阶段</th><th>动作与责任</th><th>验收证据</th><th>对应依据</th></tr></thead><tbody><tr><td>P0，第 1–4 周</td><td>业务专家与工程负责人先双标 30–50 题；原始材料盲审、分歧仲裁；拆调优与保留集</td><td>每题有纳入理由、来源、审定者和依据；报告人人分歧及人工基线</td><td>美团标准治理；现有 gold-template/calibrate</td></tr><tr><td>P0，第 5–8 周</td><td>按实测工时扩至 100–200 题；分别测组件与完整评测链路；单因素比较异模型核验/复算</td><td>分母、配对变化、严重误判、重复/换位、未知/失败、区间、费用和耗时</td><td>字节三层；Anthropic 方法与噪声；现有 compare/summarize</td></tr><tr><td>P1，第 9–12 周</td><td>责任人将高影响问题转回归引用，修复后用新 run 复测；补高频任务结果断言</td><td>原失败、新结果、复测结论；回归覆盖、复发与关闭时长；发布前评审</td><td>美团闭环；AWS 状态核验；既有问题库</td></tr><tr><td>P1，3–12 月</td><td>视错误分布增加受控故障、轻量人审队列和一个必要的工具场景</td><td>归因定位准确性、真实重复成功、维护成本可核查</td><td>AgentRx / Who&amp;When Pro / τ²-bench</td></tr><tr><td>P2，1–2 年</td><td>在许可范围内扩分域和对外复核</td><td>可复现协议与同条件外部对照；已知失败透明</td><td>业务规模与外部复核需求</td></tr></tbody></table></div>\n<p><strong>门槛制定。</strong> 第一轮人审基线后，结合严重错误代价确定容忍度，并在看改进结果前声明。受控严重反例可设“零漏过”的内部门槛，但有限样本零观测不代表总体风险为零；仍报告样本量与不确定性。100–200 题是起步规模，不是统计充分性保证。不以无来源的 90%/95% 作为“行业先进线”。</p>\n<p><strong>固定六个汇报口径。</strong> 人工一致性与逐类混淆；人工确认的严重误判；裁判重复/换位与 Agent 重复分列；未知/失败/缺失单列；同 case 配对改进及区间；被评系统/评测器各自的费用、耗时、人审时间。改善区间不支持结论时写“证据不足”。同题多场有关联，不能当独立样本扩充分母。汇总已有成簇区间，配对差值与发布统计按需要另做，不能声称已自动具备。</p>\n<p><strong>一次只试一个新增工具。</strong> promptfoo 或 DeepEval 先用同一人工集离线对照，证明减少误判或审阅工时、增量成本可接受后才引入。Inspect 与 AgentRx 当前借鉴方法；LangSmith 当前借鉴人审流程。无需为本轮改进部署完整新平台。</p>\n<h3 id=\"3-5-资源需求\">3.5 资源需求</h3>\n<p>建议 1 名工程负责人 × 8–12 周，业务专家合计约 0.3–0.5 人力当量参与试点，另安排争议裁决与安全/数据评审节点。这是资源预留建议，包含标准讨论与复核，不是承诺需要新增固定团队。</p>\n<p>作为量级估算：120 题 × 2 人 × 每题 15–25 分钟，约 60–100 评审人时；争议处理另预留 10–20 小时。复杂数值、多轮与长证据任务可能明显更高。先用 30–50 题测实际工时，再定最终样本量与排期。</p>\n<p>模型预算按“业务 case 数 × 每题阶段数 × 重复次数 × 观测单阶段费用”估算，补失败重试与复核比例。无可靠单价时只报告 token 与耗时，不硬换算货币；评测器和被评模型的成本分开。以试点实耗决定上限，必要时优先重跑高风险/高分歧样本，同时明确其不能代表总体。外部合作仅在需要额外领域审定或独立复核时引入。</p>\n<h2 id=\"4-来源与附录\">4. 来源与附录</h2>\n<h3 id=\"4-1-外部一手来源\">4.1 外部一手来源</h3>\n<p>所有未标发布日期的动态文档均以 2026-10-13 为获取日；项目代码链接为当时可见的默认分支文档，后续可能变化。</p>\n<ol><li><a href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\">美团：Agent评测漫谈</a>，履约技术团队，2026-08-07。标准治理、任务指标与闭环。</li><li><a href=\"https://developer.volcengine.com/articles/7587631610258784307\">字节 / VeDI：Data Agent 自动化评测的三层框架与实战</a>，火山原页日期未可靠核实；原页检索内容与同文交叉阅读。</li><li><a href=\"https://www.cnblogs.com/bytedata/p/19399354\">字节跳动数据平台：同文全文</a>，2025-12-25。补齐三层、Critic/Reflect、SQL 与复算机制；此日期只属于同文页。</li><li><a href=\"https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/\">AWS：Agent 质量评估</a>，董孝群等，2025-09-19。任务状态、过程与观测实例。</li><li><a href=\"https://www.qianwenai.com/discover/ai-agent-evaluation-methods\">千问：AI Agent 评测方法</a>，作者和发布日期未标明。通用概念综述。</li><li><a href=\"https://help.aliyun.com/zh/marketplace/notice-of-update-to-the-cloud-marketplace-service-provider-onboarding-agreement-fiscal-year-2027\">阿里云：云市场服务商入驻协议 FY27 更新通知</a>，2026-05-15 生效。核实 qianwenai.com 平台关联。</li><li><a href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\">Anthropic：Demystifying evals for AI agents</a>，2026-01-09。任务、试次、裁判和可靠性。</li><li><a href=\"https://www.anthropic.com/engineering/infrastructure-noise\">Anthropic：Quantifying infrastructure noise in agentic coding evals</a>，2026-02-05。运行条件混杂。</li><li><a href=\"https://www.anthropic.com/engineering/eval-awareness-browsecomp\">Anthropic：Eval awareness in BrowseComp</a>，2026-03-06。联网评测污染与评测识别。</li><li><a href=\"https://www.promptfoo.dev/docs/faq/\">promptfoo FAQ</a>，动态文档。本地、CLI、CI 定位。</li><li><a href=\"https://www.promptfoo.dev/docs/contributing/\">promptfoo Contributing</a>，动态文档。MIT 许可。</li><li><a href=\"https://www.promptfoo.dev/docs/configuration/caching/\">promptfoo Caching</a>，动态文档。独立重复与缓存边界。</li><li><a href=\"https://inspect.aisi.org.uk/\">Inspect AI 官方文档</a>，动态文档。Task / Solver / Scorer 与本地评测。</li><li><a href=\"https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/pyproject.toml\">Inspect pyproject.toml</a>，动态源码。Python 与许可。</li><li><a href=\"https://github.com/confident-ai/deepeval\">DeepEval 官方仓库</a>，动态源码。指标体系与 Apache 2.0。</li><li><a href=\"https://deepeval.com/blog/introducing-deepeval-typescript\">DeepEval TypeScript beta</a>，页面未稳定标明日期。本地 TS、云可选、功能和数值限制。</li><li><a href=\"https://support.langchain.com/articles/7011309930-how-do-i-obtain-a-self-hosted-langsmith-license-key\">LangSmith 自托管许可</a>，2025-10-30。Enterprise 边界。</li><li><a href=\"https://docs.langchain.com/langsmith/annotation-queues\">LangSmith Annotation queues</a>，动态文档。人工/pairwise 审阅。</li><li><a href=\"https://arxiv.org/abs/2506.07982\">τ²-bench</a>，2025-06-09。双控制环境与协调任务。</li><li><a href=\"https://arxiv.org/abs/2504.08942v2\">AgentRewardBench v2</a>，2025-10-06。裁判独立评测。</li><li><a href=\"https://arxiv.org/abs/2602.02475v2\">AgentRx v2</a>，2026-08-31。约束、证据和失败定位。</li><li><a href=\"https://arxiv.org/abs/2607.09996v2\">Who&amp;When Pro v2</a>，2026-10-09。受控注错轨迹与归因评测。</li><li><a href=\"https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm\">中华人民共和国个人信息保护法</a>，2021-08-20。目的、必要性与信息保护。</li><li><a href=\"https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm\">生成式人工智能服务管理暂行办法</a>，2023-07-13 发布，2023-08-15 施行。第二条适用范围。</li><li><a href=\"https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf\">NIST AI 600-1</a>，2024-07-26。自愿风险管理资料。</li><li><a href=\"https://www.promptfoo.dev/docs/installation/\">promptfoo Installation</a>，动态文档。Node 安装条件。</li><li><a href=\"https://inspect.aisi.org.uk/metrics.html\">Inspect Scoring metrics</a>，动态文档。重复、分组和统计。</li><li><a href=\"https://github.com/microsoft/AgentRx\">Microsoft AgentRx 代码</a>，动态源码。运行依赖、认证和许可。</li></ol>\n<h3 id=\"4-2-本地证据索引\">4.2 本地证据索引</h3>\n<div class=\"table-wrap\"><table><thead><tr><th>文件</th><th>支撑内容</th></tr></thead><tbody><tr><td><code>README.md</code>、<code>AGENTS.md</code></td><td>项目主线、冻结统计契约、当前模块职责</td></tr><tr><td><code>docs/quality.md</code></td><td>语义与机械验收边界、真实实验、金标与统计入口</td></tr><tr><td><code>docs/architecture.md</code></td><td>Host/Worker、恢复、双 SDK、可信单机与非安全沙箱</td></tr><tr><td><code>docs/contract.md</code></td><td>证据、标准答案、归因、判决与改写职责</td></tr><tr><td><code>scripts/benchmark-analysis.mjs</code></td><td>compareSamples、summarizeSamples、goldTemplate、calibrateSamples</td></tr><tr><td><code>docs/automations.md</code></td><td>已有持续取数、评测、改写、上传</td></tr><tr><td><code>evaluation-report/README.md</code> 与 <code>src/data/</code></td><td>30 题 42 场真实来源、六题三轮实验与历史评测器口径</td></tr></tbody></table></div>\n<h3 id=\"4-3-尚需补充的数据\">4.3 尚需补充的数据</h3>\n<p>业务分布与每层流量、严重误放行代价、专家一致性、代表性保留集、当前真实费用/时延、修复周期与复发比例尚未形成可用于本次横向排名的完整数据。由业务负责人定义分布与风险，由工程负责人用已有运行和校准工具取数。外部框架部署负担、工具指标迁移效果均需要小试，不能把文档能力当本地实测结果。</p>\n<h3 id=\"4-4-研究覆盖检查\">4.4 研究覆盖检查</h3>\n<p>范围明确；横向趋势、同行、政策、技术四维与纵向学术、工业、架构、自身四维均已覆盖；市场/引用/排名等不足明确披露；关键方法与现状有出处；推断与建议区分；Markdown 已保存；HTML 导出已由本次请求授权，无需重复确认。</p>\n        <footer class=\"footer\">\n          Generated with the four-knowns Apple-style HTML template.\n        </footer>"
};
