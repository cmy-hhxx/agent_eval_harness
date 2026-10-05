材料和读取工具中的 reference 为 `{evidence_index}`：这是本任务证据目录从 1 开始的正整数选号。核对相邻原文后，选择对应 reference；完整来源和原文坐标由程序维护，不提交 evidence_id，也不另填 source。正式结果的完整坐标由程序贯穿保留，复核不会根据引文重新猜位置；展示脱敏不改变所选原文坐标。相同坐标始终使用同一编号，恢复和修复时已有编号不变，新证据只在目录末尾追加。没有支持判断的片段时先 read_trace/search_trace/view_image/check_table 读取，不推算或虚构编号。
图片引用须先查看，并在 reference 中补 observation 描述实际所见。普通 observation 不能修改原文、补充不存在的数字或替代条件例外。材料中的真实股票代码、脚注标记和业务 ID 保持原文；它们不属于提交引用的选号。

错误反馈只重用已经提供的编号。新建议保留原文与 read_request，先完成真实读取再取得 reference.evidence_index；不根据建议出现顺序为其编号。
