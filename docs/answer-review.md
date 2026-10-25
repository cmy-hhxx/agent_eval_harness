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

每条问题使用 `problem_id/text/reason/evidence_status/evidence/component/attribution_reason`，有真实缺口时增加 `uncertainties`，确有独立传播或放大时增加 `related_responsibilities`，依赖计算时增加 `calculations`。问题编号、主体名称和证据坐标由程序填写；模型只选稳定编号并写判断。`evidence_status` 为“已确认”或“待核实”，与责任是否已知分开。证据原文去重，`purposes` 标注“问题”“归因”或两者。关联责任只保留一层主体—理由—证据关系。仅有输入输出差异不证明隐藏机制；已知参数生成调用不能因无隐藏推理而写未知。

不再要求 strengths、逐项 criterion_assessments、core_assessment、meets_core、core_reason、维度、阶段、重要性、功能分类或重复调查表。原问与适用规则继续作为判断依据。计算只在问题判断确实依赖计算时记录，并保留来源、单位、期间、分母及程序复算能力。

证据目录、执行节点与转换边界保留在程序端，使用 read_execution 定位，read_trace/search_trace/view_image 读取实际材料。导航编号不构成已读；可读但未读不能写成未采集。生成主责须检查本问题相关来源、实际输入与生成输出，不沿宽泛输入引用遍历全部历史祖先。正确工具不因最终回答错误背责；已知参数生成者不能改成未知。只有输入输出差异时，机制仍是推断。

公共 Runtime 保留动态必读受保护预算和无进展停止；归因已关闭证据业务门，改由模型核查完成性及真实样本抽审。模型判断尚未完成时不得确认，未确认或预算耗尽由 state 保留失败原因。结构检查不能证明任意自然语言判断的语义完整性，真实样本仍须抽审；技术接收数与有效评审数分别报告。

运行进度以活动 Host 的 `/api/progress` 为准：`updated_at` 是实时观测时间，`checkpoint.savedAt` 是最后落盘时间。queued 等待派发，preparing 等待材料组装或派发确认，running 已派发执行（含一次独立复核），repairing 是有实际拒收的内容修复，accepted 和 failed 分别为正式收据与终止失败；这些计数互不重复。preparing 仅存在内存，不新增持久化任务状态。Host 不在线时，state 是恢复快照，不能据其 running 宣称模型仍在执行。

同次尝试复用已组装材料，证据路径索引只在一次组装内存在；提交和确认仍重新执行结构、程序身份及计算验收，不缓存通过结论。统一 runtime.log 中的 task_prepared、submission_wait、submission_validation、attempt_metrics 分别记录排队、材料/目录/准备 CPU、激活/派发、提交锁等待、验收和 Worker 耗时。materialMs 包含 directoryMs；requiredReadMs 是 submissionMs 内的受保护补读子集，不重复相加。modelMs 是 SDK assistant 消息开始至结束的观测时长，工具、Host 材料 IO 和提交分别计时。输入等待不算模型空闲，但总任务 deadline 始终有效，额度和重试上限不增加。

边界覆盖先按已解析路径和范围排除不可能覆盖的组合，再对剩余组合执行原始来源校验；部分引用仍须落在真实原文范围，不用同文内容替代坐标。该索引不跨尝试保存。

初稿进入一次独立上下文复核，复用当前模型、工具与原有任务预算，复核用低推理档（原来关闭推理则保持关闭），直接提供相关原始请求、返回及实际生成输入输出、真实组件选项和完整六字段初稿。重点核对事实与责任形成位置，不主动展开漏报调查，不按组件配额改归责。复核直接提交修订稿，正确内容原样保留；没有成功确认轮或复核修复循环。复核必须交回完整归因，不提供确认或未完成出口；无充分反证的判断原样保留。复核后只沿用结构、真实身份、证据坐标和计算检查，不额外按摘要措辞、完成性问卷或必读数量／覆盖率拒收。结构或来源无效时保留问题草稿，不能复活已被推翻的初稿。

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

### 问题字段与填写责任

| 字段 | 定义与条件 | 填写者 |
|---|---|---|
| problem_id | 本条问题编号 | 程序 |
| text | 哪项主张、行为或交付有什么缺陷，必填 | 模型 |
| reason | 缺陷成立依据、原句限定及实际影响，必填 | 模型 |
| evidence_status | 已确认或待核实，仅描述缺陷确定性 | 模型 |
| evidence | 一份去重原文；用途为问题、归因或两者 | 模型选 index/purposes，程序解析原文坐标；图片观察由模型写 |
| component | 报表中的组件展示名；动作写归责说明，真实断点才填“责任主体未确定” | 程序 |
| attribution_reason | 谁在哪个边界形成问题，依据支持到哪里；未知则说明断点 | 模型 |
| uncertainties | 具体缺口、推断或替代解释；无则省略 | 模型 |
| related_responsibilities | 仅独立传播或放大时填写边界、理由、证据引用及必要缺口 | 模型选择，程序解析主体；不复制原文 |
| calculations | 仅问题依赖计算时必填，保留源数、单位、期间、分母、假设及复算 | 模型填源数与口径，程序核验坐标及算术 |

模型常规提交只有 summary 和 Problem；每条问题必填 text、reason、evidence_status、evidence、responsibility_boundary、attribution_reason。有标准答案才额外提交 is_correct、correct_reason；正式六字段始终保留，meta 与 has_standard_answer 完全由程序填写。判断和说明为简洁中文，真实工具名与引文不翻译。

程序验证结构、实际边界身份、证据坐标与读取记录、相关输入输出覆盖和计算一致性。程序不能可靠证明摘要没有漏项、机制文字没有过度推断、关联责任确有独立作用，或正文是否漏交必要计算；独立复核仍可能复现误判，仍须真实样本抽审。规则信号不能直接当作缺陷：零行、旧来源、原句直送及恢复后的工具失败均须结合具体任务和影响判断。

归因接收口径：证据业务硬校验已关闭，不再因必读覆盖、边界前后匹配、上游来源追查或原数证据匹配触发内容修复。保留 Schema、稳定编号与来源坐标解析、程序身份一致性及计算复算。技术接收不证明评审有效，证据相关性、缺陷成立与语义完成性须真实样本抽审。公共 Runtime 的动态必读受保护预算及无进展停止仍保留，归因不再注册强制必读门。

正式 Problem 及关联责任不输出 `responsibility_boundary`；该稳定编号仅保留在内部模型提交与收据中，用于精确关联真实调用。程序按组件健康度报表生成 component 展示名称，不用展示名称反查身份或去重调用；内部模型名及原始坐标仍可溯源。正文说明具体动作和偏差。

归因探索与修复共用从开始即公开的既有总额度，提交不再解锁额外工具次数，不增加总预算或重试。进度 Token 仅累计已归档尝试，同时显示待归档次数和统计覆盖范围；零值不代表没有实际消耗。checkpoint.writeMs 是累计持久化墙钟时间，不是事件循环阻塞时间；snapshotMs 仅衡量快照构造，不涵盖全部持久化 CPU。

责任组件对齐组件健康度报表：规划子模型、Expert 推理轮、终稿生成轮及具体工具名称由实际调用解析；内部模型代号只用于溯源。展示名相同不合并不同调用。报表风险信号不自动成立为缺陷。
