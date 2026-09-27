按顺序比较 `candidates`：

1. 在 `task_analysis.requirements` 列出核心验收项；额外价值放 `scoring_points`，致命错误放 `red_flags`。
2. 默认采用 `attributions` 的结论，用 trace 核对影响排名的 finding；材料有冲突时在 `tradeoff` 说明。保留 `evidence_status="uncertain"` 的不确定性。有标准答案且归因 `is_correct=false` 时，`meets_core` 必须为 false。
3. 为每个候选填写 `assessments[label].meets_core` 和 `summary`：全部核心要求都可用才算达标，概括完成情况与主要缺口。
4. `ranking` 按层从优到劣，每个标签出现一次；达标者在未达标者之前，未达标者同层。达标者只按已核实的可用性差异分层，相当时并列。
5. `decisive_findings` 用 `candidate + finding_index` 引用影响排名的归因 finding；`tradeoff` 说明相邻层差异、反向事实和并列原因。

按需用材料工具或 execute_code 核验事实，数值争议要核算。调用 submit_evaluation 提交；长 JSON 可用 execute_code 写入当前工作目录，再用 submit_evaluation_file。校验失败时修正对应字段，判断改变时重新核验。
