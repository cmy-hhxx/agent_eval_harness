# 数据与评测契约

[返回首页](../README.md) · 文件位置与命令见[使用指南](usage.md)。

## 唯一规则来源

- 输入与配对：[input.ts](../packages/workflows/src/pairwise/input.ts)。
- 提示词：[系统规则](../packages/agents/src/comparison/profiles/default/system.md)、[独立判对错](../packages/agents/src/critique/profiles/correctness/instructions.md)、[配对比较](../packages/agents/src/comparison/profiles/default/instructions.md)。
- Comparison 的[公开入口](../packages/agents/src/comparison/index.ts)、[业务校验](../packages/agents/src/comparison/validate.ts)和[引用展开](../packages/agents/src/comparison/resolve.ts)。Critique 的[correctness Profile](../packages/agents/src/critique/index.ts)独立维护正确性契约。
- 结果结构：[导出 Schema](../packages/workflows/src/pairwise/schema.ts)。
- 导出与工具回溯：[report.ts](../packages/workflows/src/pairwise/report.ts)、[annotations.ts](../packages/workflows/src/pairwise/annotations.ts)。

项目处于快速迭代阶段，状态、结果 Schema、Profile 和内部协议不设置版本号；当前源码定义唯一契约。

## 输入

`data/sources/model-answers/` 按日期子目录保存四个版本的 JSONL，每行代表一份「批次 × case × 版本」回答。[host.json](../configs/host.json) 为每个版本配置 `sources`：`file` 直接读取一个文件，`directory` 递归读取并可按 `include` 的 basename 匹配（缺省全部 `*.jsonl`）。目录名仅作整理，不参与批次或版本识别，也不要求文件名等于版本 ID。

输入负责按天划分批次，每个版本文件可以包含多个批次。评测直接使用提供的 `batch_id` 原值，不要求日期格式，也不从 `request_time` 或 `ask_time` 重新分组。样本身份为 `batch_id + case_id`：同问句跨批次或在同批次对应不同 case 时分别保留，不按问句文本去重。

| 字段 | 语义 |
|---|---|
| `batch_id` | 优先顶层，其次 `meta.batch_id`，最后配置的 `inputs.default_batch_id` |
| `case_id` | 优先顶层，其次 `meta.case_id`；两处都有时必须一致 |
| `version` | 文件配置决定版本；记录若含该字段，必须与配置 `name` 一致 |
| `request_time` | 缺失或 null 合法；非空字符串原样保留；空字符串和其他类型在预检拒绝 |
| `has_standard_answer` | 可选布尔值，其他类型拒绝；显式为 `false` 时忽略本条记录的 `meta.ground_truth` / `meta.std_answer`；是否独立判对由样本共享标准答案决定 |
| `messages` | 完整问题、回答、工具与图片；消息序号是证据定位依据 |
| `meta` | 采集状态、标准答案、被评模型、原始回答耗时等 |
| `trace_id` | 原始追踪标识 |

`meta.ok=false`、无完整最终回答、无法解析或未知消息类型的记录不能参与比较。标准答案从 `meta.ground_truth` / `meta.std_answer` 获取；排除被显式忽略、缺失、null 和空字符串的值后，剩余值需要一致。同批次、同 case 的有效版本共享标准答案：只要其中一份提供了标准答案，所有参与配对的版本都会独立判对，包括本条 `has_standard_answer=false` 的版本；仅写 `true` 而不提供标准答案也不会生成独立判对任务。

输入结构通过适配器注册表声明。当前注册 `a`（OpenAI 风格 `messages`：`message` / `reasoning` / `function_call` / `function_call_output`）和 `aa`（显式轮次：`user_question` / `llm_turn` / `tool_call` / `tool_result` / `final_answer`），版本配置的 `adapter` 按 id 引用。新增结构只需实现 [InputAdapter](../packages/workflows/src/pairwise/adapters.ts) 并在注册表登记，`adapt` 与配置校验不再分支。适配器保持原始消息和多模态内容，不重排消息序号，不补造缺失回答。每个 `batch_id + case_id + version` 对应一份回答；相同标识出现多份回答时报告标识冲突，使涉及它的配对失效，不擅自选择或覆盖。同批次、同 case 的问题或标准答案冲突会使该样本失效；不同批次分别检查，允许标准答案不同。

不按文件行号配对。实际记录数、缺失版本、配对数和跳过原因通过 `preflight` 获取。`by_batch` 按批次汇总样本数、有效回答数、正确性任务数、配对任务数、跳过配对数和输入异常数。样本数包含已识别身份但回答无效的样本；异常和跳过记录保留批次、case 及已定位输入的文件和行号，无法识别批次的异常只计入全局诊断。文档不保存随数据变化的批次统计。

## 配对

参与对比的版本组合由配置的 `pairs` 声明，每项是两个不同且已登记的版本 ID；不限定模型数量或档案名，DeepSeek、Kimi 等只需登记为版本并写入 `pairs`。稳定输出文件名为 `<版本 A>__vs__<版本 B>.jsonl`。

每个批次内的 case 按配置逐对生成任务；同批次内缺少任一版本只跳过该配对。修改展示名称、增加版本或调整 `pairs` 才会开放新的对比。

候选 A / B 是首次随机分配并持久化的盲测标签，不代表实际组名。导出时恢复稳定版本 ID，配置顺序与候选位置不改变配对文件名。

## 阶段与判决

有标准答案时，对参与配对的每份回答独立判对错；每个配对只等待自身正确性依赖。无标准答案时跳过该阶段，输出 `is_correct=null`、`correctness_reason=""`。

Agent 自主决定读取、检索、图片观察和计算步骤。提示词要求数值争议核算双方，但程序不强制调用某个计算工具或按固定顺序操作。通过 `submit_evaluation` 直接提交，或用 `submit_evaluation_file` 提交工作目录内的 JSON 文件；两者使用相同内容校验和提交修正预算。拒绝时保存 `evaluation-draft.json`，反馈包含 `code/path/message` 及适用的 `candidate/expected/actual`，可用工具获取证据 ID 后修正草稿；每次允许的修正保留一次额外材料或代码工具调用。Host 保存有效收据后才算完成。退出、超时或模型报错保留失败状态，不能转换成都好或都差。

对比判决只有以下四种，不接受普通平局：

| 判决 | 条件 |
|---|---|
| `A_better` / `B_better` | 存在影响核心交付、可靠性或实际可用性的实质差异，证据支持所选赢家 |
| `both_good`（都好） | 双方满足全部核心要求，无实质胜者；每方每项要求都有决定性引用指向中高重要性、已确认优势，且不存在严重问题（含可能推翻结论的未决问题） |
| `both_bad`（都差） | 双方都因严重缺陷无法完成核心任务，无实质胜者；决定性引用分别包含双方已确认的严重问题，缺陷可以不同 |

`task_analysis.requirements` 只列核心验收要求，额外加分项列在 `scoring_points`。`high` 表示决定核心任务成败的优势或缺陷，`medium` 表示影响质量但不单独阻断任务的因素，`low` 表示轻微差异。先判断双方是否完成核心任务，再比较差异是否具体改变关键结论、核心交付的可靠性或实际可用性。都好允许解法、补充内容和轻微瑕疵不同；都差允许双方各有局部优点或不同缺陷。核心交付同样缺失或失效时，仅有更丰富的方法说明不足以胜出；一方完成更多可独立使用的核心子任务，即使另有错误，仍可构成实质优势。

有标准答案时，都好要求双方独立正确性收据均为 `true`；正确性为 `false` 或 `null` 时拒绝都好。独立判对不能直接推出都好，其他核心要求仍须满足；判对后可以因其他核心要求失败而都差，但不能再以已确认的严重正确性错误支持都差。Host 在接收提交、恢复和离线校验时使用对应依赖收据检查这些关系。

提交包含双方评语与 findings、`task_analysis`、`decision_basis`。每个 finding 有候选内唯一且稳定的 `finding_id`，判决按 ID 引用；重排不改变指向，删除被引用发现会报错。Host 在接收提交时将 ID 展开为 `finding_index`，再执行语义校验；收据中的已解析判决和正式结果使用索引。每条 finding 通过从 0 开始的 `requirement_index` 关联任务要求，区分观察、证据确定性和影响。决定性发现必须引用双方已确认发现。`tradeoff` 解释关键差异和反向证据为何支持该判决；都好/都差还须解释为何没有实质胜者。

`counterevidence` 必须完整列出所有中高重要性、已确认的反向证据：有赢家时为赢家问题和输家优势，都好时为双方问题，都差时为双方优势。校验按结构、ID 展开、语义与证据关系依次进行，每阶段汇总可独立判断的错误；前一阶段失败时，依赖它的检查暂不执行。校验只能检查结构与证据关系，不能代替事实和影响判断。

## 证据与导出

配对结果 JSONL 和逐题总结 JSONL 的每行都以 `request_time`、`has_standard_answer` 两个顶层字段开头。`request_time` 取该配对中第一个版本（按 `pairs` 声明顺序）的输入原值，缺失时为 `null`，不受盲测 A/B 交换影响；`has_standard_answer` 为布尔值，表示本题是否有有效标准答案、是否进入客观题独立判对流程，与 `ground_truth.available` 一致。

内部提交使用工具或初始材料提供的 `evidence_id`，绑定输入、消息和原文位置；程序展开为正式结果的 `message_index + quote`。读取、搜索和展开共享公共工具包中的字符串/JSON 表示，不进行模糊匹配。可引用消息内的原始字符串，也可引用该消息按两空格缩进显示的 JSON 连续片段，包括结构化工具返回的字段和数值；`search_trace` 同样支持查找这些片段。图片提交使用图片 evidence ID 与 `observation`，正式结果展开为 `[图像观察]`，工具审计必须存在实际 `view_image` 记录。Host 校验引用、索引和判决关系，事实判断仍需[质量复核](quality.md)。

正式结果使用 `win` / `both_good` / `both_bad`；后两种的赢家字段均为 `null`。赢家、双方评语及判决引用均映射到稳定版本 ID。汇总分别统计各版本胜出数、都好数和都差数，三类互斥且相加等于有效比较数，失败不计入上述分类。评语中的 `【候选A】` / `【候选B】`、`候选A` / `候选B` 及独立 A / B 代号会按盲测映射替换为展示名称；A股、A+H、A浪、方案A等题目术语与证据原文保持不变。

独立判对错任务只使用候选 A，证据必须来自该候选 `final_message_index` 对应的最终回答，不能引用问题、标准答案、工具结果或中间推理。正式正确性行包含 `task_id`、`submission_id`、`input_id`、`case`、稳定 `version` 和 `evaluation`（判对结论、理由、展开的原文证据），保留原始匿名评语。其理由按该任务的实际版本还原，不能套用后续配对任务的 A/B 位置。结果文件位置与恢复规则见[运行产物](usage.md#运行产物)。

`stage` 表示发现属于上下文回溯、推理、执行或最终回答；`stage_trace` 由程序从原始消息生成，包含工具、位置、置信度与来源。只回溯当前 finding 引用的证据；无法唯一定位时保留候选工具，不猜测确定来源。

逐题总结由同一次提交生成，包括问题、要求、判决、双方优缺点、得分点、red flags 和原始回答耗时。耗时统一转为秒，缺失值保持 `null`，不拿裁判耗时替代被评回答耗时。
