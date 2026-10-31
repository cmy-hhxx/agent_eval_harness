# 字段用途清单

[数据契约](contract.md) · [Schema](../schemas/README.md)

清单按字段组说明当前数据流、消费者与保留理由。精确结构以对应 Schema 为准，统计上传结构遵守冻结契约。

| 字段或字段组 | 生产者 | 消费者 | 可推导性与保留理由 |
| --- | --- | --- | --- |
| batch_id / case_id / input_id / model version | 输入适配器、Workflow | 分组、续跑、报告、统计 | 业务身份必需；A/B 只在单场内有意义，不能代替稳定模型身份。 |
| source / line / trace 引用 | 输入适配器 | 材料读取、复核、续跑 | 原材料只在数据源保存；引用用于重新定位，不是正文副本。 |
| evaluator_version / judge | Host 收据 | 结果追溯、条件分层 | 保存接受时身份，同 run 可以混合，不能用当前配置倒填。 |
| Criteria 请求的 question / instruction sources | Workflow | Criteria | 原问与适用规范定义交付义务；已匹配调用与返回的技能保留 tool 来源，普通工具事实不成为规范。此阶段不接收标准答案，避免将参考背景变为额外要求。 |
| session_meta / turns[].meta | Workflow | 正式归因JSONL、恢复、Eris | 原样保留外层与各轮输入元信息，不由模型填写；运行与评测器身份由来源收据保存。 |
| ground_truth / 原始标准引用 | 输入适配器、Workflow | Attribution、Comparison 事实核对及正式导出 | 保留完整标准以核验用户所求事实，不能据此扩展题意；不进入 Criteria 请求。 |
| requirements / scoring_points / red_flags | Criteria | Attribution、Comparison | 有不同验收含义；统一作用域和来源绑定避免私规外溢。 |
| is_correct / correct_reason | Attribution | 标准一致性核对 | 只判断与给定标准答案是否一致，独立于问题归因；无标准时 is_correct 固定 null，correct_reason 由程序填写未提供标准的说明。 |
| Problem | Attribution | Comparison、Score、Clustering、报告 | 正式问题及依据、实际影响与严重程度；允许充分评审后的空数组，摘要不替代问题。 |
| Problem.severity / severity_reason | Attribution 的组件调查、Session | 正式归因结果、报告 | 标注每条问题对本次最终交付的已确认影响及分级依据；不参与 Comparison 判胜或聚类身份。 |
| component / responsibilities[].attribution_reason | 程序绑定 Compact 组件，Workflow 投影聚类观察 | 归责、聚类与导出 | component 原样输出目录名称；聚类观察的 attribution_reason 来自 Problem.reason，不新增责任判断。 |
| accepted_attribution / problem_assignments | Workflow、Score | 单次评分及程序导出 | 完成情况、已确认或待核的问题和恢复状态来自接受收据；模型用 finding_index 映射选档，程序保留源问题、责任确定性及证据。 |
| Problem.evidence / calculations | 模型选证据与计算点评 | 程序解析引用、后续事实核对 | 引文保持原始坐标；calculations 只保留文字说明，不触发自动复算。 |
| evidence_id / evidence refs | Agent 与 Host | 引用校验、复核、查看原文 | 可解析坐标，必需；位置合法不证明语义正确。 |
| compact.turns[].components | 原始模型、工具记录及字段 Agent 提取的脚本、skill 名称 | 真实链路组件导航 | 保留程序生成的 components_idx、原始名称、类型、用途与固定 evidence；目录只证明组件存在，不证明有错。 |
| compact.turns[].*.evidence | 代码解析模型的局部选择 | Compact → Attribution 原文复用 | 固定为 {evidence_id, quote}；程序核验原文，坐标与后续阶段一致，摘要文字与原文分开，不允许自由嵌套。 |
| table checks | 表格核验工具 | 疑点定位 | 仅作为核查线索，正式判断及必要计算写入对应 Problem。 |
| comparisons[].slot_index / kind / assessments | Comparison | 排名派生、逐项展示 | 槽位与候选身份显式提交，不依赖数组顺序或动态对象键；共同且可比的差异是判决依据，不能靠问题数替代。 |
| assessments[].summary / tradeoff | Comparison 内部提交 | 正式总评及 decision_basis.tradeoff | 两方摘要描述各自交付；单一 tradeoff 解释整场取舍，避免拼接自相矛盾的两段理由。 |
| quality_winner / relative_preference | Comparison 内部提交 | 排名与偏好展示 | quality_winner 只在双方核心可用且存在实质优势时给出正式胜者；并列内的相对倾向单独表达，完全等价允许 null。 |
| category | Clustering、问题库 | 问题主题、聚类树、目录维护 | 一个问题类只有一个问题方向；单值字段直接表达，不再包装为路径数组。 |
| scope_conflicts[].slot_index / reason | Comparison 内部提交 | 来源复核请求派生 | 共同要求的口径冲突不能从 core 布尔推导；只选择现有共同槽，由程序生成双方既有 review_requests 并停止排名，不改源归因。 |
| assessments.meets_core | Comparison | 正式判决 | 由比较阶段按实际交付判断，不从已删除的归因核心字段补造。 |
| ranking / verdicts | Workflow 确定性派生 | Eris、对战统计、报告 | 模型不重复手写；不同层面供当前消费者直接使用，保持外部契约。 |
| decisive_findings / assessments.*.core_failure_refs | Comparison 校验与 Workflow | 裁决复核、来源追溯 | 从已接受来源选出与胜负方向一致的依据，保留可定位链。 |
| has_standard_answer | Workflow | 统计分母、正式结果消费者 | 与 ground_truth.available 有冗余，正式消费者直接读取，保持现有导出字段。 |
| winner_name | Workflow | Eris、导出阅读 | 可从 winner_version 与模型表推导，当前外部契约保留。 |
| task_analysis / evaluations | Workflow | 独立正式行、报告、结果恢复 | 单行消费及恢复依赖完整上下文；正文只保存在正式 JSONL，state 保留引用。 |
| rewritten / 原归因判词 | Rewrite 与 Workflow | 展示、逐槽复核 | 归因改写独立写入 results/rewrite.jsonl，按源任务关联；正式归因四字段保持不变，失败保留原文。 |
| Rewrite items[].preference | Workflow 从正式结果和源提交派生 | Rewrite 前缀校验与展示 | 复用既有文字字段，固定正式结论及非空相对倾向；不用正文推测身份，null 不造偏好。正文语义仍单独审阅。 |
| Rewrite 整场 items[].text | Workflow 取已接受 tradeoff | Rewrite | 只改这一段既定取舍，不拼接分项重新综合；判决前提放 context。 |
| 材料投影 capture_gaps | Workflow 解析独立视觉采集占位块 | Attribution、Comparison、独立核验 | 标明采集状态、资源引用与原文路径；用户实际渲染保持未知，不进入正式对外 Schema。 |
| state tasks / receipts refs / drafts | Host、Data codec | 同 ID 恢复 | 已接受结果最终仅存 JSONL 引用；写出正式行之前的临时正文用于崩溃恢复，成功后压缩为引用。 |
| cumulativeAttempts / executionLimits | 通用 Host | 实验派发、预算与截止 | 累计额度独立于当前任务清单，任务撤下不退款；不能从当前 states 永久重算。 |
| model-behavior.jsonl | Workflow 从有效归因派生 | 报告、责任审阅 | finding 引用具体问题；按已定位责任、未知责任、未确认分别计数，不提供底座排名。 |
| validation.json / stability trial receipt | 实验 Workflow | 实验复查、报告、恢复 | 样本、条件、方向、结果、缺失和探索性统计；不写生产统计。 |
| validation.execution.tasks / paused_stages / stop_reason / history | 实验 Workflow 从 Host 检查点派生 | 实验报告、失败定位与覆盖审阅 | 保留全部计划任务，包括未派发任务的状态、尝试数、当前失败、等待依赖与执行范围；这是当前快照，历史尝试按 run_id / task_id / attempt_id 查统一 runtime.log。 |
| semantic-review.json | 独立代理或人工审阅 | 实验验收报告 | 与当前改写 task/submission 精确绑定，保存审阅者、结果和理由；未审与失败不能被报告重建抹掉。 |
| wins / both_good / both_bad 及同级统计字段 | 生产统计汇总 | 冻结统计契约与历史资产读取 | 完全冻结，读取与落盘继续严格校验；实验结果和责任分类不进入这些字段。 |

新增字段必须回答谁生产、谁消费、为何不能现算、是否会制造重复权威来源。提示词长度和字段数量都不是质量指标；证据、恢复和当前消费者需要的字段不能为缩短 JSON 随意删除。

answer_generation.reasoning_blocks 保存程序提取的原文与坐标，支持定位首次引入，不能把共享名称当作同一责任。

Attribution 正式文件一行对应一个 session；compact 独立导出过程摘要，trace 是内部任务，只保存在状态和收据中。程序不证明摘要无漏项或机制解释无过度推断，真实样本抽审仍是质量验收依据。

每个 Problem 使用 `component/label/definition/problem_phenomena/reason/severity/severity_reason/evidence/calculations`。`evidence` 单项包含 `position/component/quote/reason`；`quote` 最多 400 字且必须精确连续。`calculations` 只保留文字点评。严重程度语义见[Session 归因](attribution.md#正式契约)。

session 与 trace 的 Problem 同形。`trace.meta` 与 `session_meta` 直接保留输入值，`is_correct` 使用 1/0/null 替代 `has_standard_answer`。

归因探索与修复共用从开始即公开的既有总额度，提交不再解锁额外工具次数，不增加总预算或重试。进度 Token 仅累计已归档尝试，同时显示待归档次数和统计覆盖范围；零值不代表没有实际消耗。checkpoint.writeMs 是累计持久化墙钟时间，不是事件循环阻塞时间；snapshotMs 仅衡量快照构造，不涵盖全部持久化 CPU。

组件统一来自真实消息身份；明确命名的 planner/tool 保留，`llm-call-*`/span/UUID 等匿名 locator 仅按可见职责合并为“规划 / 推理 / 答案合成”，不进入“其他工具”。正式结果不包含 `boundary:N`、`responsibility_chain` 或旧 `evidence_status`。
