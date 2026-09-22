# eval_input 整理说明

整理日期：2026-09-22。

原有 6 个文件共 48 条记录，按版本合并成 4 个 JSONL。按本次要求直接删除失败或 `messages` 为空的 11 条记录，不保留失败记录备份。最终保留 37 条记录，覆盖 2 个批次、14 个 case。

| 文件 | 完整版本 | 原有记录 | 删除失败记录 | 保留记录 |
| --- | --- | --- | --- | --- |
| `eval_input/a_fast.jsonl` | A Fast | 14 | 6 | 8 |
| `eval_input/a_expert.jsonl` | A Expert | 14 | 5 | 9 |
| `eval_input/aa_fast.jsonl` | AA Fast | 11 | 0 | 11 |
| `eval_input/aa_expert.jsonl` | AA Expert | 9 | 0 | 9 |
| 合计 | — | 48 | 11 | 37 |

这里的成功指原始 `meta.ok=true` 且 `messages` 非空，仅表示有成功返回的输入记录，不代表回答内容正确。

## 统一结构

每行是一份完整的“批次 × case × 版本”记录，顶层字段统一为：

| 字段 | 来源与含义 |
| --- | --- |
| `batch_id` | 从原始 `meta.item_id` 的批次前缀提取 |
| `case_id` | 原始 `meta.case_id` |
| `version` | 由原文件名明确映射为 A Fast、A Expert、AA Fast、AA Expert |
| `trace_id` | 原始顶层 `trace_id`，不存在时使用 `meta.trace_id` |
| `_source.original_file` | 整理前的相对文件路径，仅用于记录历史来源；原文件已由四份合并结果替代 |
| `_source.original_line` | 整理前记录所在行，从 1 开始 |
| `messages` | 完整保留原始消息、执行链路与图片内容 |
| `meta` | 完整保留原始元数据，不覆盖缺失值或改写业务字段 |

各文件按 `batch_id`、`meta.item_id`、`case_id` 排序。配对必须使用 `batch_id + case_id`，不能按文件行号配对；四个版本的行数不同。

## 配对覆盖

批次 `0b291c6224d24a9e` 的以下两个 case 均只有 A Fast、A Expert，缺 AA Fast、AA Expert：

- `1_数据查询_6292句_20260911_1955`
- `14_多轮选股_258题_20260911_Q023_2_T08_multi`

批次 `5a694ff58fc04ccb` 的 case 前缀统一为 `市场热点与异动归因_20题_20260921_`。以下缺项包括原本未提供的记录和本次删除的失败记录：

| case 后缀 | 整理后缺失版本 |
| --- | --- |
| Q001 | A Expert |
| Q002 | A Expert |
| Q003 | A Fast、A Expert |
| Q004 | A Fast、A Expert |
| Q005 | 无，四版齐全 |
| Q006 | 无，四版齐全 |
| Q007 | A Fast、A Expert |
| Q008 | A Fast |
| Q009 | A Fast、AA Expert |
| Q010 | A Fast |
| Q011 | AA Expert |
| Q012 | AA Fast、AA Expert |

按当前实际出现的 14 个 case 计算，四版齐全应有 56 条记录，现有 37 条，缺 19 个版本位置。只有 Q005、Q006 能各自形成完整六组配对；其他 case 可比较实际存在的版本组合，不补造缺失输入。测试集名称含“20题”，但本次文件中仅出现该批次的 Q001—Q012，不据名称推定其余题目已经交付。

## 校验结果

- 四个文件均为一行一个对象的 JSONL，字段结构一致。
- 37 条记录全部满足 `meta.ok=true`、`messages` 非空，消息数量与 `meta.n_messages` 一致。
- `batch_id + case_id + version` 无重复。
- 同批次、同 case 的非空 `meta.question` 无冲突。
- 保留记录的所有原始字段均已与整理前记录逐条比较，完全一致，包括完整 `messages` 和 `meta`。
- A Fast 的 `14_多轮选股_258题_20260911_Q023_2_T08_multi` 原始 `meta.question` 为空，保持原值；已核对其最后一条用户消息中的问题为“营业收入是研发费用的多少倍？”，与对应 A Expert 的问题一致。
