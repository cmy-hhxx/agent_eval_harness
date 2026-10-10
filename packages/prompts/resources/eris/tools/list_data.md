查询本地运行、回答与正式对战。

- {}：运行目录及 currentRun.summary，优先有输入的运行中记录，否则最近有输入的记录。
- {runId}：该运行的输入、任务引用和 comparisonGroups。
- {runId,view:"comparisons"}：正式对战目录，含原问预览、结果 reference 和双方 inputs[].reference。案例解读先读结果 reference。

query 是字面筛选：输入目录搜标识和模型名，对战目录搜原问与判词；查全目录时省略，筛选为空可去掉 query 复查。分页用 hasMore / nextOffset；默认顺序取样，不代表随机样本。

summaryScope=run 的统计覆盖整轮，不随筛选或分页变化。inputCount 是回答数，evaluatedInputCount 是已归因回答数，caseCount 是按批次与题目去重的题数。formalComparisonStats 区分结果份数 formalResultCount 与对局场数 comparisonCount；tiers 给各档 wins / losses / both_good / both_bad，草稿与待核不计战绩。

model 用于定位，modelName 用于展示；comparisonTier=null 表示档位未声明，comparisonGroups 是配置。引用原样传给 read_data；完整战绩作图可引用 statistics:{runId,comparisonTier}。
