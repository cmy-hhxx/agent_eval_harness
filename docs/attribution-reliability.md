# 归因可靠性与固定样本验证

质量约束：保持原始证据、归因组件、业务校验和内容修复额度。系统故障不得要求模型改写已有判词，也不得消耗内容修复额度。有效吞吐按完整 session 的归因产出计算，不能用组件完成数或跳过输入提高指标。

## 执行顺序与验收

1. 问财 Comparison 与独立 Attribution 的新建、多 trace、同 run 续跑走真实 Host 提交；有效证据可提交，非法证据仍拒绝。
2. 区分内容拒绝与系统故障。瞬时交付失败使用同一请求重试；确定性 Host 故障保留草稿并暂停阶段；已有内容错误的累计预算不重置。
3. 恢复热日志和 progress 投影：只允许补充缺失的导出引用，拒绝判词或状态冲突；热库丢失时不复用事件序号；本次配置在重放后生效，旧 receipt 保留原版本。
4. 运行 typecheck、快速回归、完整回归与 Worker/SDK 集成检查。分别记录本次回归和既有失败，未全绿不能声明正式验收通过。
5. 用下列固定样本验证交付与耗时，复核问题、证据和结论。随后逐项减少重复材料传递、文件写入和无效模型往返；每次只改一个变量，并在相同样本与配置上比较。
6. 小样本成功后，冻结足够多的问财、AIME session，分别按 8 → 16 → 32 → 64 并发压测。每档保持相同样本、模型、推理强度与修复额度；只有完整 session 成功率、质量复核和吞吐均满足要求才继续升档。若 429、超时、恢复或校验失败增加，先定位瓶颈，不直接加并发。可调度任务不足的档位不计作该并发的验证。

## 固定小样本

配置中的业务 ID 和原始源路径构成固定范围，不复制输入。问财选两个问题的 A/B Fast 回答，使用 Comparison；AIME 选四条 Fast/Expert 回答，使用独立 Attribution。两者固定同一模型、8 并发、high 归因推理和 3 次修复。小样本用于发现链路和交互成本问题，不能证明大规模吞吐或质量非劣。

在服务器隔离 checkout 中加载既有 INI，执行：

```bash
export EVAL_CONFIG_FILE=/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/config/config.ini
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/wencai-attribution-reliability.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/wencai-attribution-reliability.json --run-id wencai-reliability-baseline --test-eval --debug
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/aime-attribution-reliability.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/aime-attribution-reliability.json --run-id aime-reliability-baseline --test-eval --debug
```

每轮记录 Git commit、完整生效配置、输入业务 ID、run ID、成功 session 数、失败类型、端到端耗时、各阶段 p50/p95、模型请求/输出 token、工具调用、内容修复次数、Host 校验与落盘时间。未结束 attempt 单列，不能计为成功或作为零耗时。串行执行两种来源，避免争用配额影响比较。提示词或材料优化使用新的 run ID，不在已完成的 baseline 上续跑来比较性能；同 run 续跑只用于验证中断恢复和配置生效。

质量复核检查每个问题是否有原文依据、责任组件是否准确、证据坐标是否有效，以及是否漏掉关键问题。JSON 和 Schema 通过只是结构检查，不能替代质量复核。性能改动须同时比较完整 session 的结果与失败率；减少推理强度、截断有效证据、跳过长 session 均不作为本轮优化手段。

## AIME 全日期 200 条、100 并发

`configs/benchmarks/aime-slim-200-concurrency-100.json` 固定了 2026-10-19 至 2026-10-26 的 200 条 session（Fast、Expert 各 100）。按每个模式的日期数量分配，再在各日期内按 JSONL 行长度分层选择，保留长尾。源文件仍在 `4_daily_eval_slim`，没有复制正文。抽样时全量为 5,493 条；后续新增不进入本次固定测试。

首次预检发现 8 条输入异常，已在同日期、同模式中按最接近的行长度补入有效样本；异常不计成功，未放松输入校验。以下行号从 1 开始，数据源修复前，全量耗时估算不代表这些输入能被成功评测。

| 模式 | 日期 | 原行号 | 异常 |
| --- | --- | --- | --- |
| Fast | 2026-10-22 | 27、159 | 外层 trace/message 数量与正文不一致 |
| Fast | 2026-10-23 | 110、2408 | 外层 trace/message 数量与正文不一致 |
| Fast | 2026-10-24 | 221 | 外层 trace/message 数量与正文不一致 |
| Expert | 2026-10-23 | 72 | 外层 trace/message 数量与正文不一致 |
| Expert | 2026-10-23 | 355 | trace 2 用户问题为空 |
| Expert | 2026-10-26 | 5 | 外层 trace/message 数量与正文不一致 |

使用 100 并发、100 session 窗口和原有 high 推理及修复预算，运行时不启用逐 token debug 归档。记录实际峰值并发、完整 session 成功率、总耗时、分模式吞吐、限流、超时和内容拒绝。估算全量时按 Fast/Expert 实际数量加权，不能把这批均衡抽样直接等比例放大；输入文件变化时重新核对样本坐标。

限时压测仍使用这 200 条记录，但在每个日期/模式内固定打散，再交错各组；Attribution 按显式 `inputs.records` 顺序规划，避免文件扫描顺序让 10 分钟窗口只覆盖 Fast。每轮两个渠道分别 high/low，各 100 并发；实际达到 100 个运行任务后计时 600 秒，然后停止并保留收据和未完成草稿。只统计窗口内接受的完整 session，冷启动单列，截止时取消的任务计未完成而非模型失败；每轮使用新 run ID，不借用前一轮结果。

```bash
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json --run-id aime-slim-200-c100 --test-eval
```

低推理对照使用相同的 200 条记录、100 并发和内容校验，叠加 `configs/benchmarks/aime-slim-low-channel-2.json`，将全部归因阶段设为 `low`，通过 `evaluation-gateway-2` 调用同一 `deepseek-v4.1-flash`，独立 run ID 为 `aime-slim-200-c100-low`。先用 `model-probe --stage attribution-component --execute` 核实渠道与工具调用。两个 run 可同时执行，但共享服务器资源；渠道和推理强度同时变化，测得差异不能只归因于推理强度。

目标是冷启动之后每分钟完成约 30 条完整 session。以正式 session 收据的接受时间计算连续窗口吞吐，另报启动、并发爬升和收尾时间；不能把 component 或 trace 当作 session。100 个槽位要达到此目标，每条 session 的所有任务及重试合计平均只能占用约 200 秒槽位时间。对照须按业务 ID 比较问题、责任组件和原文证据；结构通过率、问题数量或更少的输出 token 均不能单独证明质量不下降。
