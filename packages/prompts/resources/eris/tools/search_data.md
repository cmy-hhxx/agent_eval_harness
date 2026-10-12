按 {runId,inputId} 搜索；query 传字面词或1–8词数组，不逐词调用。queries 含每词命中数（含零）。
复核先按争议实体名称搜索原始证据，避免先加上自己猜测的能力词而漏反证；多个实体同批搜索。不要用回答、推理或查询词证明能力。

每词精确匹配原文，不是语义搜索。空格分隔词要求同一来源全部包含；多个独立查询分别放数组。零命中不能证明事实不存在。

matches 用 matchedQueries 标记命中词，同一原文不重复；source.title 标明文章归属，短篇完整展示。补读直接将 source.read 放进 read_evidence.messages；source.endOffset 是本篇结束，不能把同节点别篇的内容算给它。无 source 时按 format、offset=readOffset 续读，termLocations / contexts 给远处词的位置与原文。

offset / limit 按合并命中条目计；hasMore / nextOffset 续页。
默认 scope:evidence 搜工具证据；scope:all 用于查回答、推理、指令或请求元数据，不用于证明实体能力。两种范围的文章均独立定位，原文不变。
