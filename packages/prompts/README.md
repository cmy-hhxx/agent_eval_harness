# 评测提示词

此模块是专业 Agent 和 Eris 的模型可见指令、共用材料文案与工具描述的唯一来源。`packages/agents` 选择工具并组装 Profile；Tools 负责执行，Host / Worker 接收装配好的文本。字段形状、业务校验与证据协议以[数据契约](../../docs/contract.md)和[Schema](../../schemas/README.md)为准，不在本页重复定义。

## 资源与装配

| 位置 | 内容 |
|---|---|
| `resources/<stage>/default/` | Criteria、Attribution、Comparison、Rewrite、Clustering 的系统和任务规则 |
| `resources/comparison/verification/` | Comparison 独立首查及揭示后的核验规则 |
| `resources/tools/<tool>.md` | 内置评测工具描述 |
| `resources/shared/` | 材料边界、任务焦点、预算、恢复与无提交补交说明 |
| `resources/eris/` | Eris 系统、恢复及工具规则 |
| [src/index.ts](src/index.ts) | 资源加载、工具清单、提示词渲染及 `sharedPromptResources()` 只读展示入口 |

Workflow 提供 `task_focus` 时，先用 `shared/task-focus.md` 呈现，再放阶段 instructions 与完整材料；展示材料移去重复键，可信输入保持原样。focus 只重复原问、目标、真实标准、可见最终回答、原用户时刻和共同要求，不代替完整材料或改变证据。

内置 Profile 固定 `fileSubmission=false`，通过 `submit_evaluation` 直接提交完整 JSON；核验首查用 `inspect_material` 直接提交核查 JSON，成功后才提供最终提交工具，两阶段共用内容预算。`execute_code` 用于计算和探索。泛型自定义 Profile 可显式启用文件模式，用已有工作目录 JSON 的 path 提交；工具描述附程序给出的 `file_content_schema`。完整阶段、文件错误与预算规则见[归因与判决](../../docs/contract.md#归因与判决)和[工具架构](../../docs/architecture.md#新工具)。

阶段提示词只写实际材料下的判断动作。Criteria 选择原文来源，Attribution 一次核查本方交付及归责，Comparison 使用已接受归因在固定槽比较；可选 verification 先隐藏上游判词再揭示，独立记录核验结果；默认开启的 Rewrite 只润色文本槽，可显式关闭；后置 Clustering 维护问题类，执行后同样默认改写。模型选择数字证据或来源编号，程序保存真实坐标、关联和正式结果；详细提交形状见[各阶段契约](../../docs/contract.md#输入与输出的分层)。

## 提示词写法

- **简短、直接**：同一规则只写一次，工具用法放工具描述，字段形状交给 Schema；共用片段不包含阶段判定规则。
- **材料对应**：先核对本阶段实际输入和可用工具，不提尚未出现的回答、材料或能力。
- **具体动作**：使用请求/结果字段名、真实工具名和普通语言，不另造阶段、角色、框架或分类。
- **职责清楚**：只要求模型核查、判断和选择本阶段可见条目。ID 生成、来源绑定、字段回填、排名派生与落盘由代码完成，不在模型指令中解释实现或要求模型参与；提交字段以当前工具 Schema 为准。
- **索引明确**：区分目录编号、数组位置和证据编号，写清具体字段及起点；固定顺序的槽位按请求逐格对应，不要求模型重建关联。
- **语义一致**：条件未触发、事实未知和已确认失败分别说明；区分 `status` 与 `evidence_status`、标准一致性与核心可用性、输出证据与过程证据。混合效力来源保留整段原文及各条效力，比较优势明确限定为双方均适用方面的单方差异。

共用预算仅展示本轮 `content_call_limit`，有探索工具时再展示 `exploration_call_limit`，有代码工具时再展示 `code_timeout_seconds`；当前剩余额度以工具反馈的 `budget` 为准。运行超时、空闲检测和输出截断参数不进入模型任务说明。

恢复文案携带当前结构化错误及可修复草稿，反馈须指向实际字段和本方可选证据；停止后不向新 attempt 发送旧停止状态、已消耗预算或不可修稿。连续失败草稿不写入新工作目录，文件未加载时不反馈不存在的草稿路径。错误本身及工具执行结果由校验器、Tools 与 Runtime 生成，不在提示词中维护第二套判断逻辑。

## 修改与验证

启动时拒绝缺失、空资源或未知工具描述。修改后运行 `npm run build:app` 并重启 Host；运行中的 Worker 不热读文件。已接受任务保留，同 run 的未完成任务使用本次启动文本。

影响判词的规则、工具描述、材料组装或专家示例变更须人工更新 `evaluatorVersion`；纯搬迁且实际模型文本不变无需更新。不用摘要代替人工声明。验证要求见[开发指南](../../docs/development.md#验证)，语义复核见[评测质量](../../docs/quality.md#真实模型复核)。`--debug` 保存本次启动契约与 attempt 快照；看板只显示运行应用的公开 Profile。

`packages/agents/src/<stage>/fixtures/example.json` 只用于单元测试，不进入模型上下文，专家示例尚未启用。不按运行样本自动检索，也不复制原始输入进 run；不依赖 Pi / Prime 原生 skills。

Eris 的公开提示词入口为 `erisPrompt(toolNames)`；[createEris](../../agent/src/core/profile.ts) 统一装配提示词、Schema 与工具，由 Host 注入数据源、搜索、原文读取和专业网关。能力与数据见[Eris 说明](../../agent/README.md#能力与数据)，修改位置见[Eris 定义](../../agent/README.md#修改-eris)；专业判词仍由对应 Agent 产生。
