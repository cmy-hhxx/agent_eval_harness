材料里的 checklist 就是本批全部标准条目。item_index 必须原样使用每条的 index，全局编号不从本批 1 重新开始。item_id、criterion、fail 是标准原文，quality 条目另给 pass、partial，全部条目都带 states、na_when、needs、judge。category 是执行器给定的分类，你不负责归类。task_question 和 answer 是本轮题面与最终回答，user_context 是用户已提供的题面背景。

group=generic：先读 attribution.turn 的完整归因（含 summary、is_correct、problem 与证据），相关 session_summary/session_problem 只辅助理解本轮。归因没有提及某条，不等于该条通过；归因提示调查不完整时也不能默认通过。依据不足、存在冲突或需要引用原文时，按 message_directory 使用 read_trace/search_trace 定向核对。本轮以外的结论不能移植到本轮。

group=category：仅依据题面、用户背景和最终回答，工具只开放这些消息原文以便引用；不提供归因与工具过程，不尝试推测它们。只有用户明确提供的持仓、账户、期限等才是已知背景，不能把回答自述当成用户事实。

逐条判定，每条只判 criterion 这一件事。state 只能取该条 states 里的值：默认 pass / partial / fail / na，部分条目没有 partial。judge=program 的条目只有 pass 和 fail，不适用才判 na。同一条错几次也只算一次，不按出现次数加重。不写分数、不给总分、不做跨条加权或排序。

判 pass / partial / fail 必须至少给一条原文证据，evidence 填工具返回的 reference 序号（evidence_index），不是自己编的编号。归因里的历史 evidence_id 和引文是定位线索，必须重新读取对应原文获得本次工具 reference；不要直接提交历史编号。read_trace 的 candidate 固定为 answer，消息索引见 message_directory。引文必须逐字连续，禁止转述、拼接或改写。判 fail 要指向实际缺陷；判 partial 只在有问题但不影响主答案时使用。

判 na 只有四种情况：该条 na_when 命中；needs 含 trace 但该会话没有轨迹或轨迹不可读；needs 含 user_context 但题面与历史确实没有用户处境；该条所需原文经调查后仍无法取得。na 必须写 na_reason，说明是哪一种以及依据。没有证据时只能判 na，不能默认 pass，也不能因为省事跳过判定。

通用条目需要 trace 时，先看已有归因对此的结论及证据，再定向读取相应工具原文，不重复开展整轮调查。专项条目不能使用工具轨迹；若判定超出已提供材料，判 na 并写清缺少什么。needs 含 user_context 时先看已提供的题面与用户背景，确实没有才判 na。工具预算用尽仍缺依据时也应明确说明，不能默认 pass。

每条都要填 reason，说明依据了哪段原文、为什么是 this state。verdicts 必须覆盖 checklist 每一条恰好一次，提交顺序不限。直接调用 submit_evaluation 提交完整对象；结构或引用错误只修本次提交，保留其余有效字段。
