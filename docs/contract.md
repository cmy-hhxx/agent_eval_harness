# 数据与评测契约

[返回首页](../README.md) · 文件位置与命令见[使用指南](usage.md)。

## 唯一规则来源

- 输入与配对：[input.ts](../packages/pairwise-eval/src/input.ts)。
- 提示词、提交校验：[index.ts](../packages/pairwise-eval/src/index.ts)。
- 结果结构：[evaluation.json](../packages/pairwise-eval/resources/evaluation.json)，当前 schema `3.4`。
- 导出与工具回溯：[report.ts](../packages/pairwise-eval/src/report.ts)、[annotations.ts](../packages/pairwise-eval/src/annotations.ts)。

当前任务契约为 `pairwise/autonomous-v1`。版本标识用于识别运行内容，不构成历史兼容承诺。

## 输入

`data/inputs/` 保存四个版本的 JSONL，每行代表一份「批次 × case × 版本」回答。文件映射只在 [host.json](../configs/host.json) 维护。

| 字段 | 语义 |
|---|---|
| `batch_id` | 优先顶层，其次 `meta.batch_id`，最后配置的 `inputs.default_batch_id` |
| `case_id` | 优先顶层，其次 `meta.case_id`；两处都有时必须一致 |
| `version` | 文件配置决定版本；记录若含该字段，必须与配置 `name` 一致 |
| `messages` | 完整问题、回答、工具与图片；消息序号是证据定位依据 |
| `meta` | 采集状态、标准答案、被评模型、原始回答耗时等 |
| `trace_id` | 原始追踪标识 |

`meta.ok=false`、无完整最终回答、无法解析或未知消息类型的记录不能参与比较。标准答案从 `meta.ground_truth` / `meta.std_answer` 获取，两者都存在时必须一致。

A / AA 是当前两种输入结构的适配器。保持原始消息和多模态内容，不重排消息序号，不补造缺失回答。追加数据时检查复合主键、问题和标准答案一致性。重复记录会使涉及它的配对失效；同 case 的问题或标准答案冲突会使该 case 失效。

不按文件行号配对。实际记录数、缺失版本、配对数和跳过原因通过 `preflight` 获取，文档不保存随数据变化的批次统计。

## 固定配对

| 比较 | 稳定输出文件名 |
|---|---|
| `a_fast` ↔ `aa_fast` | `a_fast__vs__aa_fast.jsonl` |
| `a_expert` ↔ `aa_expert` | `a_expert__vs__aa_expert.jsonl` |

每个 case 最多两场；同组、跨档位、自身及未登记组合都不生成任务。缺少版本只跳过受影响配对。修改展示名称或增加版本配置不会自动开放其他配对。

候选 A / B 是固定种子分配的盲测标签，不代表实际组名。导出时恢复稳定版本 ID，配置顺序与候选位置不改变配对文件名。

## 阶段与判决

有标准答案时，对参与配对的每份回答独立判对错；每个配对只等待自身正确性依赖。无标准答案时跳过该阶段，输出 `is_correct=null`、`correctness_reason=""`。

Agent 自主决定读取、检索、图片观察和计算步骤；没有强制的 `set_task_contract`、双方计算或工具顺序。通过 `submit_evaluation` 提交，Host 保存有效收据后才算完成。退出、超时或模型报错不能转换成平局。

提交包含双方评语与 findings、`task_analysis`、`decision_basis`。每条 finding 通过从 0 开始的 `requirement_index` 关联任务要求，区分观察、证据确定性和影响。决定性发现必须引用双方；不确定的发现不能决定胜负或平局；重要且已确认的反向证据必须交代取舍。

## 证据与导出

文字证据必须给出原始 `message_index` 和逐字 `quote`。图片证据使用 `[图像观察]`，且工具审计必须存在实际 `view_image` 记录。Host 校验引用、索引和判决关系，事实判断仍需[质量复核](quality.md)。

正式结果使用 `win` / `tie`；赢家、双方评语及判决引用均映射到稳定版本 ID。`not_comparable` 单列保存，不进入正式配对结果。评语中的 `【候选A】` / `【候选B】` 会替换为展示名称，证据原文保持不变。

`stage` 表示发现属于上下文回溯、推理、执行或最终回答；`stage_trace` 由程序从原始消息生成，包含工具、位置、置信度与来源。只回溯当前 finding 引用的证据；无法唯一定位时保留候选工具，不猜测确定来源。

逐题总结由同一次提交生成，包括问题、要求、判决、双方优缺点、得分点、red flags 和原始回答耗时。耗时统一转为秒，缺失值保持 `null`，不拿裁判耗时替代被评回答耗时。
