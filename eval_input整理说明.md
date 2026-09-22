# 输入数据说明

`eval_input/` 保存四个版本的原始回答 JSONL，文件映射和适配器由 `configs/eval.toml` 维护。输入清洗只保留 `meta.ok=true` 且 `messages` 非空的记录；它表示原始执行成功，不代表回答内容正确。

运行时以 `preflight` 对实际文件重新统计输入数量、缺失版本和可生成的配对，不按测试集名称推断未提供的 case。

## 记录结构

每行是一个完整的“批次 × case × 版本”记录：

| 字段 | 作用 |
| --- | --- |
| `batch_id` | 批次标识；缺失时由 `meta.batch_id` 或配置补充 |
| `case_id` | 同批次内的题目标识 |
| `version` | 由输入文件映射为 A Fast、A Expert、AA Fast 或 AA Expert |
| `trace_id` | 原始追踪 ID |
| `messages` | 完整消息、工具调用和图片 |
| `meta` | 原始问题、标准答案、状态和回答耗时等元数据 |
| `_source` | 首次收录时的来源文件和行号，仅用于追溯 |

文件按批次和 case 排序，但配对始终使用 `batch_id + case_id`，不能按行号配对。同一键 `batch_id + case_id + version` 出现重复、同一 case 的问题或标准答案冲突时，程序会在 `preflight.json` 中报告并跳过相关配对。

缺失版本、解析失败或被清洗掉的记录不会补成空答案，也不自动判为模型失败；它们只影响涉及该版本的组合。要查看当前缺失和冲突，以 `preflight` 的 `skipped`、`issues` 为准。
