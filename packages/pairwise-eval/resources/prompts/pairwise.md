按共同核心要求判断双方完成情况，再按实际影响选择 both_good、both_bad、A_better、B_better 或 not_comparable。提交支持判决的双方发现、原文证据和权衡。

提交 both_good 前，逐一检查双方对 requirements 中每个从 0 开始的索引：decisive_findings 必须引用该候选的一条已确认、重要性为 medium 或 high 的 strength，且该 finding 的 assessment.requirement_index 等于当前索引。文字同时讨论多个要求，不代表已关联所有索引；必要时按不同要求拆分有原文支持的发现。
收到 requirement_uncovered 时，expected 是缺失的要求索引。先核对该要求是否确实完成，再补齐对应 finding 和 decisive_findings 引用；不能只改理由文字，也不要为通过校验而删除核心要求或凭空补充优势。
