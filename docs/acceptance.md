# 第二版阶段性交付（2026-09-22）

**已交付4条比较和对应逐题总结。计划中的第5条流式超时，按用户要求停止继续重试。**

## 交付

- [逐题总结（可读）](../eval_output/smoke-5-v2/task_summaries.md)
- [逐题总结JSONL](../eval_output/smoke-5-v2/task_summaries.jsonl)
- [demo格式比较记录](../eval_output/smoke-5-v2/results/)
- [未完成任务](../eval_output/smoke-5-v2/failures.jsonl)
- [校验结果](../eval_output/smoke-5-v2/validation.json)

每条总结包含原始问题、具体要求、测评结论、双方优劣势及原文证据、原始回答耗时分析、得分点和red flags。总结与比较结果由同一次严格工具提交生成，不新增总结模型调用。主观题评语没有缺少标准答案或跳过判定的流程说明。

耗时取原始输入meta，按可配置单位换算为秒；缺失不补零，不用裁判运行耗时替代。本次清理6个旧试跑目录与失效缓存，约208 MiB，保留原始输入和Git历史。

## 校验与范围

- 16项Python测试、4项Node扩展测试通过；pyright无错误。
- 已完成4条的schema、原文引用、版本映射、耗时来源和逐题总结一致性校验通过。
- 2次Mini正确性判定成功；4条比较由Luna完成，均为本版真实调用。
- 第5条因流式超时未完成，已经停止，不纳入胜负统计。validation通过只表示已交付记录有效，不表示计划全部完成。
- 为评测分配独立daemon socket；结束时只终止持有该socket的进程，避免使用会停止全部Prime服务的全局shutdown命令。本机使用系统lsof定位该进程。

## 已完成样本

| case | 候选A | 候选B | 结论 |
|---|---|---|---|
| 14_多轮选股_258题_20260911_Q023_2_T08_multi | A Expert | A Fast | B_better |
| 1_数据查询_6292句_20260911_1955 | A Expert | A Fast | B_better |
| 市场热点与异动归因_20题_20260921_Q003 | AA Expert | AA Fast | A_better |
| 市场热点与异动归因_20题_20260921_Q007 | AA Fast | AA Expert | A_better |

未完成：`市场热点与异动归因_20题_20260921_Q004`；原因：流式输出静默超过 45 秒。

输入、输出和密钥不进入Git；交付文件位于本机eval_output/smoke-5-v2。
