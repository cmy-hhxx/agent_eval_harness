读取原始链路节点。同一回答可批量取，独立回答可并行；按当前问题选择需要的节点，沿用已读内容。

单节点直接使用已有节点引用：`{"reference":{"runId":"run","inputId":"input","messageIndex":0}}`，需要时在顶层传 format、offset、limit。批量使用回答引用：`{"reference":{"runId":"run","inputId":"input"},"messages":[{"messageIndex":0},{"messageIndex":2,"format":"json"}]}`。run、input 和 messageIndex 用已返回的真实坐标替换；reference 中的单节点与 messages 批量目标二选一。批量顶层 format、offset、limit 是所有节点的默认值，各节点可分别覆盖。
format 默认 text 提取字符串，json 保留原生数值、布尔值和结构；偏移属于所选格式，每页默认及最多16000个 UTF-16 字符。text 是原文，reference、format、offset 定位，callMessageIndex 指向关联调用。截断节点给出 nextRead 的工具名和完整 args，保持格式及 nextOffset 直接续读；未续读时把结论限定在已读范围。error 表示读取失败，不是空结果。
