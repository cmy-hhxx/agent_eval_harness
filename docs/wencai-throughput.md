# 问财归因吞吐实验

从 main `4eafbf7b` 开始。正式归因输出和统计上传 Schema 保持不变；问财日常跑四路输入、Fast/Expert 各自 A/B 对战，专项仍跑独立 Attribution。

## 固定对照

`configs/benchmarks/wencai-atomic-c20.json` 固定 2026-10-27 的六个问题、24 条回答、12 场对战，包含历史终稿超时和代码执行长尾。原始输入仍在来源目录，只保存业务 ID。两轮使用同一个网关、deepseek-v4.1-flash、low 推理、20 并发和相同超时/修复预算。实验串行运行；不与另一轮叠加至 40 并发。服务器其他生产任务的资源争用须作为限制报告。

目标：完整 session 吞吐至少为基线的 2 倍，组件任务 p95 不超过 300 秒，固定样本无归因超时阻断。逐项复核关键问题、责任组件与原文证据；不得以删除问题、丢弃长样本、放松校验或改变正式输出换取性能。该小样本达标仍不能证明全量质量非劣。

```bash
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/wencai-atomic-c20.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/wencai-atomic-c20.json --run-id <新ID> --test-eval --debug
node scripts/attribution-throughput.mjs /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/<新ID>
```

模型凭据与统一日志目录通过服务器既有环境配置加载。`--debug` 只用于本次工具循环、模型时间和证据审查；所有产物在来源的 `test_eval/`。汇总同时报告所有未完成状态、组件/trace/session/对战完成数、首条产出、完整结果每分钟、已结束任务累计 p50/p95、实际有记录的 attempt 模型时间和工具数。已完成样本的耗时存在选择偏差，不能忽略未完成长尾；暂停造成的 cancelled 不算模型失败，coverage 不等于执行成功率。

## 原子审查

每次真实工具请求和可可靠关联的返回构成一个审查任务；每次中间模型调用独立；终稿按完整原文章节划分，短章节合并。所有范围保存原始坐标，不复制输入。任务首屏给出该调用参数/返回或该终稿章节的可提交引文及引用来源；完整原文仍可按需读取。trace 等待所有范围，统一问题 ID 后汇总；session 接受后立即交付。

已规划的同 run 归因单元保持其恢复边界和 UUID，不因更新程序而重新展开、重评已接受工作；新的 run 使用原子规划。涉及提示词和材料组装的版本为 r421。

## 验证记录

原子规划、原文范围覆盖、可直接提交的证据、UUID 恢复、Comparison/Attribution 真正 Host 提交和非法证据拒绝均有回归。全量测试中发现主线仍有引用旧 `attribution` 单阶段的集成用例；在未修改的远程 main 复跑输入相关三个用例，出现与实验分支相同失败。不可将定向测试通过宣称为全量通过。

真实实验尚在进行，以上是目标与验证方法，不是已达标结论。
