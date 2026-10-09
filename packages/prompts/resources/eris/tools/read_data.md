常规案例分析默认读取正式评测输出，只有独立复核或结果信息不足时才下钻原始输入。原样使用目录返回的 reference，三种形态互斥：
- {reference:{runId,taskId}}：正式结果 JSON 的 text 窗口，默认8000、最多16000个字符，含 evaluatorVersion；用 hasMore / nextOffset 续读。窗口可能不是完整 JSON，不对片段作 JSON.parse。已裁决比较的 comparisonScope 依据保存配置和 verdicts 给档位、展示名与每对结果；tradeoff 不覆盖胜负或双好/双差。
- {reference:{runId,inputId}}：消息目录，默认30条、最多100条；各项含角色、预览、长度及正文 reference。
- {reference:{runId,inputId,messageIndex}}：单条消息正文，messageIndex 从0开始；默认8000、最多16000个 UTF-16 字符。

offset / limit 是顶层字段、与 reference 同级，目录按消息条数，正文按字符。通常省略；按 hasMore / nextOffset 续读，不猜偏移，不把截断片段当全文。

保留字段名，不把 taskId 换成 inputId。案例用 list_data({runId,view:"comparisons"}) 定位，先读 items[].reference 指向的正式结果；其中的 comparisonScope 已汇总双方评价、结果类别、裁决理由和权衡，通常足够解释本场。需要归因或细节时再续读评测结果页；inputs[].reference 留给按需原始材料复核。本会话独立任务用 read_specialist({operationId})。缺少某份正式结果不表示原始消息不存在。

概览用完整 summary；案例以评测输出为依据，不强制重复读取原问与双方回答。仅在用户要求复核、评测信息不足、结论矛盾或疑似误判时，先看对应输入的消息目录，再读决定判断的正文片段；已知目标词时用 search_data 定位。已知引用直接复用，独立读取同轮发出，不为常规解读扫描整份判词或原始对话。
