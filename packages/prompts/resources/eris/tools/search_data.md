按 {runId,inputId} 搜索本地原文。query 支持字面词或独立查询数组；空格分隔词要求同一来源全部包含，不是语义搜索。查询词按要定位的内容选择，零命中不证明事实不存在。

默认 scope:evidence 搜工具返回；scope:all 也搜索回答、推理、指令和请求快照。queries 给出各查询命中数，matches.matchedQueries 标记命中词；命中数和分页针对所选范围。
source.title 标明文章归属，source.read 可直接放入 read_evidence.messages 续读，source.endOffset 是该篇结束。无 source 时用返回的 format 和 readOffset 作为 offset；termLocations / contexts 提供定位线索。
offset / limit 按合并命中条目计，按 hasMore / nextOffset 续页。
