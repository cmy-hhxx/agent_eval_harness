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

`.env` 使用现有 `EVAL_BASE_URL`、`EVAL_API_KEY`，可设置 `AGENT_MODEL` 指定总 Agent 的网关模型、`AGENT_CONTEXT_WINDOW`（默认 131072）、`AGENT_MAX_TOKENS`（默认 8192）。设置 `AGENT_MODEL` 时总 Agent 使用默认 `high` 推理强度；未设置时使用 `configs/local/models.json` 的 Attribution 模型配置及其推理等级（未指定时默认 `high`）。专业调用继续使用现有阶段模型绑定；不加载内置第三方模型目录。

外部搜索使用 Serper。在根目录 `.env` 设置 `SEARCH_API_KEY`，再重新运行 `bash agent/run.sh`；运行中的服务不热读密钥。搜索请求由服务端发送到 `https://google.serper.dev/search` 或 `/news`，密钥不发送给浏览器。未配置密钥或服务请求失败时直接报告搜索错误，不降级为未经检索的答案。

点击左下角“设置”→“常用模型”→“勾选常用模型”，服务端使用 `.env` 的网关地址和密钥读取 `/models`。勾选并保存后，在输入框右下角切换模型与推理等级；`/model` 也使用同一选择器，支持模糊搜索与服务商分组。常用模型按用户保存，当前模型与推理等级写入会话追加记录，刷新、续聊和本机副本转发后保持一致。切换不打断正在执行的轮次，下次用户请求使用新选择。取消当前轮次或关闭服务时，即使模型目录或会话仍在准备，也不会在准备完成后发起该轮模型调用；中断消息仍保留，后续请求可继续。密钥不会发送给浏览器。

设置直接复用上游面板。通用设置包含语言、会话字号、工作步骤展示、性能与用量和繁忙时的发送行为（排队 / 插话），按用户保存，刷新和本机副本间保持同步。默认详细展示工作步骤，字号范围为 10–22 px。排队消息在服务端接收后可编辑、移除或在运行时转为插话；已提交的插话不能再编辑或移除。会话菜单沿用上游的分组、快捷键提示与键盘操作。外观固定浅色；运行状态显示“正在分析”和已用时间。

## 能力与数据

可查询已登记的本地评测运行，分页读消息、搜索本地文本、查看图片、定位证据、做十进制计算，按需搜索外部网页和新闻、读取网页和PDF原文，独立调用 Attribution / Comparison，并保存有正式结果引用的 Markdown 总结。专业任务先固定共同 Criteria；Comparison 支持二至三同档模型，并按需归因后两两裁决。已有归因仅在共同标准完全一致且通过当前校验时复用，否则独立重评并保留原收据。三模型返回 `result.comparisons`，每场都有正式结果与真实引用；复核后引用最终后续任务。看板和批量 Workflow 仍由原入口启动。

`search_web` 用于金融事实核对与评测点评、总结的交叉查证，`search_data` 只搜索本地原始输入。查询工具接受1–4个明确查询计划，最多两路并发；每项可指定最多5个域名、地区、语言和第1–3页，每次取最多10条，合并默认10条、最多20条。支持网页 / 新闻、相对时间范围或包含端点的绝对日期范围。实际请求、耗时、可用credits、失败与合并命中位置均返回；按倒数排名融合排序，规范化URL去重，不改变业务查询参数，没有自动重试或跨会话缓存。查询Schema是当前唯一入口，见[工具Schema](../schemas/eris/tools.json)及[Contracts](../packages/contracts/src/assistant.ts)。

`read_web` 读取公开HTML、PDF和纯文本，返回实际原文、行号及PDF页码。默认80行、最多200行，每个窗口最多20000字符、标题最多500字符，可用字面词及匹配行预览定位、按返回起点续页或指定PDF页；HTML还返回实际正文附件链接。页面含未加载占位时明确标注内容缺口；解析最多200页，目标文件上限15MiB，超时30秒。PDF不做OCR，表格抽取会丢失版式；必须核对相邻表头、单位与脚注。网页仅提取正文，不执行脚本。页面访问限制、无正文、无可抽取文字或截断均明确报告；HTML页面声明发布与修改日期分列，PDF创建时间和财年截止日不充当发布时间。

日期检索条件只是候选过滤：`dateAssessment.within_range`表示搜索或页面声明日期在范围内，不证明当时已公开或未被修订；日期未知的候选需继续核验。历史审查先确定截至日期，再核对首次发布及当时版本，不能用后来的镜像、修订值倒推过去错误。外部事实与原始材料、正式判词和Eris分析分别说明；外部查证不能写回或改变正式判决。精确数字、冲突与否定结论读取原文，联读季度/全年、财年/自然年、经营利润/净利润、百分比/百分点等口径；引用给实际最终链接、PDF页码或必要行号、页面声明日期或检索时点。没有命中不是反证，摘要不足以确认精确数字。查询与原文结果一次性记入会话，刷新、展开及恢复不重新联网；Key仅发送给Serper，原文请求逐跳验证公共地址并固定DNS连接，阻止内网读取。

对话面向关心最终效果、能理解金融分析的业务负责人，采用专业研究员的表达：观点明确、逻辑紧凑、判断犀利，保留金融术语和必要的分析复杂度。盈利质量、现金流兑现、估值溢价、风险溢价和估值锚等概念可直接使用，须对应具体指标、机制或假设，不逐一翻成口语或解释基础定义。问候通常1–3句，数量、覆盖和状态汇总通常不超过120字，常规点评通常200–400字；盈利质量、估值假设、风险比较与完整报告按需展开驱动因素、传导机制和敏感性，不机械压缩关键逻辑。改写先给替换文本，必要时简述关键纠正；追问只补新增判断，不重复上一轮，不在末尾附加无必要的邀约。中间进展每次1–2句，只报告影响结论或进度的重要变化；恢复和下载总结沿用同一风格。

财务推理区分存量、流量和因果：应收余额变动不等于新增利润，也不能单独解释经营现金流同比变化；现金流/净利润是总体覆盖指标，不是逐元利润收现比例。估值倍数溢价须结合成长、资本效率、盈利质量与风险，不直接当作高估或折价依据。观点缺少依据不代表相反结论成立，缺少估值依据时表述为“合理性尚未得到论证”；审阅不为材料作者补造推理过程。情景估值交代假设，不能替代缺失的实际数据，缺少同业财务数据时不倒推同业质量。[IAS 7](https://www.ifrs.org/issued-standards/list-of-standards/ias-7-statement-of-cash-flows.html/) 和 [CFA 相对估值](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/market-based-valuation-price-enterprise-value-multiples)为相关分析依据。

统计区分回答输入数、去重题数与任务数，核对分页完整性和各模型的题目覆盖；同题编号跨批次分别计题，批次名称中的数字不作为本次样本量。只统计数量和状态时据目录交付，不读取回答或正式判词；任务状态不用于猜测等待或失败的原因。解释区分材料事实、正式评测结论和分析，不改写正式判决或归因。单题或两份回答一致不能证明整体可靠，缺失信息按未知处理，不当作零或未发生，也不补造业务偏好；没有实际用量、费用或实测时延不判断消耗和性价比，正文长短不用于推断总 token 用量。金融分析可使用相关指标、估值方法和风险框架，说明口径与成立条件，连接盈利、现金流与估值，不罗列无关知识；改写保留事实和判断边界。数字区分期间、单位、同比/环比、百分比/百分点与发布/修订口径。没有历史、行业或决策基准，不擅自把数值变化定性为大幅、小幅或显著。默认用日期、模型、问题主题与回答片段定位讨论对象，内部编号、工具名和评测器标识留在执行与追溯记录中，用户明确要求技术排查时才提供。目录为空只表示当前没有可查询的评测记录，不能推断当天未评测或原始数据不存在；没有其他入口时直接说明结果缺口与需要接入的数据，不再索要范围。

原始数据由 `AnalysisDataSource` 访问：业务 ID 先定位本地源文件，再读取正文。对原始消息的读取，会话工具记录只保存定位引用，恢复时重新读取；不会把原始输入文件复制进会话。展开读取、搜索或图片工具时，服务端根据当前用户、Session 和已记录的 callId 解析引用，使用只读工具返回材料；前端继续使用上游 ToolDetails、代码块、图片画廊和大图预览，原始消息详情可展开对应证据 ID 与引文。浏览器不能自填工具参数或执行专业任务；读取失败直接显示错误，重新展开可重试。

数据目录返回可直接使用的 `reference`：原始材料为 `runId + inputId`，正式结果为 `runId + taskId`；两者不能混用。本会话独立任务使用 `operationId`。目录、搜索与原始消息的分页结果标明单位、`hasMore` 和 `nextOffset`：消息目录默认 30 条，正文默认 8000 个 UTF-16 字符；无下一页时 `nextOffset` 为 `null`。正式结果整条返回、不分页；缺少时错误会指明其他读取入口。

会话的权威记录为 `data/assistant/users/<user>/sessions/<id>/events.jsonl`；`state.json` 只存列表索引、进度和请求状态。Pi 使用内存 Session，并从追加记录重建消息与压缩边界。模型请求、工具执行前等待相关记录持久化。总结位于 Session 的 `artifacts/`，工具返回浏览器下载链接；保存前逐项核验正式结果引用，引用及 `evaluatorVersion` 保存于该工具结果的元数据并随会话记录持久化，下载正文只保留用户可读的总结。工具步骤摘要呈现业务动作、状态与数量；调用参数不完整或校验失败时仍可呈现动作与状态，不中断页面。技术引用在主动展开详情时可核对。专业任务位于 `operations/<operationId>/execution/`，通过现有 Host 校验和 JSONL 结果提交路径写入。专业任务的过程预览每秒合并一次，仍沿用上游工具事件与序号，完成时写入完整过程；重复的同一预览不再追加。总 Agent 自身的 token 流不受此合并影响。工具的业务 JSON 只保存一份，元数据仅保留读取定位信息。

同一 Session 仅一个进程持锁，其他副本转发请求及原始 Deepseek 多路流；锁 token 与 PID 同时匹配，确认进程退出后才接管。已接收用户请求及专业任务使用 UUID 去重，冲突内容拒绝。失败或中断时，缺失的工具结果和步骤结束记录由上游恢复逻辑补齐：未记录执行开始的调用可按需要重试，已开始但未持久化结果的调用标为结果未知，已记录结果保持原样。结果未知时，只读或幂等调用可重试，有副作用的调用须先核对外部状态；专业任务按原 operationId 读取已接受结果后再决定继续。排队消息会恢复，已发送的请求不盲目重放。

日志仍写入根 `log/runtime.log`、`log/evaluation.log`。`--debug` 才保存专业 Worker 排查材料。

## 模块与上游

- `src/core`：`createEris` 统一装配提示词、Schema、工具和依赖，只依赖公共接口。
- `src/server`：Session / Workspace 产品操作，将 HTTP 和 WebSocket 交给 Runtime。
- `src/client`：原组件装配；没有自定义 CSS。
- `packages/runtime`：Pi、会话执行者、Deepseek Connection/Gateway 接入。
- `packages/data`：追加记录、文件锁、数据与产物 IO。
- `apps/host`：配置、本地数据和专业 Agent 的具体组装。
- `packages/prompts/resources/eris`：总 Agent 提示词和工具文案。
- `schemas/eris`：分析工具输入约束。

界面固定浅色，直接使用 Deepseek 的布局、输入、消息、工具树、Markdown 和代码块源码。长会话沿用上游分页、增量渲染与折叠过程分组；运行计时在独立组件内刷新，避免触发历史正文重绘。MiniMax 等网关的正文 `<think>` 包装在服务端转换为 reasoning 流，分片标签不会混入正文；原始会话仍保留用于 Pi 恢复的消息。思考和工具过程沿用上游折叠组件，业务结果使用上游 ToolDetails 卡片，统计沿用上游 Session / Token 投影。

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

浏览器检查使用 `CHROME_PATH`，默认本机 Google Chrome；浏览器回归包含常用模型勾选、模型搜索与推理等级切换、设置保存与语言切换、运行计时与折叠、排队操作、工具详情和刷新恢复。上游回归包含工具结果恢复，校验未开始、结果未知与已接受调用的区别。性能负载与预算保持原值，包括十万增量前缀重连、240 轮长历史、代码块、分页、Trajectory 和流式期间输入。

视觉检查先运行 `node scripts/build-agent-reference.mjs`，再执行 `AGENT_VISUAL_REFERENCE=1 npm run test:agent:browser`。参考构建反向应用 UI 局部补丁，使用原始上游组件和同一份会话内容；对侧栏、标题栏、消息、Markdown、代码块区域逐像素比较。输入文案、不可用的功能入口和品牌标识属于明确差异。截图与检查结果写入 `.artifacts/agent-browser/`。

### 外部搜索查证基准

先构建应用，再显式运行联网基准：

```bash
npm run build:app
node --env-file-if-exists=.env scripts/search-audit.mjs --live --output .artifacts/search-audit
```

基准使用[预声明的金融文档与口径](../tests/fixtures/search-audit.json)，对比单个自然查询和预声明的互补查询计划，记录Hit@k、空结果/失败、实际耗时与credits，并从已检索命中的URL读取原文。原文字面锚点覆盖用于检查提取，不能代替口径审查或最终事实判断。候选相关性、口径是否支持主张和历史公开证据需逐条人工审查；已知文档Hit@k不等于开放互联网召回率，预声明查询不代表Eris自主查询质量。基准会使用真实Serper额度，不纳入默认离线测试；结果写入指定产物目录，不作为运行缓存。Eris是否实际读原文、引用和保留历史未知状态，还须用真实模型完整会话复核。
