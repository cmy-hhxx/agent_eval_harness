# AIME 日常评测

[返回首页](../README.md) · [Session 归因](attribution.md) · [自动化](automations.md) · [运行与恢复](usage.md#运行与恢复)

AIME 日常来源当前使用 `workflow: "attribution"`。生产 manifest 已登记该来源，但 automation 尚未接管 attribution workflow，因此工作台保留 AIME 卡片并显示“不支持”，不会回退到已移除的 `answer-review`，也不会影响问财、数据服务或运行实例。

AIME 归因通过 CLI 对显式输入执行。配置以 [attribution.json](../configs/attribution.json) 为 Host 覆盖，输入配置声明 `workflow: "attribution"`、模型版本与 `.archive/` 下待评测 JSONL；示例结构见 [aime-ingest-and-attribute.example.json](../configs/aime-ingest-and-attribute.example.json)。

```bash
npm run eval -- preflight --config configs/host.json --config configs/attribution.json \
  --config /absolute/path/aime-attribution-inputs.json
npm run eval -- run --test-eval --run-id aime-attribution-test \
  --config configs/host.json --config configs/attribution.json \
  --config /absolute/path/aime-attribution-inputs.json
```

真实测试产物只能写入 `/mnt/fin_bench/eval_data/1_aime/eval_output/test_eval/`。正式结果一行一个 session，包含 `session_meta`、`turns[]`、`session_summary` 和 `session_problem`，由 [Session 归因](attribution.md) 定义；内部 component、trace 任务只保存在运行状态与收据中。

输入扫描按一行为一个 session，保留全部 trace；空回答、缺最终回答、缺 trace 身份、重复业务身份和冲突记录必须保留可定位原因，不得静默裁剪或拼接。状态与正式结果位于同一 run，续跑沿用已接受任务与累计预算。

自动化接管 attribution workflow 后，工作台来源卡片才应启用扫描、清洗和运行控制；在那之前，禁止通过临时 manifest 或别名恢复旧 `answer-review` 路径。
