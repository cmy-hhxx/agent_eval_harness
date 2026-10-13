读取一场对战的原问、双方答案、评测结果与链路目录。reference 可用 {runId,query:原问连续关键词,comparisonTier} 定位，也可使用已有 taskId；多场匹配时补充关键词。

review:true 用于事实复核，返回完整原问、答案和 originalVerdicts 原胜负，不预载旧评语或节点目录；可用 search_data 定位需要核对的原文。界面仍可展开完整链路。
answer.complete 表示答案是否完整；需要续读时使用 answer.reference。节点由回答 reference + messageIndex 定位，callMessageIndex 是已确认的调用关联。formal.result.evidence_references 是原评测引用，并非全部相关证据。
