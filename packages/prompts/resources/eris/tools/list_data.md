查询本地运行、回答与正式对战；已有 runId 就直接查询。

- {}：运行目录与 currentRun.summary，优先有输入的运行中记录，否则最近有输入的记录。
- {runId}：输入、任务引用与 comparisonGroups。
- {runId,view:"comparisons",query}：按原问或判词定位正式对战，将结果 reference 交给 read_case。

query 字面筛选；省略则查全目录。按 hasMore / nextOffset 翻页。

summaryScope=run 不随筛选分页变化。inputCount 为回答数，evaluatedInputCount 为已归因数，caseCount 为去重题数。formalComparisonStats 的 formalResultCount / comparisonCount 为正式结果份数 / 对局场数，tiers 分档统计。

tiers.models 的 comparisonCount 为参战分母，meetsCoreCount 为核心达标场数；problemDimensions 给各维度已确认 established、待核验 uncertain 问题场数，同场同维度同状态去重，可重叠。全局直接用这些计数，不读链路；不是独立题数、客观错误率或输赢原因。

model 用于定位，modelName 用于展示；comparisonTier=null 为未声明档位。统计图用 statistics:{runId,comparisonTier}。
