# 单样本归因与评分

AIME 使用 workflow: answer-review。每条回答先完成 Attribution，通过后立即启动一次 Score；不同回答持续共享总并发。评分使用已接受归因作为事实依据，不能改写问题、责任或确定性。Workbench 与增量 CLI 共用执行器和状态锁，常规 Rewrite 关闭。单独运行归因使用 `run --stage attribution`，不创建评分任务或占位 score.jsonl，也不启动聚类。

## 归因契约

正式归因 JSONL 顶层只保留六个字段：

| 字段 | 写入方与含义 |
|---|---|
| meta | 程序组装样本、run、评测器版本、任务与提交业务标识、实际模型及来源坐标；源输入元信息原样保留为 source_meta |
| summary | 模型概括实际完成的评审，只概括已登记判断，不能代替问题 |
| Problem | 问题数组；可有多条，也可在充分评审后为空 |
| has_standard_answer | 程序根据本次真实输入确定 |
| is_correct | 仅判断与给定标准答案是否一致；无标准答案固定 null，确实无法判断时为 null |
| correct_reason | 有标准答案时说明比较对象、依据和原因；无标准答案固定 null |

每条问题保留 `problem_id/text/reason/evidence_status/evidence/checks/causes`，必要时增加 `uncertainty/calculations`。问题编号、证据原文坐标、边界种类与实际责任主体由程序解析；模型填写缺陷、原因和影响，选择证据及真实边界，说明责任、推断与缺口。关联责任只有独立传播或放大依据时才存在。缺陷已成立但责任未知时保留缺陷和真实断点。没有标准答案仍调查事实、过程和交付缺陷。

不再要求 strengths、逐项 criterion_assessments、core_assessment、meets_core、core_reason、维度、阶段、重要性、功能分类或重复调查表。原问与适用规则继续作为判断依据。计算只在问题判断确实依赖计算时记录，并保留来源、单位、期间、分母及程序复算能力。

证据目录、执行节点与转换边界保留在程序端，使用 read_execution 定位，read_trace/search_trace/view_image 读取实际材料。导航编号不构成已读；可读但未读不能写成未采集。生成主责须检查本问题相关来源、实际输入与生成输出，不沿宽泛输入引用遍历全部历史祖先。正确工具不因最终回答错误背责；已知参数生成者不能改成未知。只有输入输出差异时，机制仍是推断。

动态必读使用受保护预算，内容修复仍使用既有有限预算；重复缺口无进展时有界停止。未完成、必要证据未读或预算耗尽保存在 state 的失败/未完成状态，不成为成功的空问题结果。结构检查不能证明任意自然语言判断的语义完整性，真实样本仍须抽审；技术接收数与有效评审数分别报告。

运行进度以活动 Host 的 `/api/progress` 为准：`updated_at` 是实时观测时间，`checkpoint.savedAt` 是最后落盘时间。queued 等待派发，preparing 等待材料组装或派发确认，running 已派发执行（含首次完成性确认），repairing 是有实际拒收的内容修复，accepted 和 failed 分别为正式收据与终止失败；这些计数互不重复。preparing 仅存在内存，不新增持久化任务状态。Host 不在线时，state 是恢复快照，不能据其 running 宣称模型仍在执行。

同次尝试复用已组装材料，证据路径索引只在一次组装内存在；提交和确认仍重新执行结构、证据和业务验收，不缓存通过结论。统一 runtime.log 中的 task_prepared、submission_wait、submission_validation、attempt_metrics 分别记录排队、材料/目录/准备 CPU、激活/派发、提交锁等待、验收和 Worker 耗时。materialMs 包含 directoryMs；requiredReadMs 是 submissionMs 内的受保护补读子集，不重复相加。modelMs 是 SDK assistant 消息开始至结束的观测时长，工具、Host 材料 IO 和提交分别计时。输入等待不算模型空闲，但总任务 deadline 始终有效，额度和重试上限不增加。

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

正式结果位于 results/attribution.jsonl、results/score.jsonl 和按需生成的 results/instruction_review.jsonl；恢复 state.json 只引用已接受 JSONL，不重复保存正文。源输入仍在数据源，不复制到run。status、report、validate 使用保存的workflow读取结果；续跑保存任务ID、已用次数、预算和收据，不因模型或参数变化拒绝。

新增日期及增量回答沿既定每日run追加，已接受结果不重复评测。自动恢复只选择仍有额度的可恢复任务，内容失败耗尽额度时保留可定位错误。暂停停止新分配并收尾，停止中断并保存，服务重启等待手动启动。AIME默认并发64，可在独立候选配置调整，不与问财混用。来源与持续执行见 [AIME日常评测](aime-incremental.md)。
