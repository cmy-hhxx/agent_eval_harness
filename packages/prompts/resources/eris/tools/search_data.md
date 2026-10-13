搜索本地原文，完整调用示例：`{"reference":{"runId":"run","inputId":"input"},"query":"关键词","scope":"all"}`。run、input 用已返回的真实标识替换；reference 必须嵌套，query、scope、offset、limit 均在顶层。query 支持字面词或独立查询数组；空格分隔词要求同一来源全部包含，不是语义搜索。查询词按要定位的内容选择，零命中不证明事实不存在。

reference 可直接沿用带 messageIndex 的节点引用，此时只搜索该节点，默认 scope:all；使用整条回答引用时默认 scope:evidence 搜工具返回。显式 scope:all 也搜索回答、推理、指令和请求快照。queries 给出各查询命中数，matches.matchedQueries 标记命中词；命中数和分页针对所选范围。
source.title 标明文章归属，source.read 可直接放入 read_evidence.messages 续读，source.endOffset 是该篇结束。无 source 时用返回的 format 和 readOffset 作为 offset；termLocations / contexts 提供定位线索。
offset / limit 按合并命中条目计，有下一页时直接调用 nextRead 的工具和 args，保留查询词、范围和引用。
