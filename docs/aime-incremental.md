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

输入扫描按一行为一条评测记录，保留该记录的全部 trace；按 trace 抓取时允许同一会话有多条记录；空回答、缺最终回答、缺 trace 身份、重复业务身份和冲突记录必须保留可定位原因，不得静默裁剪或拼接。内部 run 保留恢复账本、来源收据与累计预算，正式交付默认按[业务目录](usage.md#目录约定)整理：

```text
/mnt/fin_bench/eval_data/1_aime/3_eval_output/
├── 0_daily_eval/aime_fast/aime_fast-2026-10-19.jsonl
├── 0_daily_eval/aime_expert/aime_expert-2026-10-19.jsonl
└── 3_lost_user_eval/aime_fast/aime_fast-2026-09-17.jsonl
```

以上根目录只在外部配置中声明。日期取原始记录完整的 `batch_id`，不是评测启动日，也不截取 request_time 或改换时区；日常样本与流失样本的业务 case_id 来源不同，不能用正式行里的 session_meta.case_id 代替输入索引。启动前跨 run 检查并复用可核实的完整正式结果；新旧评测器可混用，保留原判词、版本和收据来源，同一回答多份结果以最新成功接受时间为准。
