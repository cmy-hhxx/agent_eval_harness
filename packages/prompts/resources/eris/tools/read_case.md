读原问、答案和地图，区分解读评测与复核事实。
复核设 review:true：模型先看完整答案和 originalVerdicts 原胜负；不预载节点地图或旧评语。先按争议实体 search_data，再从 source.read 批量补读；界面仍保留完整地图。复核不要先读旧判词；作图工具自行读取原判定，界面仍可展开。

用 reference:{runId,query:原问连续关键词,comparisonTier} 定位，不必先列目录或抄 ID；多场匹配则补长关键词。

节点用回答 reference + messageIndex 定位；callMessageIndex 是已确认关联。解读评测时，formal.result 的 evidence_references 是旧判词引用，不是全部相关证据；复核从地图或 search_data 定位原文。

按疑点批量 read_evidence，不从头通读地图。answer.complete=true 已含完整答案，不重复取；false 才补读 answer.reference。

核对疑点及会改变结论的反证，不重做整题评分。只有会改变判断的缺口才继续取证。
