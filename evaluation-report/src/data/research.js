// 由 scripts/research.mjs 从研究 Markdown 与 four-knowns 导出正文生成。
window.EvaluationResearchData = {
  "date": "2026-10-13",
  "sources": [
    {
      "id": "meituan",
      "number": 1,
      "title": "美团 · Agent 评测漫谈",
      "url": "https://tech.meituan.com/2026/08/07/Agent-Evaluation.html",
      "date": "2026-08-07",
      "note": "业务标准、人工对齐、评测五环节"
    },
    {
      "id": "aws",
      "number": 2,
      "title": "AWS · Agent 质量评估",
      "url": "https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/",
      "date": "2025-09-19",
      "note": "公开方法与零售、工具调用、交付物案例"
    },
    {
      "id": "bytedance",
      "number": 3,
      "title": "字节 · Data Agent 三层评测",
      "url": "https://developer.volcengine.com/articles/7587631610258784307",
      "date": "原页日期未确认",
      "note": "基础能力、组件与端到端评测"
    },
    {
      "id": "bytedanceMirror",
      "number": 4,
      "title": "字节数据平台 · 三层评测全文",
      "url": "https://www.cnblogs.com/bytedata/p/19399354",
      "date": "2025-12-25",
      "note": "字节数据平台署名同文；Critic、Reflect、复算与 SQL 检查"
    },
    {
      "id": "harbor",
      "number": 5,
      "title": "Harbor · Task",
      "url": "https://docs.harborframework.com/tasks/overview",
      "date": "动态文档",
      "note": "指令、环境、验证脚本与 Trial"
    },
    {
      "id": "harborVerifier",
      "number": 6,
      "title": "Harbor · Verifier",
      "url": "https://docs.harborframework.com/tasks/verifier",
      "date": "动态文档",
      "note": "测试入口、执行时机与 Reward 产物"
    },
    {
      "id": "harborJobs",
      "number": 7,
      "title": "Harbor · Job",
      "url": "https://docs.harborframework.com/jobs/run-a-job",
      "date": "动态文档",
      "note": "多任务、并发与尝试组织"
    },
    {
      "id": "anthropic",
      "number": 8,
      "title": "Anthropic · Agent 评测方法",
      "url": "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents",
      "date": "2026-01-09",
      "note": "任务、试次、裁判与可靠性"
    },
    {
      "id": "openai",
      "number": 9,
      "title": "OpenAI · 开源 Evals",
      "url": "https://github.com/openai/evals",
      "date": "2026-10-13 查询",
      "note": "Registry、Eval、Recorder；对应开源实现，不混同托管平台"
    },
    {
      "id": "google",
      "number": 10,
      "title": "Google ADK · Evaluate",
      "url": "https://adk.dev/evaluate/",
      "date": "动态文档",
      "note": "轨迹与最终回答评测"
    },
    {
      "id": "inspect",
      "number": 11,
      "title": "Inspect AI · 官方文档",
      "url": "https://inspect.aisi.org.uk/",
      "date": "动态文档",
      "note": "Task、Dataset、Solver 与 Scorer"
    },
    {
      "id": "promptfoo",
      "number": 12,
      "title": "promptfoo · 断言与指标",
      "url": "https://www.promptfoo.dev/docs/configuration/expected-outputs/",
      "date": "动态文档",
      "note": "确定性断言与模型判分"
    },
    {
      "id": "deepeval",
      "number": 13,
      "title": "DeepEval · 评测组件",
      "url": "https://deepeval.com/docs/evaluation-introduction",
      "date": "动态文档",
      "note": "测试样本、指标、阈值与测试结果"
    },
    {
      "id": "langsmith",
      "number": 14,
      "title": "LangSmith · Evaluation",
      "url": "https://docs.langchain.com/langsmith/evaluation",
      "date": "动态文档",
      "note": "离线实验、线上评测、人工反馈"
    },
    {
      "id": "ragas",
      "number": 15,
      "title": "Ragas · Agent 工具使用指标",
      "url": "https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/agents/",
      "date": "动态文档",
      "note": "调用准确性、调用 F1 与目标达成"
    },
    {
      "id": "pi",
      "number": 16,
      "title": "Pi · 上游仓库",
      "url": "https://github.com/earendil-works/pi",
      "date": "本地锁定来源见 vendor/upstream.json",
      "note": "Pi 分工另经本地 Runtime 与架构文档核对"
    }
  ],
  "reportHtml": "<blockquote>数据获取时间：2026-10-13</blockquote>\n<h2 id=\"1-企业实践\">1. 企业实践</h2>\n<h3 id=\"美团\">美团</h3>\n<p>业务目标与判据 → 人人对齐 → 人机校准 → 样本采集与清洗 → 人工 / AI 评测 → 质检与归因。问题样本回到判据和回归集。判据尽量拆成是、否、未知，评测覆盖结果、过程、效率与安全。<a class=\"research-cite\" href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\" target=\"_blank\" rel=\"noopener noreferrer\">[1]</a></p>\n<h3 id=\"亚马逊-aws\">亚马逊 AWS</h3>\n<p>按官方文章的三个案例分别还原，并核对文章链接的代码仓库：<a class=\"research-cite\" href=\"https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/\" target=\"_blank\" rel=\"noopener noreferrer\">[2]</a></p>\n<ul><li>零售客服：τ-bench 任务与初始数据 → 模拟用户与 Strands Agent 交互 → 工具改变业务状态 → 预期 / 实际最终状态比较 → 失败归因与轨迹分析。</li><li>天气 Agent：EvalTool 初始化 → VanillaAgent 生成动作 → WeatherEnv / 工具执行 → 观察、奖励回传 → 完成或步数耗尽 → 成功率、进度率与调用有效率。调用有效率按无错误返回计算，不等同于工具选择最优。</li><li>考题生成：工作流与步骤创建 → Agent 调用工具 → 回调记录 → 成功 / 异常收尾 → TaskManager 汇总完成率、工具成功率和耗时。这套执行统计本身不判定题目内容是否正确。</li></ul>\n<p>这是 AWS 的公开示例，不代表亚马逊所有业务共用一套内部流程。</p>\n<h3 id=\"字节-data-agent\">字节 · Data Agent</h3>\n<p>分三张图：基础能力 / 组件 / 端到端的评测分层；SQL 的 RelPM 与 FuncEvalGMN 两条语义评估路径；报告的 Critic 初评、ReAct 工具核验、Reflect 复查和主裁判汇总。报告可读性、展示以及部分主观深度判断仍依靠人工。线上案例持续回到标注与评测集。<a class=\"research-cite\" href=\"https://developer.volcengine.com/articles/7587631610258784307\" target=\"_blank\" rel=\"noopener noreferrer\">[3]</a><a class=\"research-cite\" href=\"https://www.cnblogs.com/bytedata/p/19399354\" target=\"_blank\" rel=\"noopener noreferrer\">[4]</a></p>\n<h2 id=\"2-框架-平台与方法\">2. 框架、平台与方法</h2>\n<div class=\"table-wrap\"><table><thead><tr><th>方案</th><th>类型</th><th>主要流程</th><th>判分方式</th></tr></thead><tbody><tr><td>Harbor</td><td>开源框架</td><td>Job 调度、Trial 生命周期、Verifier、Pi 适配分别成图</td><td>测试脚本生成 Reward <a class=\"research-cite\" href=\"https://docs.harborframework.com/tasks/overview\" target=\"_blank\" rel=\"noopener noreferrer\">[5]</a><a class=\"research-cite\" href=\"https://docs.harborframework.com/tasks/verifier\" target=\"_blank\" rel=\"noopener noreferrer\">[6]</a><a class=\"research-cite\" href=\"https://docs.harborframework.com/jobs/run-a-job\" target=\"_blank\" rel=\"noopener noreferrer\">[7]</a></td></tr><tr><td>Anthropic</td><td>评测方法</td><td>任务与成功条件 → 多次 Trial → 裁判 → 可靠性汇总</td><td>代码、模型、人工；按任务选用 <a class=\"research-cite\" href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\" target=\"_blank\" rel=\"noopener noreferrer\">[8]</a></td></tr><tr><td>OpenAI Evals</td><td>开源框架</td><td>Registry → Eval → 样本执行 → Recorder → 汇总</td><td>Eval 类定义规则或模型判分 <a class=\"research-cite\" href=\"https://github.com/openai/evals\" target=\"_blank\" rel=\"noopener noreferrer\">[9]</a></td></tr><tr><td>Google ADK</td><td>开源框架</td><td>评测集 → Agent 执行 → 轨迹 / 回答评分 → 结果</td><td>参考轨迹、判据与回答指标 <a class=\"research-cite\" href=\"https://adk.dev/evaluate/\" target=\"_blank\" rel=\"noopener noreferrer\">[10]</a></td></tr><tr><td>Inspect AI</td><td>开源框架</td><td>Task / Dataset → Solver → Scorer → 指标与日志</td><td>规则或模型评分器 <a class=\"research-cite\" href=\"https://inspect.aisi.org.uk/\" target=\"_blank\" rel=\"noopener noreferrer\">[11]</a></td></tr><tr><td>promptfoo</td><td>开源工具</td><td>用例 / 提示词 / Provider → 批量调用 → 断言 → 结果对照</td><td>确定性断言、代码、模型 <a class=\"research-cite\" href=\"https://www.promptfoo.dev/docs/configuration/expected-outputs/\" target=\"_blank\" rel=\"noopener noreferrer\">[12]</a></td></tr><tr><td>DeepEval</td><td>开源框架</td><td>样本 → 应用输出 → Metrics → 阈值判定</td><td>任务指标、得分与原因 <a class=\"research-cite\" href=\"https://deepeval.com/docs/evaluation-introduction\" target=\"_blank\" rel=\"noopener noreferrer\">[13]</a></td></tr><tr><td>LangSmith SDK</td><td>开源客户端</td><td>Dataset → Target → 样本 / 汇总评测器 → 实验比较</td><td>开源 SDK 可核对；不视为整个平台源码 <a class=\"research-cite\" href=\"https://docs.langchain.com/langsmith/evaluation\" target=\"_blank\" rel=\"noopener noreferrer\">[14]</a></td></tr><tr><td>Ragas</td><td>开源指标库</td><td>执行记录 → 选择指标 → 计算 → 汇总</td><td>工具调用准确性 / F1、目标达成 <a class=\"research-cite\" href=\"https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/agents/\" target=\"_blank\" rel=\"noopener noreferrer\">[15]</a></td></tr><tr><td>Langfuse</td><td>开源核心、商业扩展</td><td>事件 → 筛选采样 → 队列 → 裁判 → Score</td><td>本图跟踪源码中的 LLM-as-a-Judge 路径</td></tr><tr><td>Phoenix</td><td>源码公开、ELv2</td><td>数据集 → Task → Run → Evaluators → 注释与比较</td><td>可重评已有实验；许可范围见仓库</td></tr><tr><td>OpenCompass</td><td>开源框架</td><td>配置 → 分片 → 推理 → 后处理 → 评测 → 汇总</td><td>客观指标或模型裁判</td></tr><tr><td>EvalScope</td><td>开源框架</td><td>Benchmark → Predict → Review → 聚合；另画 AgentLoop</td><td>规则、模型与基准专项逻辑</td></tr><tr><td>lm-evaluation-harness</td><td>开源框架</td><td>Task → 请求 → 模型响应 → Filters → 指标</td><td>语言模型基准；不是通用 Agent 沙箱</td></tr></tbody></table></div>\n<p>Harbor 的任务由指令、配置、环境与测试组成，可带参考解。Job 将任务、Agent 和尝试次数展开为 Trial，经并发队列执行。可重试异常按配置退避重试；Reward 为零本身不触发异常重试。Agent 执行后同步轨迹与产物，再在共享或独立环境中验证。默认入口 <code>tests/test.sh</code> 生成 Reward，优先读取 <code>reward.json</code>，否则读取 <code>reward.txt</code>；缺失、空值或非法数值进入异常处理。<a class=\"research-cite\" href=\"https://docs.harborframework.com/tasks/overview\" target=\"_blank\" rel=\"noopener noreferrer\">[5]</a><a class=\"research-cite\" href=\"https://docs.harborframework.com/tasks/verifier\" target=\"_blank\" rel=\"noopener noreferrer\">[6]</a><a class=\"research-cite\" href=\"https://docs.harborframework.com/jobs/run-a-job\" target=\"_blank\" rel=\"noopener noreferrer\">[7]</a></p>\n<p>Harbor 源码已有 Pi 适配器：安装 Pi、配置模型 / MCP / Skills、调用 <code>pi --print --mode json</code>，再将会话转换为 ATIF 轨迹并提取用量。任务成败仍交给 Verifier。这与“基于 Pi 编排业务任务”的思路可以直接对照，但不表示本项目使用 Harbor。</p>\n<p>GitHub 查询日为 <strong>2026-10-13</strong>。已查询的评测相关仓库中，Langfuse 35,731、promptfoo 25,952、Google ADK 21,790、OpenAI Evals 19,594、DeepEval 18,776、Ragas 16,003、lm-evaluation-harness 14,200、Phoenix 11,817、OpenCompass 7,507、Harbor 6,055、EvalScope 3,531、Inspect AI 2,991、LangSmith SDK 1,077 Stars。完整仓库链接、许可范围与流程入口在页面的“GitHub 仓库”表中。Stars 表示关注度，不作为评测质量排序。</p>\n<p>共 17 个方案、26 张图。范围以图标题为准，覆盖该流程的输入、执行、分支、回路、判分与产物。开源实现的图下链接固定到本次读取的源码提交；企业实践按公开文章还原，不补造未披露的内部实现。并列节点表示分支或可选评测方式，不承诺底层并行执行。未安装或运行外部方案。源码清单、节点与连接关系维护在 <code>src/pages/research/flows.js</code>。</p>\n<h2 id=\"3-现有评测方案\">3. 现有评测方案</h2>\n<p>基于开源 <strong>Pi</strong>。Pi 是通用 Agent 运行底座，提供模型调用、会话与工具执行循环；评测业务流程由本项目定义。<a class=\"research-cite\" href=\"https://github.com/earendil-works/pi\" target=\"_blank\" rel=\"noopener noreferrer\">[16]</a></p>\n<p><strong>我们做的是把 Pi 任务串起来，并编写工具给 Pi 使用。</strong> 包括评测步骤与提示词、材料绑定、证据读取和检索、代码复算、结果提交，以及结果校验、保存和恢复。</p>\n<p>介绍区使用用户提供的 Pi 官网与 GitHub 截图，只裁切显示官网定位、仓库简介、MIT 许可和 Stars，原图像素保持不变并嵌入离线 HTML。截图的 Stars 是当时页面显示值，独立于 API 查询计数。</p>\n<div class=\"table-wrap\"><table><thead><tr><th>分工</th><th>内容</th></tr></thead><tbody><tr><td>开源 Pi</td><td>模型调用、会话、工具调用循环</td></tr><tr><td>我们的 Host / Workflow</td><td>串联标准、归因、比较等任务；调度与材料传递</td></tr><tr><td>我们的工具</td><td><code>read_trace</code>、<code>search_trace</code>、<code>execute_code</code>、结果提交等</td></tr><tr><td>我们的校验与存储</td><td>结构、业务与证据检查；正式结果与恢复状态</td></tr></tbody></table></div>\n<p>当前生产流程由仓库数据契约维护，案例与实验来源由汇报模块维护。本研究只保留外部方案的资料快照，不重复维护生产实现和案例统计。</p>\n<h2 id=\"4-来源\">4. 来源</h2>\n<ol><li><a href=\"https://tech.meituan.com/2026/08/07/Agent-Evaluation.html\">美团 · Agent 评测漫谈</a>，2026-08-07。业务标准、人工对齐、评测五环节。</li><li><a href=\"https://aws.amazon.com/cn/blogs/china/agent-quality-evaluation/\">AWS · Agent 质量评估</a>，2025-09-19。公开方法与零售、工具调用、交付物案例。</li><li><a href=\"https://developer.volcengine.com/articles/7587631610258784307\">字节 · Data Agent 三层评测</a>，原页日期未确认。基础能力、组件与端到端评测。</li><li><a href=\"https://www.cnblogs.com/bytedata/p/19399354\">字节数据平台 · 三层评测全文</a>，2025-12-25。字节数据平台署名同文；Critic、Reflect、复算与 SQL 检查。</li><li><a href=\"https://docs.harborframework.com/tasks/overview\">Harbor · Task</a>，动态文档。指令、环境、验证脚本与 Trial。</li><li><a href=\"https://docs.harborframework.com/tasks/verifier\">Harbor · Verifier</a>，动态文档。测试入口、执行时机与 Reward 产物。</li><li><a href=\"https://docs.harborframework.com/jobs/run-a-job\">Harbor · Job</a>，动态文档。多任务、并发与尝试组织。</li><li><a href=\"https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents\">Anthropic · Agent 评测方法</a>，2026-01-09。任务、试次、裁判与可靠性。</li><li><a href=\"https://github.com/openai/evals\">OpenAI · 开源 Evals</a>，2026-10-13 查询。Registry、Eval、Recorder；对应开源实现，不混同托管平台。</li><li><a href=\"https://adk.dev/evaluate/\">Google ADK · Evaluate</a>，动态文档。轨迹与最终回答评测。</li><li><a href=\"https://inspect.aisi.org.uk/\">Inspect AI · 官方文档</a>，动态文档。Task、Dataset、Solver 与 Scorer。</li><li><a href=\"https://www.promptfoo.dev/docs/configuration/expected-outputs/\">promptfoo · 断言与指标</a>，动态文档。确定性断言与模型判分。</li><li><a href=\"https://deepeval.com/docs/evaluation-introduction\">DeepEval · 评测组件</a>，动态文档。测试样本、指标、阈值与测试结果。</li><li><a href=\"https://docs.langchain.com/langsmith/evaluation\">LangSmith · Evaluation</a>，动态文档。离线实验、线上评测、人工反馈。</li><li><a href=\"https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/agents/\">Ragas · Agent 工具使用指标</a>，动态文档。调用准确性、调用 F1 与目标达成。</li><li><a href=\"https://github.com/earendil-works/pi\">Pi · 上游仓库</a>，本地锁定来源见 vendor/upstream.json。Pi 分工另经本地 Runtime 与架构文档核对。</li></ol>\n        <footer class=\"footer\">\n          Generated with the four-knowns Apple-style HTML template.\n        </footer>"
};
