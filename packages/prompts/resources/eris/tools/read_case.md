读取一场对战的原问、双方答案、评测结果与链路目录。完整调用示例：`{"reference":{"runId":"run","query":"原问连续关键词"}}` 或 `{"reference":{"runId":"run","taskId":"task"}}`。run、task 用已返回的真实标识替换。comparisonTier 可选，原问唯一匹配时直接读取；多场匹配返回带档位的候选 reference，可直接选用，或补充关键词、档位。单条回答可在 reference 中用 inputId 替代 taskId。

review:true 用于事实复核，返回完整原问、答案和 originalVerdicts 原胜负，不预载旧评语或节点目录；可用 search_data 定位需要核对的原文。界面仍可展开完整链路。
answer.complete 表示答案是否完整；需要续读时使用 answer.reference。节点由回答 reference + messageIndex 定位，callMessageIndex 是已确认的调用关联。formal.result.evidence_references 是原评测引用，并非全部相关证据。
