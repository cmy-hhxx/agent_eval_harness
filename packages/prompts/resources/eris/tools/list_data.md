列出运行、回答输入或正式对战。list_data({}) 返回 currentRun 与整轮统计计数。查看某场案例用 list_data({runId:真实运行ID,view:"comparisons",limit:1})，items 直接给原问预览、正式结果 reference 和双方 inputs[].reference；选中后先用正式结果 reference 读取评测输出；双方 inputs[].reference 仅在需要复核原始材料时使用，不通过猜题目或翻整批回答来拼对战。

- list_data({})：返回运行分页、currentRun 及其完整 summary，省略逐场叙述和来源清单。currentRun 优先最近有输入且正在运行的记录，否则最近有输入的记录，selectionReason 说明选择。
- list_data({runId})：返回该运行的输入分页、任务 reference、comparisonGroups 和统计计数；适合按已知输入标识找回答。
- list_data({runId,view:"comparisons",limit:1})：找一场正式对战；query 可按原问、模型展示名或判词关键词筛选，省略时按登记顺序取样。不是随机样本，单例不代表整轮。

query 是字面文本筛选词，不是数据类别；inputs 只搜标识与模型名，comparisons 才搜原问与正式判词。查看完整目录省略 query，不传 inputs、tasks 或空字符串；带筛选的空结果先去掉筛选词查同一运行。inputs 分页默认30条、最多100条；comparisons 默认5场、最多20场，按 hasMore / nextOffset 续页。items / total 只描述当前筛选目录；summaryScope=run 的统计覆盖整轮，不受筛选分页影响，不能用目录项重算统计或把多轮相加。

summary 中 inputCount=登记回答数，evaluatedInputCount=已归因回答数，caseCount=按批次与题目去重的题数；同题不同模型各占一条回答、跨档仍是一道题。finished 只表示运行结束。formalComparisonsAccepted 是正式结果份数，comparisonsPendingReview 是待复核份数，都不是对局场数。

formalComparisonStats 直接给完整正式战绩：formalResultCount 是结果份数，comparisonCount 是两模型对局场数，三模型产生三份两两结果、三场对局。tiers 按声明档位给 models 的展示名和 wins / losses / both_good / both_bad；四类互斥结果须覆盖全部场数，tradeoff 不能覆盖 verdicts。草稿、被取代和待复核结果不计战绩。概览无需读完所有判词；作图用 references:[{statistics:{runId,comparisonTier}}] 引用完整统计，不逐条抄任务坐标。

输入 reference 用于原始材料，tasks 中 reference 用于正式结果，可直接传给 read_data。model 是定位标识，modelName 是展示名；comparisonTier=null 表示未声明，comparisonGroups 只是配置，不证明已完成对局。Fast、Expert 分别分析，不从名称猜档位。任务 purpose 区分正式、草稿与核验；任务数不是对局数。目录主题不是完整问句，具体点评先读该案例的正式评测结果；预览截断不意味着必须回读原始对话。

所有 summary 都只返回整轮统计计数，不携带全量案例与来源清单。comparisons 的原问是至多300字符的预览，正式理由在 read_data 的评测结果页里；分页与筛选只影响 items，不改变全量统计分母。
