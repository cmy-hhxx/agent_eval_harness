定位已登记的本地评测运行、输入与正式任务。未知运行从 list_data({}) 开始，不填 "."、路径或猜测的 ID。

- list_data({})：返回运行分页、currentRun 及其完整 summary，省略逐场叙述和来源清单。currentRun 优先最近有输入且正在运行的记录，否则最近有输入的记录，selectionReason 说明选择。
- list_data({runId})：返回该运行的输入分页、任务 reference、comparisonGroups、完整 summary，以及正式战绩的 records / references。问原因时据此选案例，再读原问和回答。

query 是字面文本筛选词，不是数据类别。查看完整目录省略 query，不传 inputs、tasks 或空字符串；带筛选的空结果先去掉筛选词查同一运行。分页默认30条、最多100条，按 hasMore / nextOffset 续页。items / total 只描述当前筛选目录；summaryScope=run 的统计覆盖整轮，不受筛选分页影响，不能用目录项重算统计或把多轮相加。

summary 中 inputCount=登记回答数，evaluatedInputCount=已归因回答数，caseCount=按批次与题目去重的题数；同题不同模型各占一条回答、跨档仍是一道题。finished 只表示运行结束。formalComparisonsAccepted 是正式结果份数，comparisonsPendingReview 是待复核份数，都不是对局场数。

formalComparisonStats 直接给完整正式战绩：formalResultCount 是结果份数，comparisonCount 是两模型对局场数，三模型一份结果含三场。tiers 按声明档位给 models 的展示名和 wins / losses / both_good / both_bad；四类互斥结果须覆盖全部场数，tradeoff 不能覆盖 verdicts。草稿、被取代和待复核结果不计战绩。概览无需读完所有判词；作图用 {statistics:{runId,comparisonTier}} 引用完整统计，不逐条抄任务坐标。

输入 reference 用于原始材料，tasks 中 reference 用于正式结果，可直接传给 read_data。model 是定位标识，modelName 是展示名；comparisonTier=null 表示未声明，comparisonGroups 只是配置，不证明已完成对局。Fast、Expert 分别分析，不从名称猜档位。任务 purpose 区分正式、草稿与核验；任务数不是对局数。目录主题不是原始问句，具体点评须补读正文。
