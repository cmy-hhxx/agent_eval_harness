# Eris

Eris 是通过浏览器使用的 Web Agent，交付 Web 界面与 Node 服务端。启动与维护使用项目的 POSIX 工具链，不提供桌面应用、独立客户端安装或 Windows 启动适配。

在项目根目录启动：

```bash
bash agent/run.sh
```

脚本使用 `lsof` 检查目标端口，启动准备前及构建完成后都会停止占用该端口的旧进程：先发送 TERM，等待最多 5 秒，仍未退出则发送 KILL；端口无法释放时停止启动。其他端口的副本不受影响，`--port 0` 使用动态端口并跳过清理。随后读取根目录 `.env`，检查依赖和两套 SDK 构建，构建独立 Web 应用，等服务监听成功后打开浏览器。正常启动显示清理、准备状态和访问地址；准备失败会输出完整错误并退出，`--debug` 显示全部安装与构建诊断。对话运行时只使用 Pi。首次安装沿用项目的 Node/npm/uv/Python 工具链，见根目录 [README](../README.md)。

```bash
bash agent/run.sh --port 4181 --user alice --no-open
```

默认端口 `4180`、用户 `local`。入口 `/u/alice/` 或 `/?user=alice` 可指定用户；不同端口的本机副本共享 `data/assistant`。只监听 `127.0.0.1`。`userId` 是可信本机环境下的数据归属标志，不是登录或鉴权。按 Ctrl+C 停止服务。

## 模型与设置

`.env` 使用现有 `EVAL_BASE_URL`、`EVAL_API_KEY`；同时配置 `DEEPSEEK_URL`、`DEEPSEEK_KEY` 后，总 Agent 还可使用 DeepSeek V4.1 Flash（模型 ID `deepseek-flash`），通过 Responses API 独立路由到 DeepSeek，默认 `high` 推理强度、1048576 上下文。DeepSeek 只开放 Flash，推理等级为 `off / low / high / max`。两项 DeepSeek 配置必须同时填写；模型目录读取失败或缺少 Flash 时明确报错。

`AGENT_MODEL` 选择初始模型；未指定时，有 DeepSeek 配置优先使用 Flash，否则继承合并配置中的 Attribution 模型及推理等级。当前仓库 Attribution 为 `high`，本地配置可覆盖。

| 初始模型来源 | 推理等级与容量 |
|---|---|
| DeepSeek Flash | `high`；上下文1048576、输出8192，可由 `AGENT_CONTEXT_WINDOW` / `AGENT_MAX_TOKENS` 设置 |
| 显式 `AGENT_MODEL` 指定的评测网关模型 | `medium`；上下文131072、输出8192，可由上述环境变量设置 |
| 未指定模型、继承 Attribution | 使用该阶段配置的推理与容量，不用上述环境变量覆盖；仓库容量见 [host.json](../configs/host.json) |

模型目录 `/models` 返回的容量优先；DeepSeek 另受初始配置上限约束。未保存常用模型时，列出初始模型与各已配置网关的默认模型。用户保存列表后，以首个仍可用的模型作为新会话默认；已有会话保留自己的选择。专业调用继续使用阶段绑定，不加载内置第三方模型目录。

外部搜索使用 Serper。在根目录 `.env` 设置 `SEARCH_API_KEY`，再重新运行 `bash agent/run.sh`；运行中的服务不热读密钥。搜索请求由服务端发送到 `https://google.serper.dev/search` 或 `/news`，密钥不发送给浏览器。未配置密钥或服务请求失败时直接报告搜索错误，不降级为未经检索的答案。

点击左下角“设置”→“常用模型”→“勾选常用模型”，服务端使用 `.env` 中各网关的独立地址和密钥读取 `/models`。勾选并保存后，在输入框右下角切换模型与推理等级；`/model` 也使用同一选择器，支持模糊搜索与服务商分组。常用模型按用户保存，当前模型、服务商与推理等级写入会话追加记录，刷新、续聊和本机副本转发后保持一致。切换不打断正在执行的轮次，下次用户请求使用新选择。取消当前轮次或关闭服务时，即使模型目录或会话仍在准备，也不会在准备完成后发起该轮模型调用；中断消息仍保留，后续请求可继续。密钥不会发送给浏览器。

设置直接复用上游面板。通用设置包含语言、会话字号、工作步骤展示、性能与用量和繁忙时的发送行为（排队 / 插话），按用户保存，刷新和本机副本间保持同步。默认详细展示工作步骤，字号范围为 10–22 px。排队消息在服务端接收后可编辑、移除或在运行时转为插话；已提交的插话不能再编辑或移除。会话菜单沿用上游的分组、快捷键提示与键盘操作。外观固定浅色；运行状态显示“正在分析”和已用时间。

## 能力与数据

可查询已登记的本地评测运行，分页读消息、搜索本地文本、查看图片、定位证据、做十进制计算，按需搜索外部网页和新闻、读取网页和PDF原文，独立调用 Attribution / Comparison，并保存有正式结果引用的 Markdown 总结。专业任务先固定共同 Criteria；Comparison 支持二至三同档模型，Fast 只与 Fast 比、Expert 只与 Expert 比，并按需归因后两两裁决。输入目录返回模型展示名、声明档位和运行配置的比较组；未声明档位或混档的专业比较直接拒绝。已有归因仅在共同标准完全一致且通过当前校验时复用，否则独立重评并保留原收据。三模型返回 `result.comparisons`，每场都有正式结果与真实引用；首次对比前的归因补查完成后，返回主线对比的正式引用；可选事后核验不替换该引用。看板和批量 Workflow 仍由原入口启动。

### 外部查证

`search_web` 用于金融事实核对与评测点评、总结的交叉查证，`search_data` 只搜索本地原始输入。查询工具接受1–4个明确查询计划，最多两路并发；每项可指定最多5个域名、地区、语言和第1–3页，每次取最多10条，合并默认10条、最多20条。支持网页 / 新闻、相对时间范围或包含端点的绝对日期范围。实际请求、耗时、可用credits、失败与合并命中位置均返回；按倒数排名融合排序，规范化URL去重，不改变业务查询参数，没有自动重试或跨会话缓存。每个子请求结束都会释放请求资源；失败HTTP响应不读取正文，只取消响应体，清理不阻塞错误返回。查询Schema是当前唯一入口，见[工具Schema](../schemas/eris/tools.json)及[Contracts](../packages/contracts/src/assistant.ts)。

`read_web` 读取公开HTML、PDF和纯文本，返回实际原文、行号及PDF页码。默认80行、最多200行，每个窗口最多20000字符、标题最多500字符，可用字面词及匹配行预览定位、按返回起点续页或指定PDF页；HTML还返回实际正文附件链接。页面含未加载占位时明确标注内容缺口；解析最多200页，目标文件上限15MiB，超时30秒。PDF不做OCR，表格抽取会丢失版式；必须核对相邻表头、单位与脚注。网页仅提取正文，不执行脚本。页面访问限制、无正文、无可抽取文字或截断均明确报告；HTML页面声明发布与修改日期分列，PDF创建时间和财年截止日不充当发布时间。

日期检索条件只是候选过滤：`dateAssessment.within_range`表示搜索或页面声明日期在范围内，不证明当时已公开或未被修订；日期未知的候选需继续核验。历史审查先确定截至日期，再核对首次发布及当时版本，不能用后来的镜像、修订值倒推过去错误。外部事实与原始材料、正式判词和Eris分析分别说明；外部查证不能写回或改变正式判决。精确数字、冲突与否定结论读取原文，联读季度/全年、财年/自然年、经营利润/净利润、百分比/百分点等口径；引用给实际最终链接、PDF页码或必要行号、页面声明日期或检索时点。没有命中不是反证，摘要不足以确认精确数字。查询与原文结果一次性记入会话，刷新、展开及恢复不重新联网；Key仅发送给Serper，原文请求逐跳验证公共地址并固定DNS连接，阻止内网读取。

对话面向能理解金融分析的业务负责人，默认用短判断配图表或对照表，主动呈现可比较的数量、差距、趋势和组成；追问只补新增信息。搜索从单一精准查询起步，已有链接直接读原文，证据足够即交付；无目标数据的静态页面换已定位来源。模型实际采用的表达、篇幅和场景规则统一维护在 [Eris 系统提示](../packages/prompts/resources/eris/system.md)，本页不重复提示词正文。

同一模型响应中的独立只读工具最多4路并行，包含专业调用或保存操作的批次按声明顺序执行。取消后排队的读取不再启动；每个结果（包括失败）均持久化后才进入下一轮模型请求。多个外部搜索计划应合在一次 `search_web` 内，维持每次最多两路 Serper 请求。具体来源与分页存在依赖时仍需等待前一轮真实引用；并发不替代证据核验，也不增加自动重试或结果缓存。

财务推理区分存量、流量和因果：应收余额变动不等于新增利润，也不能单独解释经营现金流同比变化；现金流/净利润是总体覆盖指标，不是逐元利润收现比例。估值倍数溢价须结合成长、资本效率、盈利质量与风险，不直接当作高估或折价依据。观点缺少依据不代表相反结论成立，缺少估值依据时表述为“合理性尚未得到论证”；审阅不为材料作者补造推理过程。情景估值交代假设，不能替代缺失的实际数据，缺少同业财务数据时不倒推同业质量。[IAS 7](https://www.ifrs.org/issued-standards/list-of-standards/ias-7-statement-of-cash-flows.html/) 和 [CFA 相对估值](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples)为相关分析依据。

### 图表与来源

战绩作图用运行与档位组成的 `statistics` 引用，服务端一次读取并核验该档完整正式统计，把全部结果坐标保存为图表来源；模型无需逐条复制任务清单。单个案例仍用具体 `reference`，普通运行统计用 `runId`。

`show_chart` 支持八种数据图形：数量与排名用 `bar`，时间趋势用 `line`，完整组成用 `pie`，两组逐项差距用 `dumbbell`，密集问题矩阵用 `heatmap`，成对指标关系用 `scatter`，可加总变动贡献用 `waterfall`，原始观测分布用 `histogram`。瀑布累计和分布分箱由程序计算，不能把期末总数重复作为增量，也不能把均值当原始样本。缺失值保持未知；散点至少3个完整观测，差异点图恰好两组，组成图保持完整互斥类别；业务约束由 [工具 Schema](../schemas/eris/tools.json) 与 [图表校验](src/core/chart.ts)共同执行。

图形服务于具体分析问题，不能为样式丰富机械作图。标题给短判断，范围写明期间、比较基准、样本与分母；`annotations` 把最多3处重点绑定到实际数据位置，图下保留对应短注。Fast 与 Expert 分开，不能从少量胜负、相关性或图形外观推断因果和稳定排名；语言与选图规则统一维护在 [Eris 系统提示](../packages/prompts/resources/eris/system.md)与[作图说明](../packages/prompts/resources/eris/tools/show_chart.md)。

视觉沿用 UBS 风格适配的白底、中灰与暗红，A组中灰 `#676767`、B组暗红 `#774143`，颜色不随胜负或类别换序改变。bar、line、pie 使用原生 SVG；其余研究图按需加载本地打包的 Apache ECharts SVG 模块，普通对话不预载图表引擎，也不使用 CDN。图框与正文左对齐，桌面采用紧凑的细边框面板，常见研究绘图区约170–220 px；标题、视图切换与描述统计紧凑排列。差异点图直接附差值列，两行热力图补充后者减前者的差值带；散点图使用成对观测的中位参考线；分布图在数值横轴上叠加原始观测短线、样本中位数和四分位区间（Q1–Q3）（R7线性插值），不是置信区间；瀑布图连接累计水平并显示净变动。派生信息只用于当前图的阅读，不改变正式结果。范围、单位、来源和真实数值随图呈现。图表不显示 hover 提示文字；重点、数值与差值直接呈现，研究图支持方向键查看；数据视图提供可排序的语义表，未知值不改为零。窄屏只在数据表内滚动，减少动态效果与无必要动画。

每张图可在回复内切换图表与可排序数据表，使用已接受的本地记录，不重新联网、评测或修改正式结果。回复以短结论、主图、重点标注和必要对照组成，不新增报告下载入口。图表在完成回复后直接呈现，折叠工作步骤不会隐藏，刷新继续使用保存结果。实现与产品借鉴见 [Hex Threads](https://learn.hex.tech/docs/explore-data/threads)、[Observable 图形选择](https://observablehq.com/blog/essential-charts-code-snippet-observable-plot)与 [ECharts 模块加载](https://echarts.apache.org/handbook/en/basics/import/)。

### 本地运行与结果

目录通过 Workflow 的进度投影，按登记输入与任务标识统计回答数、去重题数、模型覆盖和各阶段状态。默认 `currentRun` 优先选有输入且正在运行的记录，否则选最近开始的有输入记录；零输入维护运行不抢占范围，历史试跑不重复累加。同 case 跨批次分别计题，同题 Fast / Expert 仍计一道题。

仅选中运行读取正式结果并生成 `formalComparisonStats`，历史项保留简要元数据。结果份数与对局场数分列：三模型形成三份两两结果、三场对局。各档战绩按保存配置与正式 `verdicts` 计算，提供档位引用和包含原问、模型展示名、正式理由的短记录；核验、草稿和待核结果不算正式对局。`read_data` 保留完整结果，并为已裁决比较补充 `comparisonScope`。

效果分析使用同档完整统计，案例再补读原问与回答，区分原材料、正式判词和助手分析。目录筛选为空或缺少结果只表示当前查询范围没有对应记录；未记录的指标保持未知。措辞、抽样边界和金融分析要求统一见 [Eris 系统提示](../packages/prompts/resources/eris/system.md)。

原始数据由 `AnalysisDataSource` 访问：业务 ID 先定位本地源文件，再读取正文。对原始消息的读取，会话工具记录只保存定位引用，恢复时重新读取；不会把原始输入文件复制进会话。展开读取、搜索或图片工具时，服务端根据当前用户、Session 和已记录的 callId 解析引用，使用只读工具返回材料；前端继续使用上游 ToolDetails、代码块、图片画廊和大图预览，原始消息详情可展开对应证据 ID 与引文。浏览器不能自填工具参数或执行专业任务；读取失败直接显示错误，重新展开可重试。

`list_data` 不传 `runId` 时列运行及默认 currentRun 的完整 summary，提供时列该运行的回答输入、任务引用和完整 summary；`query` 仅为字面文本筛选，不是目录类别，查看完整目录时省略。summaryScope 为 run 的统计覆盖整个运行，不受目录筛选或分页影响。筛选为空先取消筛选复查，再核对正式结果入口。数据目录返回可直接使用的 `reference`，读取时保持字段原样：原始材料为 `runId + inputId`，正式结果为 `runId + taskId`；两者不能混用。本会话独立任务使用 `operationId`。输入目录每项还给 `modelName`、`comparisonTier`，未声明档位时为 `null`；顶层 `comparisonGroups` 给运行配置中的档位及模型组，配置组不表示已完成对局。目录、搜索与原始消息的分页结果标明单位、`hasMore` 和 `nextOffset`：消息目录默认 30 条，正文默认 8000 个 UTF-16 字符；无下一页时 `nextOffset` 为 `null`。正式结果整条返回、不分页；缺少时错误会指明其他读取入口。

### 会话与恢复

会话的权威记录为 `data/assistant/users/<user>/sessions/<id>/events.jsonl`；`state.json` 只存列表索引、进度和请求状态。Pi 使用内存 Session，并从追加记录重建消息与压缩边界。模型请求、工具执行前等待相关记录持久化。总结位于 Session 的 `artifacts/`，工具返回浏览器下载链接；保存前逐项核验正式结果引用，引用及 `evaluatorVersion` 保存于该工具结果的元数据并随会话记录持久化，下载正文只保留用户可读的总结。工具步骤摘要呈现业务动作、状态与数量；调用参数不完整或校验失败时仍可呈现动作与状态，不中断页面。技术引用在主动展开详情时可核对。专业任务位于 `operations/<operationId>/execution/`，通过现有 Host 校验和 JSONL 结果提交路径写入。专业任务的过程预览每秒合并一次，仍沿用上游工具事件与序号，完成时写入完整过程；重复的同一预览不再追加。总 Agent 自身的 token 流不受此合并影响。工具的业务 JSON 只保存一份，元数据仅保留读取定位信息。

同一 Session 仅一个进程持锁，其他副本转发请求及原始 Deepseek 多路流；锁 token 与 PID 同时匹配，确认进程退出后才接管。已接收用户请求及专业任务使用 UUID 去重，冲突内容拒绝。失败或中断时，缺失的工具结果和步骤结束记录由上游恢复逻辑补齐：未记录执行开始的调用可按需要重试，已开始但未持久化结果的调用标为结果未知，已记录结果保持原样。明确失败的原始材料读取保留错误正文与失败状态，恢复和展开不重新执行该次失败读取；成功读取仍按定位引用重建。结果未知时，只读或幂等调用可重试，有副作用的调用须先核对外部状态；专业任务按原 operationId 读取已接受结果后再决定继续。排队消息会恢复，已发送的请求不盲目重放。

日志仍写入根 `log/runtime.log`、`log/evaluation.log`。`--debug` 才保存专业 Worker 排查材料。

## 模块与上游

- `src/core`：`createEris` 统一装配提示词、Schema、工具和依赖，只依赖公共接口。
- `src/server`：Session / Workspace 产品操作，将 HTTP 和 WebSocket 交给 Runtime。
- `src/client`：原组件装配与分析图表；聊天布局继续使用上游样式。
- `packages/runtime`：Pi、会话执行者、Deepseek Connection/Gateway 接入。
- `packages/data`：追加记录、文件锁、数据与产物 IO。
- `apps/host`：配置、本地数据和专业 Agent 的具体组装。
- `packages/prompts/resources/eris`：总 Agent 提示词和工具文案。
- `schemas/eris`：分析工具输入约束。

界面固定浅色，直接使用 Deepseek 的布局、输入、消息、工具树、Markdown 和代码块源码。相邻正文分片共用一个 Markdown 文档，保留原文换行，在流式、结束与刷新后均正确呈现跨分片的加粗、链接和表格。长会话沿用上游分页、增量渲染与折叠过程分组；运行计时在独立组件内刷新，避免触发历史正文重绘。MiniMax 等网关的正文 `<think>` 包装在服务端转换为 reasoning 流，分片标签不会混入正文；原始会话仍保留用于 Pi 恢复的消息。思考和工具过程沿用上游折叠组件，业务结果使用上游 ToolDetails 卡片，统计沿用上游 Session / Token 投影。

上游 Logo 图形源码与默认引用已移除，官方品牌插件不装配。原创 Eris 标记通过品牌插槽显示在侧栏、欢迎页与运行状态，同一 SVG 用作浏览器图标；页面标题和品牌名称统一为 Eris。不提供主题切换、第三方模型市场、编程工具或工作目录管理。

来源基线和变更见 [upstream.json](../vendor/upstream.json)、[源码映射](../vendor/deepseek/sources.json)、[局部补丁](../vendor/deepseek/local.patch)及 [MIT 许可证](../vendor/deepseek/LICENSE)。普通构建完全使用本仓库源码，只构建 Web 资源与共享 Runtime；只有维护命令 `node scripts/vendor-deepseek.mjs <上游仓库>` 才读取外部仓库，并重新应用已登记补丁。维护时替换所选包的源码与测试，删除上游已移除的文件，不引入桌面或客户端构建入口。

## 修改 Eris

| 修改内容 | 唯一入口 |
|---|---|
| 身份、工作规则、恢复指令 | [system.md](../packages/prompts/resources/eris/system.md)、[recovery.md](../packages/prompts/resources/eris/recovery.md) |
| 各工具的模型可见说明 | [resources/eris/tools/](../packages/prompts/resources/eris/tools/) 中的独立 Markdown 文件 |
| 工具参数 | [schemas/eris/tools.json](../schemas/eris/tools.json) |
| 工具注册、校验和执行 | [core/tools.ts](src/core/tools.ts) |
| 完整 Agent 定义 | [core/profile.ts](src/core/profile.ts) 导出的 `createEris` |
| 界面名称和标记 | [brand.js](src/client/brand.js)、[eris.svg](src/client/brand/eris.svg)；浏览器标题通过 [vite.config.mjs](vite.config.mjs) 的上游 `DSH_CLIENT_TITLE` 配置；欢迎语维护在上游 [local.patch](../vendor/deepseek/local.patch) |

新增工具时同步 Schema、工具说明、执行器与测试；Host 仅注入 `ErisDependencies`，不再单独拼装提示词。构建并重启 `bash agent/run.sh` 后生效。当前工具提供数据分析、外部金融搜索和专业评测；命令执行、数据整理与持续监控尚未接入。

## 验证

```bash
npm run typecheck
npm test
npm run test:integration
node scripts/test-clean.mjs
npm run test:agent:upstream
npm run test:agent:browser
npm run test:agent:performance
```

浏览器检查使用 `CHROME_PATH`，默认本机 Google Chrome；浏览器回归包含常用模型勾选、模型搜索与推理等级切换、设置保存与语言切换、运行计时与折叠、排队操作、工具详情和刷新恢复。上游回归包含工具参数的增量解析与封口、Unicode 摘要边界、会话事件路由、结构化草稿恢复、统计面板交互和工具结果恢复，校验未开始、结果未知与已接受调用的区别。性能负载与预算保持原值，包括十万增量前缀重连、240 轮长历史、代码块、分页、Trajectory 和流式期间输入。

视觉检查先运行 `node scripts/build-agent-reference.mjs`，再执行 `AGENT_VISUAL_REFERENCE=1 npm run test:agent:browser`。参考构建反向应用 UI 局部补丁，使用原始上游组件和同一份会话内容；对侧栏、标题栏、消息、Markdown、代码块区域逐像素比较。输入文案、不可用的功能入口和品牌标识属于明确差异。截图与检查结果写入 `.artifacts/agent-browser/`。

### 外部搜索查证基准

先构建应用，再显式运行联网基准：

```bash
npm run build:app
node --env-file-if-exists=.env scripts/search-audit.mjs --live --output .artifacts/search-audit
```

基准使用[预声明的金融文档与口径](../tests/fixtures/search-audit.json)，对比单个自然查询和预声明的互补查询计划，记录Hit@k、空结果/失败、实际耗时与credits，并从已检索命中的URL读取原文。原文字面锚点覆盖用于检查提取，不能代替口径审查或最终事实判断。候选相关性、口径是否支持主张和历史公开证据需逐条人工审查；已知文档Hit@k不等于开放互联网召回率，预声明查询不代表Eris自主查询质量。基准会使用真实Serper额度，不纳入默认离线测试；结果写入指定产物目录，不作为运行缓存。Eris是否实际读原文、引用和保留历史未知状态，还须用真实模型完整会话复核。
