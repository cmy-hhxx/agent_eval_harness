# 单样本归因与评分

Attribution 已拆为独立 `workflow: attribution`，Score、Rewrite、Instruction Review 和 Clustering 不属于该 workflow。一个 session 输入按 component → trace → session 三阶段完成归因，只导出 `attribution.jsonl`。具体契约见 [Session 归因](attribution.md)。

旧 `workflow: answer-review` 归因入口已移除；Score 暂不迁入新的 session workflow。

## 归因契约

正式归因文件一行对应一个 session：

| 字段 | 写入方与含义 |
|---|---|
| session_meta | 直接透传输入 session 外层 meta |
| turns | turn 顺序数组；每项包含 meta、summary、problem、is_correct、correct_reason |
| session_summary | 跨 QA 的整体归因总结 |
| session_problem | 与 trace Problem 同形的整体问题数组 |

每条 trace 的 `meta` 直接透传输入 trace meta。`is_correct` 使用 1 表示一致、0 表示不一致、null 表示无标准或无法判断。Problem 使用 `problem_id/component/label/definition/problem_phenomena/reason/evidence/calculations`；evidence 使用 `position/component/quote/reason`，`quote` 最多 400 字。

不再要求 strengths、逐项 criterion_assessments、core_assessment、meets_core、core_reason、维度、阶段、重要性、功能分类或重复调查表。计算错误只用 `calculations[].text` 说明错误算式、正确结果或偏差方向。

组件目录优先读取 trace.meta 的 `tool_names_text` 与 `skill_names_text`，为空时从真实调用派生。组件会话按小现场查看调用前推理、工具参数、返回、下一轮实际输入和后续输出。超大返回首屏有上限，后续最多三次续读，优先 grep，再读取精确字段和短原文。

公共 Runtime 保留动态必读受保护预算和无进展停止。未形成完整提交或预算耗尽由 state 保留失败原因。结构检查不能证明任意自然语言判断的语义完整性，真实样本仍须抽审；技术接收数与有效评审数分别报告。

运行进度以活动 Host 的 `/api/progress` 为准：`updated_at` 是实时观测时间，`checkpoint.savedAt` 是最后派生快照时间，`outbox` 给出待投影事件数、字节数、最早时间和准入是否因积压暂停。queued 等待派发，preparing 等待材料组装或派发确认，running 已派发执行，repairing 是有实际拒收的内容修复，accepted 和 failed 分别为正式收据与终止失败；这些计数互不重复。preparing 仅存在内存，不新增持久化任务状态。Host 不在线时，state 与 progress.jsonl 是恢复依据，不能据其 running 宣称模型仍在执行。

同次尝试复用已组装材料，证据路径索引只在一次组装内存在；初稿提交仍执行结构、程序身份及计算验收，不缓存通过结论。统一 runtime.log 中的 task_prepared、submission_validation、attempt_metrics 分别记录材料准备、验收和 Worker 耗时；不同任务提交只竞争 SQLite 短事务，不再记录全局提交队列等待。materialMs 包含 directoryMs；requiredReadMs 是 submissionMs 内的受保护补读子集，不重复相加。modelMs 是 SDK assistant 消息开始至结束的观测时长，工具、Host 材料 IO 和提交分别计时。输入等待不算模型空闲，但总任务 deadline 始终有效，额度和重试上限不增加。

边界覆盖先按已解析路径和范围排除不可能覆盖的组合，再对剩余组合执行原始来源校验；部分引用仍须落在真实原文范围，不用同文内容替代坐标。该索引不跨尝试保存。

初稿通过验收后直接成为正式结果，不再进入第二次模型会话。程序只验收结构、程序身份、证据坐标与计算一致性；摘要是否漏项、机制解释是否过度、关联责任是否成立等语义质量按真实样本抽审，不用复核会话替代。

Rewrite 只接收 summary、问题和理由文本槽位，不接触证据，不改变原归因或评分。可选改写记录放在 `meta.rewritten`，保持正式顶层六字段。

## Score

Score 和 Attribution 不依赖 Criteria，均排除候选 SYS/DEV。Score 只接收原题、完整最终回答和已接受归因的必要问题事实、责任理由、确定性与证据，不重复调查。程序保留真实责任主体名称，不按组件类型猜测最终或过程影响。

一次会话提交12核心项、24诊断和独立总分，无搜索、复算或调查工具。模型依据问题原文、reason及证据选择最终交付是否仍受影响；已恢复过程问题不自动降低最终总分。问题映射不能增删或改写归因，明确关联最终交付的已确认缺陷不得满分。程序不从已删除的核心完成或阶段字段补造判断，语义遗漏由真实样本抽审发现。

正式评分继续包含 case_id、final_answer_score、evaluations、diagnostics、findings、evidence、explicit_probability、probability_evidence_ids。总分0–10、12核心项0–4、24诊断不另计分；待核保留区间，不适用不补0。

## 运行与恢复

```bash
npm run eval -- preflight --config configs/host.json --config configs/answer-review.json --config /absolute/path/source-and-models.json
npm run eval -- run --stage attribution --run-id answer-review-run --config configs/host.json --config configs/answer-review.json --config /absolute/path/source-and-models.json
```

`--stage score` 确保本条归因先就绪；同run增加评分复用已接受归因。`--input ID=PATH`、`--batch`、`--case`、`--limit-cases` 沿用公共筛选。`--test-eval` 与 `--pilot-cases N` 将真实测试结果放在同来源 `eval_output/test_eval`，试跑范围续跑时保持，显式 `--discover-inputs` 才释放剩余已登记回答。`--balance-channels` 按渠道 traffic_weight 分配完整任务。

Attribution 正式结果只位于 `results/attribution.jsonl`，一行一个 session；component 和 trace 任务不生成结果文件。Score 暂未迁入 session workflow。本地 SQLite 热日志先原子确认收据，outbox 再追加正式行与 progress.jsonl。恢复 state.json 是周期派生摘要，只引用已接受结果，不重复保存正文，也不保留完整失败草稿现场。源输入仍在数据源，不复制到 run。status、validate 使用当前 workflow 读取状态和结果；续跑保存任务 ID、已用次数、预算和收据，不因模型或参数变化拒绝。

新增日期及增量回答沿既定每日run追加，已接受结果不重复评测。自动恢复只选择仍有额度的可恢复任务，内容失败耗尽额度时保留可定位错误。暂停停止新分配并收尾，停止中断并保存，服务重启等待手动启动。AIME默认并发64，可在独立候选配置调整，不与问财混用。来源与持续执行见 [AIME日常评测](aime-incremental.md)。

### 问题字段与填写责任

| 字段 | 定义与条件 | 填写者 |
|---|---|---|
| problem_id | 本条问题编号 | 程序 |
| component | 程序按 taxonomy 和实际工具/skill 填写的固定组件 | 程序 |
| label / definition | 可复用的短问题名和适用边界 | 组件模型 |
| problem_phenomena | 本回答的具体问题现象 | 组件模型 |
| reason | 证据如何证明现象及技术原因 | 组件模型 |
| evidence | `position/component/quote/reason`；quote 最多 400 字 | 模型选证据引用与用途，程序解析坐标和展示组件 |
| calculations | `[{ text }]`，只讲错误算式、正确结果或偏差方向 | 模型 |

组件模型只提交 label、definition、problem_phenomena、reason、证据编号与 reason，以及可选 calculations。trace 模型只写 summary、is_correct、correct_reason；session 模型只写 session_summary 和引用已有 trace Problem 的 session_problem。问题编号、组件、position、quote 和最终数组由程序组装。

程序验证 session/trace Schema、证据坐标与真实原文、400 字 quote 上限、组件身份和引用完整性。程序不能可靠证明摘要没有漏项或机制文字没有过度推断，仍须真实样本抽审。零行、报错和空返回是技术信号，但问题文字必须说明具体请求、返回和对后续结论的影响。

归因探索与修复共用从开始即公开的既有额度，提交不再解锁额外工具次数，不增加总预算或重试。进度 Token 仅累计已归档尝试，同时显示待归档次数和统计覆盖范围；零值不代表没有实际消耗。checkpoint.writeMs 仅统计低频派生快照，不包含本地 SQLite 提交和 outbox 投影；snapshotMs 只衡量快照构造。


原文去重覆盖 JSON 父子范围和文本叶子；跨坐标完全相同的原文只保留一次 quote，also_at 保留全部真实坐标。不再按固定24万字符提前拒收；不改写所选原文，真实模型上下文和请求失败仍由运行时明确报告。Responses 的 off 显式发送 reasoning.effort=none，避免网关因字段缺省继续推理。

网页返回按原始字段保留元数据、短正文，以及长正文的开头和问题标识附近的原文范围；相同正文跨坐标复用。范围始终带真实证据坐标，并标明是片段，不将未展示推断为原始返回不存在。工具执行状态、查询和结构化取数返回不做这种网页正文摘取。
