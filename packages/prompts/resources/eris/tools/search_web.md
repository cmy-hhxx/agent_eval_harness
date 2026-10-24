搜索公开网页或新闻，用于需要外部资料的问题。queries 中每项是一条查询，独立查询可合并；已有 URL 可用 read_web，服务器评测材料用 search_data。摘要用于筛选来源，关键事实需要核验时读取原文。

domains、country、language 可在顶层统一设置，各查询可单独覆盖同名条件。示例：`{"queries":[{"query":"利率公告"},{"query":"金融统计"}],"domains":["pbc.gov.cn"],"country":"cn","language":"zh-cn"}`。实际生效的条件记录在各项 attempts 中。

attempts 记录各查询状态，部分失败仍保留成功结果。results 合并去重，matches 保留命中位置；hasMore 表示候选被 limit 截断，查询项的 page 用于翻页。creditsComplete=false 表示用量不完整。
excludedResults 是明确超出日期范围的命中；dateAssessment.within_range 仅表示搜索元数据日期在范围内，不证明当时已公开或未修订。未知日期与空结果保持其原意。
