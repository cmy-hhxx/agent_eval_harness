同一回答批量取证，同一份输入只加载一次。按地图列齐当前疑点的必要节点；跨回答同轮并行。

reference 原样使用 {runId,inputId}；messages 为1–12个 {messageIndex,offset?,limit?}，每节点默认8000、最多16000个 UTF-16 字符。

每项保留原文、引文坐标、分页与 error；单项失败不丢弃其余证据。截断不是完整证据：作全量否定前，相关节点必须读完整；按 nextOffset 续读，否则限定已读范围。失败不是空结果。

核对查询、对应返回和最终口径，以 callMessageIndex 确认关联。完整答案不重读，图像用 view_image。不为少调用省略决定性证据。
