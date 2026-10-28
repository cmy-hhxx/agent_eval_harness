# AIME 日常评测

[返回首页](../README.md) · [Session 归因](attribution.md) · [运行与恢复](usage.md#运行与恢复)

AIME 使用独立 `workflow: "attribution"`，通过 CLI 对显式 JSONL 输入执行归因。配置以 [attribution.json](../configs/attribution.json) 为 Host 覆盖，再在外部输入配置声明模型版本和原始 JSONL 路径，结构见[输入契约](contract.md#输入)。

```bash
npm run eval -- preflight --config configs/host.json --config configs/attribution.json \
  --config /absolute/path/aime-attribution-inputs.json
npm run eval -- run --test-eval --run-id aime-attribution-test \
  --config configs/host.json --config configs/attribution.json \
  --config /absolute/path/aime-attribution-inputs.json
```

真实测试产物只能写入 `/mnt/fin_bench/eval_data/1_aime/3_eval_output/test_eval/`。正式结果一行对应一条输入记录，包含 `session_meta`、`turns[]`、`session_summary` 和 `session_problem`，由 [Session 归因](attribution.md) 定义；内部 component、trace 任务只保存在运行状态与收据中。

输入扫描按一行为一条评测记录，保留该记录的全部 trace；按 trace 抓取时允许同一会话有多条记录；空回答、缺最终回答、缺 trace 身份、重复业务身份和冲突记录必须保留可定位原因，不得静默裁剪或拼接。状态与正式结果位于同一 run，续跑沿用已接受任务与累计预算。
