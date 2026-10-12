按疑点选 evidence_references 对应的返回与必要调用参数，同一回答批量取、跨回答并行。不要整张地图全选；完整答案已在 read_case，不重复读。长节点按缺口搜索，需全量核对才续读。

reference={runId,inputId}；messages 传节点与分页。format 默认 text 只含字符串；原生数值、布尔值和行列关系用 json 核对，偏移不跨格式。每页最多16000个UTF-16字符，默认取满。

text 是原文，reference、format、offset 定位。截断不是完整证据：作全量否定前，相关节点必须读完整；按 nextOffset 续读，否则限定已读范围。error 不是空结果。

callMessageIndex 定位调用；查询说明只是导航，须核对实际参数和结果。确认实体、时段、字段与基数，不能把日值当区间值、放宽条件当原要求。有冲突或缺口再补读。
