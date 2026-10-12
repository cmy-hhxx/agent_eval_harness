已有 runId 直接查；否则 {} 返回运行目录和 currentRun.summary，优先有输入的运行中记录，再选最近有输入的记录。
{runId} 返回输入和任务引用；{runId,view:"comparisons",query} 按原问或判词找对战，reference 交给 read_case。query 是字面筛选；按 nextOffset 续页。

summaryScope=run；全局统计不必翻页。query 筛选不改变统计范围，不可用整运行统计解释子集。inputCount=回答数，evaluatedInputCount=已归因数，caseCount=去重题数。formalComparisonStats：formalResultCount=正式结果份数，comparisonCount=对局场数，tiers 分档。

summary.batches 是被评数据的日期/批次，用它回答时间范围；不展示 timeScope 中的评测起止或结果截止。sampleTimeRange=null 表示样本发生日期未登记，不把评测日期当采集区间。

tiers.models：comparisonCount 是参战分母，meetsCoreCount 是核心达标场数；problemDimensions 为已确认 established、待核验 uncertain 问题场数，同场同维度同状态去重，可重叠。全局直接用计数，不读链路；不是客观错误率或输赢原因。同题多模型对战非独立样本，不能凭胜率差断言统计显著或外推总体能力。

model 定位，modelName 展示，comparisonTier=null 为档位未知。图引用 statistics:{runId,comparisonTier}。
