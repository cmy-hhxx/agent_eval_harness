读取真实公开 URL 的 HTML、PDF 或纯文本原文。已知目标词可带 find 做字面定位，返回 matches / preview；lines 是原文，links 是正文中的实际链接或附件。

startLine 从1开始，按 nextStartLine 续读。PDF 的 page 使用实际页号：未指定时行号跨已读页连续，指定时在该页内计数，续页保持同一模式。工具不执行脚本、不做 OCR；根据 limitations 和截断标记判断覆盖范围，表格需联读表头、单位与脚注。

publicationDate 是页面声明发布日期，modifiedDate 单列。dateFrom / dateTo 只检查声明日期，within_range 不证明当时已公开或未修订；PDF创建时间不算发布日期。引用最终 URL、实际页码或必要行号。find 未命中只说明已提取范围没有该字面词。
