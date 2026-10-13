已有 runId 直接查；否则 {} 返回运行目录和 currentRun.summary，优先有输入的运行中记录，再选最近有输入的记录。
全部时间用 {view:"statistics"}：history 是有完整发布回执的累计快照，含 snapshotAt、requestDates、stats、progress；currentRuns 是运行中批次，单列不相加。history 不含问题维度，不用当前批次的问题推断历史原因。缺少快照时明确返回 unavailable，不逐个读取历史运行来凑总数。
历史 totalCaseCount=纳入题数，caseCount=至少完成一场的题数；progress.completedCaseCount=全部预期对战已完成的题数，completedBattleCount=已完成场数，expectedBattleCount=预期场数。stats 按模型分档，evaluated 是参战分母，双方分母不能相加当场数；wins、both_good、both_bad 以外为负场。accuracy 仅覆盖其 count 个有标准答案的样本。first/total 为首字/总耗时（毫秒），input/output 为 token 数；不推算缺失的历史回答总数。历史累计用表格呈现，show_chart 的本地引用仅支持运行统计。
{runId} 返回输入和任务引用；{runId,view:"comparisons",query} 按原问或判词找对战，reference 交给 read_case。query 是字面筛选；按 nextOffset 续页。
档位和胜负直接用 comparisonTier、outcome，不用 query 搜中文标签。对战目录默认排除双方都好；用户明确要求好例用 outcome:"both_good"，全部结果用 "all"。全局 summary 仍含所有结果，不改变统计分母。
批量总结用 {runId,view:"comparisons",comparisonTier:"Fast",outcome:"both_bad",includeAnalysis:true,limit:20}，按请求调整筛选。每项含完整原问、双方 assessments、outcomes.reason 和 tradeoff，直接归纳；按 nextOffset 读完目标范围，不逐场补读 read_data、read_case 或长链路。只有关键缺口或复核才定向读原文。
随便找一场传 view:"comparisons",sample:true,limit:1，服务端按题目随机抽取。再找一个必须 excludeCases:[已展示的items[].case]，排除同题所有档位；不传offset。selection 给可选与剩余题数，空数组表示没有未看案例。明确看同题另一档时按原题和档位读取。
summary.statisticsError 表示统计不可用，不影响已返回的输入目录；错误 retryable:false 时停止重试，不改 limit/query/view 反复撞同一错误。

summaryScope=run；全局统计不必翻页。query 筛选不改变统计范围，不可用整运行统计解释子集。inputCount=回答数，evaluatedInputCount=已归因数，caseCount=去重题数。formalComparisonStats：formalResultCount=正式结果份数，comparisonCount=对局场数，tiers 分档。

summary.batches 是被评数据的日期/批次；历史统计用 requestDates 与 snapshotAt 说明覆盖和快照时点。sampleTimeRange=null 表示样本发生日期未登记，不把评测日期当采集区间。

tiers.models：comparisonCount 是参战分母，meetsCoreCount 是核心达标场数；problemDimensions 为已确认 established、待核验 uncertain 问题场数，同场同维度同状态去重，可重叠。全局直接用计数，不读链路；不是客观错误率或输赢原因。同题多模型对战非独立样本，不能凭胜率差断言统计显著或外推总体能力。

model 定位，modelName 展示，comparisonTier=null 为档位未知。图引用 statistics:{runId,comparisonTier}。
