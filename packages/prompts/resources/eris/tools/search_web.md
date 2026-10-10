用 Serper 搜索公开网页或新闻。queries 中每项写一个明确查询；独立缺口可合并调用。已有 URL 直接 read_web，本地输入用 search_data。摘要用于定位候选，核实主张须读原文。

attempts 记录每项状态；部分失败仍保留成功结果，只补必要的失败查询。results 已合并去重，matches 保留命中位置，排名不代表可信度。hasMore 表示候选被 limit 截断，搜索翻页使用查询项内的 page。

excludedResults 是明确越过日期范围的命中；未知日期仍待核验。dateAssessment.within_range 仅表示搜索元数据符合范围，不证明首次公开日期或当时版本。空结果不等于主张错误。creditsComplete=false 表示用量不完整。
