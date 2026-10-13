查询本地运行、统计与对战目录。累计评测数量、完成进度和总体结论使用 `{"view":"statistics"}`，读取后结合用户问题分析已有数据，解释主要差异及其边界。查看运行目录用 `{}`，返回目录和 currentRun.summary。

view:"inputs" 或 "comparisons" 可省略 runId，优先有输入的运行中批次，其次最近有输入的运行，返回实际 runId 和 selectionReason；无需先查目录。已知目标运行或继续筛选、翻页、换题时传该 runId，服务端严格限定在指定运行，空结果不会自动换批次。随机找一场高质量问句的对战用 `{"view":"comparisons","sample":true,"limit":1}`，自动附完整原问和评测摘要。

view:"statistics" 不传 runId：history 是最近完整发布的累计快照，currentRuns 是运行中批次，可能重叠，分别展示。snapshotAt 是快照时点，requestDates 是数据日期；history 不含问题维度，缺失快照返回 unavailable。
runDirectory.complete=false 时，errors 列出未读运行，目录及自动选择仅覆盖可读运行，不能称为全量或把缺失当零。history 按自身 status 使用；已知 runId 可直接查询，不依赖目录索引。
历史 totalCaseCount=纳入题数，caseCount=至少完成一场的题数；progress.completedCaseCount=完成全部预期对战的题数，completedBattleCount/expectedBattleCount=已完成/预期场数。progress.battleCompletionRate=场次完成百分比，caseCompletionRate=全部对战已完成题数占 totalCaseCount 的百分比，均保留两位小数，分母为零时为 null。stats 分模型、档位，evaluated 是全部参战场次，等于 wins + losses + both_good + both_bad；这四项分别为胜、负、都好、都差场数。winRate 是 wins/evaluated 的百分比，分母包含都好和都差；accuracy.rate 也是0–100的百分比。已有计数和比例直接用于回答，按展示精度舍入；材料足够即可归纳结论。
accuracy 仅覆盖其 count 个有标准答案的样本；first/total 为首字/总耗时（毫秒），input/output 为 token 数。

view:"comparisons" 查询正式对战。query 字面筛选原问、模型或判词，comparisonTier、outcome 精确筛选档位与胜负；默认排除双方都好，可用 outcome:"both_good" 或 "all" 纳入。includeAnalysis:true 同页返回原问、双方 assessments、问题维度、outcomes.reason 和 tradeoff，适合批量分析；按 nextOffset 读完目标范围。
sample:true 先随机召回最多20道不同题，只对完整原问做一次语义筛选，返回有明确目标、需要实质推理或权衡的题目；不按字数、模型输赢或术语筛选。返回数量最多为 limit，可以不足；不通过、漏判或筛选失败的题目不会作为样本返回。items[].questionSelectionReason 给出入选理由，不是评测判词。
换题时 excludeCases 合并已展示的 items[].case 与 selection.rejectedCases，排除同题全部档位。selection.checkedCaseCount、qualifiedCaseCount 只描述本次候选池；remainingCaseCount 包含未抽取题目与未返回的合格题目，unreviewedCaseCount 是其中尚未筛选的题数。空结果只表示本次候选无合格题目，不代表整个运行没有；需要继续时沿用 runId 和排除项。不扩大范围、不用低质量题补足数量。普通分页、指定题目与全量统计不使用质量筛选，精选案例不代表总体分布。

summaryScope=run：query 筛选不改变统计范围，全局统计无需翻页。inputCount=回答数，evaluatedInputCount=已归因数，caseCount=去重题数；formalComparisonStats.formalResultCount=正式结果份数，comparisonCount=对局场数，tiers 分档。模型参战分母不能相加当场数。
tiers.models.meetsCoreCount 是核心达标场数；problemDimensions 为 established（已确认）、uncertain（待核验）问题场数，同场同维度同状态去重，维度间可重叠。同题多模型对战不是独立样本，胜率差不直接代表统计显著性。
summary.batches 是被评数据日期，sampleTimeRange=null 表示样本发生日期未登记。statisticsError 表示统计不可用，已返回的目录仍可使用；retryable:false 的错误需要修复来源后再读。

model 用于定位，modelName 用于展示，comparisonTier=null 表示档位未知。图表引用 statistics:{runId,comparisonTier}。
