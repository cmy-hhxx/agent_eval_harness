原样使用目录返回的 reference 读取本地材料，三种形态互斥：
- {reference:{runId,taskId}}：整条正式结果及 evaluatorVersion，不传 offset / limit。已裁决比较的 comparisonScope 依据保存配置和 verdicts 给档位、展示名与每对结果；tradeoff 不覆盖胜负或双好/双差。
- {reference:{runId,inputId}}：消息目录，默认30条、最多100条；各项含角色、预览、长度及正文 reference。
- {reference:{runId,inputId,messageIndex}}：单条消息正文，messageIndex 从0开始；默认8000、最多16000个 UTF-16 字符。

offset / limit 是顶层字段、与 reference 同级，目录按消息条数，正文按字符。通常省略；按 hasMore / nextOffset 续读，不猜偏移，不把截断片段当全文。

保留字段名，不把 taskId 换成 inputId。正式结果对应的原问/回答从 list_data({runId}) 中包含该任务引用的输入项定位。本会话独立任务用 read_specialist(operationId)。缺少某份正式结果不表示原始消息不存在。

概览用完整 summary；案例先读完整原问，再读决定结论的回答片段及上下文。正式结果不能代替原始问句和回答。已知引用直接复用；知道目标词但不知道位置用 search_data。独立读取同轮发出，不逐份扫全量长判词。
