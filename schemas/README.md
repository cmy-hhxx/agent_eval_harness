# Schema

这里是仓库中评测及分析助手 Schema 的唯一集中目录。先看本页，再按任务打开对应文件；原始评测输入由 `a` / `b` 适配器接入，不维护覆盖所有来源格式的总 Schema。

| 目录 | 内容 |
|---|---|
| `criteria/` | 共同验收基准阶段的请求、`source_indices/text` 扁平提交与程序生成的固定 `task_analysis`；submission/result 分离 |
| `attribution/` | 单条回答归因请求、固定 strengths/problems 行与统一 basis_index、程序绑定后的 judgment 与正式结果 |
| `comparison/` | 请求、一次对比提交与结果；可选独立核验的原材料 inspection 与最终 verification-submission；首查与确认共用同任务预算 |
| `rewrite/` | 改写阶段的请求、提交和结果；只交换文本槽位、不解析证据，模型提交 texts 数组，Workflow 绑定正式槽位身份 |
| `clustering/` | 聚类阶段请求、短编号提交与持久化结果；显式来源复核及引用型待观察池 pending-observations.schema.json |
| `workflow/` | Workflow 组合后的正式导出、回溯标注与聚类产物 Schema |
| `eris/` | 独立分析助手的数据读取、专业任务与图表工具输入 |

## 文件含义

- `request.schema.json`：Host 组装给 Agent 的内部请求护栏，不是原始数据源契约。
- `submission.schema.json`：模型提交入口。主线四阶段最多两层对象，固定槽位按序返回，来源、证据和其他可选目录使用短数字。Attribution 不输出 canonical ID，内部 `judgment.schema.json` 只供程序绑定后的证据和业务校验；它不会发送给模型。独立核验的引用对象由 Profile 投影为 evidence_index。各阶段从可信请求约束选择范围与数量。
- `result.schema.json`：Host 解析并接受后的阶段结果；有证据的阶段使用 `message_index` 和 `quote`。归因结果由 Host 加入 `has_standard_answer/task_analysis`，对比结果由 Host 加入 `task_analysis`。
- `workflow/export.schema.json`：加入身份、模型信息、共同标准与归因任务引用、归因评语、回溯标注和派生判决后的正式两两对比行，仅接受 `status=decided`。
- `workflow/statistics-log.schema.json`：已冻结的统计日志外部契约，覆盖完整日志信封、累计总计、逐日统计和全部嵌套字段；所有 `wins` 同级紧随必填非负整数 `both_good / both_bad`，涵盖模型、场景、难度及趋势。生成日志落盘前与恢复日志上传前严格校验。仅允许数值、标签内容和日期条目更新，未经用户明确授权不得修改结构。
- `attribution/result.schema.json`、`comparison/result.schema.json`、`clustering/result.schema.json`：各自包含可选 `rewritten` 槽位，原字段不变；Workflow 在改写成功后写回。
- `workflow/clustering.schema.json`：聚类阶段接受后的归类产物行，按模型与批次引用观察和归类决定。
- `workflow/clustering-job.schema.json`：独立跨 run 聚类作业的归类及改写结果，记录多日期、原归因收据和样本坐标；进度通过任务 ID 引用正式结果。
- `eris/tools.json`：独立分析助手的数据读取、专业任务与图表工具输入，不接受自行填写的专业判词。工具 Schema 直接发送给网关，正则不得使用环视；`runId` 以字母或数字开头，只含字母、数字、下划线、连字符和不连续的点，长度最多 181 字符，由 `pattern` 与 `maxLength` 共同约束。统计图类型与字段直接以 `show_chart` Schema 为准；`show_comparison` 接收双方独立论证分支，每项由 evidence 一句依据和 impact 一个明确影响组成，身份与正式胜负由引用绑定；可选 highlights 和 reasonHighlight 只能强调原文中唯一出现的连续短语，每项最多一处、每处最多16字，整图含顶部理由最多两处，不接收 HTML 或样式。本地评测图核验正式引用，外部材料图通过 `source` 说明来源，正文提供原文链接。图表不接收 HTML、脚本、回调或远程数据配置；执行校验见 [chart.ts](../agent/src/core/chart.ts) 和 [comparison-diagram.ts](../agent/src/core/comparison-diagram.ts)。

Criteria 的 submission 接收三组 `{source_indices,text}`，同一来源可支持多个独立检查项。程序生成身份、作用域及包含完整原文的验收依据。Attribution 用单个 json 字符串传输，Worker 严格解码后按 submission 验证；内容是固定 strengths/problems 两数组及标量，每种行不含互斥字段，统一用 basis_index 选择真实依据；无标准答案时也保留明确的空对错字段。`judgment.schema.json` 只校验程序绑定后的内部判断，不是模型入口。正式结果继续保留完整证据坐标与来源身份。

普通 Comparison 提交 a_summary、b_summary、comparisons、可选 preference、必填 relative_preference（A 或 B）、a_tradeoff 和 b_tradeoff；行内也是双方字符串，没有嵌套候选对象。对比前可由 Workflow 执行最多一轮归因补查，正式接受后不自动重开。独立 verification 的核验记录不改主线判词。Rewrite 的 submission 只接收同序 texts，Workflow 绑定 `{id,text}` 后按 result 验证及保存，原收据格式不变。

专业评测 Schema 修改顺序：Schema → 对应 Profile 的 `index.ts` → `validate.ts` /（如有）`resolve.ts` → [集中提示词](../packages/prompts/README.md)、测试样例和测试。分析助手工具输入改动同步 `agent/src/core/tools.ts`、提示词与测试。不要为旧 Schema 保留别名或兼容入口；项目哈希、摘要和跨 run 结果缓存规则见[开发指南](../docs/development.md#禁止项目哈希与兼容层)。
