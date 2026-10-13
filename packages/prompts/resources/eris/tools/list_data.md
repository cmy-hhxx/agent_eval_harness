查询本地运行、统计与对战目录。省略 runId 返回运行目录和 currentRun.summary，优先有输入的运行中记录，其次最近有输入的运行；提供 runId 时按 view 读取该运行。

view:"statistics" 不传 runId：history 是最近完整发布的累计快照，currentRuns 是运行中批次，可能重叠，分别展示。snapshotAt 是快照时点，requestDates 是数据日期；history 不含问题维度，缺失快照返回 unavailable。
历史 totalCaseCount=纳入题数，caseCount=至少完成一场的题数；progress.completedCaseCount=完成全部预期对战的题数，completedBattleCount/expectedBattleCount=已完成/预期场数。stats 分模型、档位，evaluated 是参战分母，wins、both_good、both_bad 之外为负场。accuracy 仅覆盖其 count 个有标准答案的样本；first/total 为首字/总耗时（毫秒），input/output 为 token 数。

view:"comparisons" 查询正式对战。query 字面筛选原问、模型或判词，comparisonTier、outcome 精确筛选档位与胜负；默认排除双方都好，可用 outcome:"both_good" 或 "all" 纳入。includeAnalysis:true 同页返回原问、双方 assessments、问题维度、outcomes.reason 和 tradeoff，适合批量分析；按 nextOffset 读完目标范围。
随机找一题用 sample:true,limit:1；换题时 excludeCases 传已展示的 items[].case，排除同题全部档位。selection 给出可选与剩余题数；空结果表示没有符合条件的案例。

summaryScope=run：query 筛选不改变统计范围，全局统计无需翻页。inputCount=回答数，evaluatedInputCount=已归因数，caseCount=去重题数；formalComparisonStats.formalResultCount=正式结果份数，comparisonCount=对局场数，tiers 分档。模型参战分母不能相加当场数。
tiers.models.meetsCoreCount 是核心达标场数；problemDimensions 为 established（已确认）、uncertain（待核验）问题场数，同场同维度同状态去重，维度间可重叠。同题多模型对战不是独立样本，胜率差不直接代表统计显著性。
summary.batches 是被评数据日期，sampleTimeRange=null 表示样本发生日期未登记。statisticsError 表示统计不可用，已返回的目录仍可使用；retryable:false 的错误需要修复来源后再读。

model 用于定位，modelName 用于展示，comparisonTier=null 表示档位未知。图表引用 statistics:{runId,comparisonTier}。
