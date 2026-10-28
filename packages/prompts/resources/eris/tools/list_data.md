读取评测统计或目录，按需求直接调用：
当前结构化查询面向带 overview 的 Comparison 运行；独立 Attribution 与其他历史材料用 list_assets / read_asset 读取正式资产。
- 各次运行表现与进度：{"view":"statistics","limit":20}，返回 runs 中各次运行的预计算统计，包含已完成和运行中的任务，按 nextOffset 续页；collectionId 限定来源与任务目录。
- 历史趋势与分类：沿 list_assets 读取该来源已存的统计快照或报告，保留其日期和统计范围。
- 指定运行：{"collectionId":"目录返回值","runId":"目录返回值"}，返回回答目录与完整运行统计；query 和分页不改变统计范围。
- 批量读评语：{"view":"comparisons","includeAnalysis":true}，返回原问、双方 assessments、问题维度、胜负理由和 tradeoff。
- 随机找案例：{"view":"comparisons","sample":true,"limit":5}，直接返回不同题的完整原问和评测摘要，由你挑选；excludeCases 排除已看题的全部档位。
- 运行目录：{}，返回真实 collectionId、runId、workflow 与 currentRun.summary。

inputs/comparisons 不传 runId 时自动选有输入的运行中批次，其次最近批次。继续筛选、翻页或换题时沿用返回的 collectionId 和 runId，不会自动扩大范围。comparisons 的 comparisonTier、outcome 精确筛选；默认排除双方都好，outcome:"all" 包含全部结果。nextOffset 续读目录；sample 的 selection 只说明本次随机召回范围，不代表质量或总体分布。

返回比例的单位是百分数（0–100），直接用于回答：
- summary.formalComparisonStats.tiers[].models：四类场数、comparisonCount、winRate、lossRate、bothGoodRate、bothBadRate、meetsCoreRate（核心达标率）；problemDimensions 中 establishedRate / uncertainRate 是对应问题场数占该模型参战场数的比例。同场同维度去重，维度可重叠。
- summary.attributionCompletionRate / battleCompletionRate：已归因回答 / 纳入回答、已接受正式对战 / 预期正式对战。模型参战场数不能相加当总场数。

runs[].summary 与指定运行返回的 summary 使用相同口径。各次运行可能包含相同样本，不能直接相加。model 用于定位，modelName 用于展示。first/total 是首字/总耗时（毫秒），input/output 是 token 数。要看该来源的历史，沿 list_assets 读取对应已存统计或报告，不套用其他来源的累计胜率。

null 或 unavailable 表示未知，不补零；参战样本为0时，胜率等比例为null，不能说成0%。runDirectory.complete=false 时 errors 给出缺失范围；statisticsError.retryable:true 表示仍在保存，可稍后重读；false 按维护操作处理，目录仍可使用。测试目录仅显式 includeTests:true 时纳入。所有后续引用完整保留 collectionId + runId。
