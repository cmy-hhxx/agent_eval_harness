读取原始链路节点。同一回答可批量取，独立回答可并行；按当前问题选择需要的节点，沿用已读内容。

reference={runId,inputId}，messages 传节点与分页。format 默认 text 提取字符串，json 保留原生数值、布尔值和结构；偏移属于所选格式，每页默认及最多16000个 UTF-16 字符。
text 是原文，reference、format、offset 定位，callMessageIndex 指向关联调用。结合实际参数与结果理解证据。截断时可按 nextOffset 续读，或把结论限定在已读范围；error 表示读取失败，不是空结果。
