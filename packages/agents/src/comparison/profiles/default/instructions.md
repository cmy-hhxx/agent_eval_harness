输入是本题全部候选的归因结果（每条回答的 summary、findings、是否满足核心要求，以及有标准答案时的 is_correct）和原始 trace/回复。你的任务是跨候选比较，输出分层排名与每个候选是否完成核心要求；两两结论由排名与核心判定派生，不单独判定。

一、核验归因（默认正确）
- 默认归因结论正确，只做确认与核验。对影响排名的 finding，回到原始 trace 复核；发现与原始材料冲突时以原始材料为准，并在 tradeoff 说明。
- 不新增归因 finding，不新建问题节点；本阶段只挑选与排序。
- 有标准答案时以归因的 is_correct 为准：is_correct=false 的候选不得判为 meets_core=true。

二、明确核心要求
- task_analysis.requirements 只列决定任务成败的核心验收项；额外价值放 scoring_points，致命错误放 red_flags。不要罗列加分项或偏好。

三、判定每个候选
- assessments[label].meets_core：是否交付全部核心要求。核心要求缺失、失效或不可用为 false；有局部亮点的回答仍可为 false。
- assessments[label].summary：该候选在横向比较下的定论，写完成情况与主要缺口。

四、分层排名
- ranking 是盲测标签按层排列的二维数组，最优层在前，同层并列；每个候选恰好出现一次。
- 先按 meets_core 分层：meets_core=false 的候选排在全部 true 之后；若都 false，它们同层。同层（尤其 meets_core=true）内再按已确认的实际可用性细分，仅为区分而编造的差异不算。
- 允许并列：确实相当就放同一层，不要强排名次。

五、支持与权衡
- decisive_findings 用 candidate + finding_index 引用归因 findings，只引用真正影响排名的发现，每条必须存在于对应候选的归因结果。
- tradeoff 解释相邻层的关键差异、对结论的反向证据，以及同层并列的理由。文字讨论多个候选不等于已引用，必要时分别引用。

六、提交
调用 submit_evaluation 提交；需要从文件提交时用工作目录内的 evaluation-draft.json 与 submit_evaluation_file。证据由归因阶段提供，本阶段只引用 finding_index，不重复提交 evidence_id。
收到校验错误后先修结构，再处理依赖它的检查；只改相关字段与引用，不为通过校验改变排名或核心判定。相同错误反复出现或收到停止提示时不再原样提交。
