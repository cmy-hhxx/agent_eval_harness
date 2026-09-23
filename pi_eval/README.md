# Pi Eval

通过本机 `pi` 执行与 Prime Eval 相同的两阶段评测。已用 pi 0.86.1 验证 RPC、严格提交和本地计算接口。

`pi_eval/` 是独立模块，不导入 `prime_eval/`，也不启动 Prime daemon。输入适配、任务调度、恢复、校验、报告、提示词、schema 和扩展均在本模块内独立维护。初始规则从当前 Prime 版本完整复制；以后修改一方不会改变另一方的源码指纹或缓存。需要两边同步规则时，应分别修改并运行两组测试。

两套评测读取同一份 `eval_input/`，使用相同的默认裁判模型、执行参数及随机种子。pi 使用 schema 3.4，Prime 保留 3.3。共用 `PRIME_EVAL_API_KEY` 环境变量；配置、缓存和输出目录分别独立：

| 项目 | Prime | pi |
| --- | --- | --- |
| 命令 | `prime-eval` | `pi-eval` |
| 配置 | `configs/eval.toml` | `configs/pi-eval.toml` |
| 代码 | `prime_eval/` | `pi_eval/` |
| 凭证环境变量 | `PRIME_EVAL_API_KEY` | `PRIME_EVAL_API_KEY` |
| 产物 | `eval_output/` | `eval_output_pi/` |
| 缓存 | `.eval-cache/` | `.pi-eval-cache/` |

## 运行

在项目根目录执行。两边直接使用原评测密钥，不需要另外设置 pi 的 key。若凭证已保存在项目 `.env`，通过 uv 加载：

```bash
uv run --env-file .env pi-eval run --run-id batch-001
```

凭证值不写进配置或命令参数；每个任务使用独立的 pi 配置目录，`models.json` 使用 pi 的 `$PRIME_EVAL_API_KEY` 环境变量语法，不读取个人 `~/.pi/agent` 配置。以下命令假定环境变量已加载；否则为 `uv run` 加上 `--env-file .env`。

```bash
uv sync --locked
uv run pi-eval prepare
uv run pi-eval preflight
uv run pi-eval run --run-id batch-001
uv run pi-eval validate --run eval_output_pi/batch-001
uv run pi-eval report --run eval_output_pi/batch-001
```

`prepare` 只核验和记录当前安装的 pi 路径、版本及 JS 运行时代码 SHA256，不升级本机安装，也不联网查询最新版本。新 run 要求检查记录在 24 小时内；恢复运行时重新核验运行时指纹。pi 版本或代码、输入、评测代码、模型、提示词或 schema 变化后，应使用新 run ID。

先检查一个 case，再运行小批次：

```bash
uv run pi-eval preflight --limit-cases 1
uv run pi-eval run --run-id pi-smoke --limit-cases 1
```

`--limit-cases` 按批次和 case 排序截取，不保证首题有完整配对。若预检显示 `pairwise_tasks=0`，请使用 `--batch <batch-id> --case <case-id>` 选择同档位双方均有回答的 case。

按阶段运行、恢复和查看进度：

```bash
uv run pi-eval run --run-id batch-001 --stage correctness
uv run pi-eval run --run-id batch-001 --stage pairwise --resume
uv run pi-eval run --run-id batch-001 --resume --retry-failed
uv run pi-eval status --run eval_output_pi/batch-001
```

`--batch`、`--case` 可以重复传入，筛选参数在恢复时须保持一致。`report --config configs/pi-eval.toml` 仅刷新显示名称和输出 schema，不调用模型。不同模块请使用各自的运行目录，不能跨模块恢复。

## 评测要求

- 只允许 A Fast ↔ AA Fast、A Expert ↔ AA Expert；候选 A/B 使用与 Prime 相同的固定种子随机分配。
- 有标准答案时先独立判对错，再比较两份回答；主观题跳过正确性核验，保留 `is_correct=null`。
- 逐字证据引用、受限材料读取、已有内嵌图像观察、本地双方计算及严格 `submit_evaluation` 工具提交。
- 主评测一次完成，不另加质检模型；保留配置中的结构修复及网络失败重试。
- 配对评测先调用 `set_task_contract`，仅根据当前用户问题、必要的用户/助手对话历史固定共同标准，不提供候选自带的系统/开发者指令。随后工具返回当前候选回答、执行轨迹和耗时。固定标准前，读取、计算和提交工具不可调用；标准固定后不能根据候选表现修改。仍在同一 pi 会话内完成，多一次固定标准的模型往返。
- 每项发现关联一个预先固定的要求，分别记录观察、证据确定性和实际影响。判决引用双方具体发现；不确定的发现不能决定胜负或平局。已确认的重要反向证据必须列出并解释取舍。
- 原始回答耗时与裁判耗时分别记录。结果、逐题总结、工具回溯及审计文件与原有格式一致。
- 每次调用启动独立 pi RPC 进程。提交通过本地校验后立即保存任务结果，并只结束本次调用的进程组；缓存及断点恢复以任务收据为准。

完整字段说明见[输入与输出契约](../版本对比处理说明.md)。

pi 3.4 在原格式基础上增加 `task_analysis`、`decision_basis` 和每个 finding 的 `assessment`。`requirement_index`、`finding_index` 从 0 开始，导出后 `decision_basis` 中的 `candidate` 使用版本 ID。每个尝试目录的 `task-contract.json` 保存回答展示前固定的标准，`result.json` 保存完整审计关系。旧运行目录保留自己的 schema；新协议须使用新 run ID，不能复用旧判决缓存。

程序检查引用确实存在、标准未被改写、发现关联有效、证据确定性和判决方向没有形式冲突；它不证明模型的事实判断、影响分级和取舍正确。质量验证应使用独立人工判断、位置交换、等价改写、关键内容变更、重复运行及新任务样本，不能把另一种 harness 的结论直接当作真值。

## 验证

```bash
uv run pytest -q tests/test_pi_*.py
uv run pyright pi_eval tests/test_pi_*.py
node --test tests/pi-tools.test.mjs
```

`tests/test_pi_integration.py` 使用真实本机 pi 和本地模拟网关验证两阶段、API Key 解析、严格工具 schema、双方计算及恢复，不调用远程模型；未安装 pi 时跳过。其他 pi 测试不需要本机 pi 或网关凭证。
