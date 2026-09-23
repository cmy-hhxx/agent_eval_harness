# 使用指南

[返回首页](../README.md) · 输入和结果语义见[数据契约](contract.md)。

## 环境与配置

工具版本由 [mise.toml](../mise.toml) 固定。安装步骤见首页。根 `.venv` 供公共 Python 代码工具使用；Prime 自身的 runtime 位于 `.runtime/prime-python`，两者独立。

根 `.env` 是两种底座共用的模型连接配置：

```dotenv
EVAL_BASE_URL=https://api.openai.com/v1
EVAL_API_KEY=your-key
```

将 URL 换成实际网关地址，保留网关要求的 `/v1` 路径。`npm run eval`、`npm run doctor` 和两个 Worker 的 workspace start 命令自动读取根 `.env`；已有环境变量优先。切换 `--engine pi|prime` 不需要更换变量名或复制密钥。`.env` 不入库，示例见 [.env.example](../.env.example)。

[configs/host.json](../configs/host.json) 配置输入、模型和执行预算：

| 配置 | 含义 |
|---|---|
| `inputs.versions` | 文件与版本 ID、展示名称、A / AA 适配器的对应关系 |
| `inputs.timing_unit` | 原始耗时单位，`ms` 或 `s` |
| `judge.baseUrlEnv` / `judge.apiKeyEnv` | 共用 URL / key 的环境变量名 |
| `judge.api` | `openai-completions` 或 `openai-responses` |
| `judge.correctness` / `judge.pairwise` | 各阶段的模型、thinking、上下文和输出 token 上限 |
| `execution` | 并发、超时、工具预算、修正、重试和盲测种子 |
| `outputDir` / `cacheDir` | 运行产物和任务缓存 |

配置中的相对路径相对于配置文件目录解析。完整类型见 [EvalConfig](../packages/pairwise-eval/src/types.ts)，预算默认值见 [DEFAULT_POLICY](../packages/contracts/src/index.ts)。不在文档复制一套默认值。

## 目录约定

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `data/inputs/` | 四个版本的原始 JSONL | 否 |
| `data/runs/<run-id>/` | 当前 Host 的全部运行产物 | 否 |
| `.cache/evaluations/` | 当前任务缓存 | 否 |
| `.cache/npm/`、`.cache/uv/` | 下载缓存 | 否 |
| `.runtime/`、`.venv/`、`dist/` | 可重建的执行环境和构建产物 | 否 |
| `.artifacts/` | 开发验证日志、临时计划和检查结果 | 否 |

新数据和结果都放进 `data/`，不要新增根目录输入、输出文件夹。

## 运行与恢复

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001
npm run eval -- run --engine prime --run-id prime-001
npm run eval -- status --run data/runs/pi-001
npm run eval -- validate --run data/runs/pi-001
npm run eval -- report --run data/runs/pi-001
```

`preflight` 只检查输入，不调用模型；有输入问题返回退出码 2。没有有效配对时拒绝运行。`--config` 可指定配置；`--batch ID`、`--case ID` 可重复；`--limit-cases N` 按批次与 case 排序截取，不保证首题有有效配对。

```bash
npm run eval -- run --engine pi --run-id pi-001 --resume
npm run eval -- run --engine pi --run-id pi-001 --resume --retry-failed
```

有收据的任务不会再次调用模型；其余任务从新 attempt 开始，不接续半段模型流。输入、代码、模型、预算、种子或底座改变后新建 run ID。恢复仅服务同一运行契约，不承诺跨版本兼容。运行退出码：0 成功、2 有失败、130 被中断。

模型连接错误和流中断按 `execution.retries` 重试；提交修正预算耗尽会保留具体原因，不作为网络错误自动重试。Pi 会将工具拒绝反馈标记为 SDK 工具错误，供模型修正后重新提交。

## 运行产物

所有文件位于 `data/runs/<run-id>/`：

| 文件 | 用途 |
|---|---|
| `manifest.json`、`preflight.json` | 配置、指纹、输入、任务与状态 |
| `contract.json`、`output_schema.json` | 提示词、契约与 schema 快照 |
| `inputs/` | 原始输入快照 |
| `tasks/<id>/result.json` | 成功收据、用量与工具审计 |
| `tasks/<id>/attempt-NNN/` | 尝试的参数、事件、状态、错误和用量 |
| `tasks/<id>/artifacts/` | 脚本、stdout/stderr 和生成文件 |
| `results/*.jsonl` | 正式配对结果 |
| `task_summaries.jsonl`、`task_summaries.md` | 逐题结论、双方优缺点和耗时 |
| `correctness.jsonl`、`task_outcomes.jsonl` | 独立正确性与任务状态 |
| `failures.jsonl`、`skipped.jsonl`、`not_comparable.jsonl` | 执行失败、输入跳过、材料不足 |
| `summary.json`、`report.md`、`validation.json` | 汇总与离线校验 |

`report` 根据收据重建导出，要求运行自己的 schema 快照；`validate` 检查输入、收据、产物和导出映射，均不调用模型。用量区分成功收据和所有已记录 attempt；崩溃时缺失的完整用量会显式标记。

## Worker 与部署

默认由 Host 管理 Worker 进程。需要单独启动时：

```bash
npm run start --workspace @eval/agent-pi -- --port 4101
npm run start --workspace @eval/agent-prime -- --port 4102
npm run eval -- run --engine pi --worker http://127.0.0.1:4101 --run-id external-001
```

外部 Worker 由调用方管理，所有进程使用相同的模型 URL 和 key。Worker 只监听回环地址，适用于可信单机调用。

[Dockerfile](../Dockerfile) 构建整套系统，输入挂载到 `/app/data/inputs`，输出挂载到 `/app/data/runs`，用 Docker `--env-file .env` 注入模型配置。当前未验证容器构建；构建时 doctor 使用占位 URL 且不调用模型，运行时必须设置实际 URL 和 key。

代码工具工作目录不是安全沙箱；取消、超时和 Worker 退出会回收所属进程组。需要隔离不可信代码时，应在受限部署环境运行整个系统。
