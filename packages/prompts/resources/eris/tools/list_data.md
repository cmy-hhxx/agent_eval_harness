查询共享只读评测数据目录。list_data({}) 按记录时间列运行，返回 currentRun 及程序算出的 summary；list_data({runId}) 分页列出该运行的回答输入和任务引用，并返回该运行的完整 summary。

问当前数据量或进度时，只需 list_data({}) 的 currentRun.summary，答复为至多120字的一段：最近一轮的题数、回答数、已归因回答数、正式对局场数和待复核结果份数；有失败或阻塞则补其数量。默认优先最近有输入且正在运行的记录，否则取最近有输入的记录，selectionReason 明示选择规则。对用户明确为“最近一轮”，不附内部编号、模型覆盖、批次、任务总数或去重解释，不遍历历史。finished 表示运行结束，不证明全部评测完成。summaryScope=run 覆盖整个运行，query、offset、limit 仅影响 items，筛选不改变 currentRun。

query 是字面文本筛选词，不是数据类别。查看完整输入目录时省略 query，不传 "inputs"、"tasks" 或空字符串。带 query 的空列表只表示没有匹配项；先去掉筛选词查同一运行，核对分页，再判断数据缺口，不以同一筛选词换查多个运行证明没有数据。

用户未提供内部引用时主动定位，不要求提供 runId 或 taskId。运行列表的 total 是运行数，不能回答“评测了多少条数据”；采用 currentRun.summary 的回答数与题数。目录只覆盖已登记运行；无筛选的运行目录也为空时，只说明当前没有可查询的评测记录。

返回 kind、分页单位、hasMore、nextOffset；默认 30 条、最多 100 条。输入项的 reference 用于读取原始消息，任务项的 reference 用于读取正式结果，可直接传给 read_data。

kind=inputs 还返回运行配置的 comparisonGroups；组内 models 给模型标识与展示名，comparisonTier 给声明的档位。每条输入的 model 用于定位，modelName 用于用户正文，comparisonTier 为 null 表示档位未声明。Fast 只能与 Fast 比，Expert 只能与 Expert 比，按声明和分组确认范围，不从名称猜测。配置组不代表已完成对局；分析具体案例时继续读取原问和必要回答片段，不把 caseId 或目录主题作为题目正文。

formalComparisonStats 是当前运行全部已接受且未被取代的正式战绩，按保存配置与正式 verdicts 程序计算，不由模型数长正文。formalResultCount 是结果份数，comparisonCount 是两模型对局场数，三模型一份结果含三场。tiers 分档给对局数、模型展示名、wins/losses/both_good/both_bad 和 references；records 给各结果的原问、scope.comparisonTier、各模型正式类别与短理由、正式点评和 tradeoff。tradeoff 的相对评价不能覆盖 verdicts 的胜负或双方均好/均差。问四模型效果直接使用战绩，至多250字共四句：先一句判断，Fast、Expert 各一句成对战绩（本档场数、A胜、B胜、双方均好、双方均差，零类别省略）与一个决定差异的案例短语，最后一句样本限制。只选两条短依据，无需读完所有完整判词，不逐场罗列；有双方均好或均差不能概括成全胜或全负。

kind=inputs 中任务的 purpose 区分 comparison_formal、comparison_draft 和 comparison_verification；核验可能生成最终正式结果，但任务完成数不是对局数。summary.formalComparisonsAccepted 与 formalComparisonReferences 是正式结果份数与可读引用；comparisonsPendingReview 是待复核结果份数，不能称作对局场数。草稿、被取代和待复核结果不计战绩。缺少正式结果不补零或从配置覆盖推断已完成。

summary 的 inputCount 是登记回答数，evaluatedInputCount 是完成归因的回答数，caseCount 是按 batchId + caseId 去重后的题数；同题不同模型各占一条回答，同题 Fast、Expert 仍是一道题，跨批次同编号分别计题。kind=inputs 的 total 仅为筛选后的回答数，输入下的 tasks 会重复列出共享任务，不用分页项重算完整统计。数量采用 summary，战绩采用 formalComparisonStats，具体点评才补读原材料。批次名中的数字不是样本量；状态未说明原因时不自行解释。
