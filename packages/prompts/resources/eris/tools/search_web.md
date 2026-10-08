用 Serper 定位公开网页或新闻原文；本地输入用 search_data，已有公开地址直接 read_web。搜索摘要是候选线索，精确数字与主张判定须继续读原文。

最小调用：{queries:[{query:"机构或公司 + 期间 + 指标"}]}。queries 必填，含1–4项；query 在每个项内，不能放在顶层。单一事实默认1个精准查询，多个独立缺口才合并互补查询，不用同义改写凑数量。财报、年报、研报优先加入 filetype:pdf；查行情写明数据时点和指标。不要只用待核答案的数字寻找确认。

可选参数：
- 项内 domains：最多5个完整主机名，不带协议、端口、路径；未知来源可省略。country / language 默认 cn / zh-cn；page 默认1、最多3。
- 顶层 category 只有 web（默认）和 news；近期新闻用 news，没有 finance 类别。
- timeRange 为 day / week / month / year，与 dateFrom / dateTo 互斥。绝对日期用包含端点的 YYYY-MM-DD；历史审查设 dateTo 为截至日期。
- limit 控制合并候选数，默认10、最多20；每项最多取10条、最多两路并发。多个计划合在一次调用，不拆调用扩大并发，无自动重试。

先读最能覆盖实体、指标、期间的一手候选，通常1–2份；优先真实公告、财报或PDF，不因排名或熟悉域名点无关栏目页。有完整证据就停止；无有效证据时区分请求失败、过滤过窄和真实空结果，第二轮只修正明确假设。默认两轮后交付具体缺口，明确要求深查时才扩大来源。

返回 attempts 的实际查询、状态、耗时和可用 credits；部分失败仍保留成功结果，只补失败的必要查询，不重复整批。creditsComplete=false 表示用量不完整。results 按倒数排名融合并规范化URL去重，matches 保留命中位置，排名不是可信度。truncatedFields 表示字段缩短；hasMore 只表示合并候选被 limit 截断，搜索引擎翻页用项内 page。

excludedResults 放明确超出日期范围的命中，未知日期仍待核验。dateAssessment.within_range 仅说明搜索元数据在范围内，不证明首次公开或当时版本。没有命中不等于主张错误，报错不等于空结果；不能用搜索时刻冒充行情时刻，也不能声称摘要是已读原文。
