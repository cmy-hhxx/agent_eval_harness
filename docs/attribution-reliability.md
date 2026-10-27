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

`configs/benchmarks/aime-slim-200-concurrency-100.json` 固定了 2026-10-19 至 2026-10-26 的 200 条 session（Fast、Expert 各 100）。按每个模式的日期数量分配，再在各日期内按 JSONL 行长度分层选择，保留长尾。共 305 个 trace、105 条含共享池的 session；源文件仍在 `4_daily_eval_slim`，没有复制正文。抽样时全量为 5,493 条；后续新增不进入本次固定测试。

使用 100 并发、100 session 窗口和原有 high 推理及修复预算，运行时不启用逐 token debug 归档。记录实际峰值并发、完整 session 成功率、总耗时、分模式吞吐、限流、超时和内容拒绝。估算全量时按 Fast/Expert 实际数量加权，不能把这批均衡抽样直接等比例放大；输入文件变化时重新核对样本坐标。

```bash
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json --run-id aime-slim-200-c100 --test-eval
```
