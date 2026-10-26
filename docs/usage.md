# 使用指南

[返回首页](../README.md) · [数据契约](contract.md) · [自动化](automations.md)

## 最短路径

先完成 [README 本地开发步骤](../README.md#本地开发)，再预检和运行：

```bash
npm run eval -- preflight
npm run eval -- run --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- status --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001
npm run eval -- report --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001
```

`preflight` 不调用模型，有输入问题退出码为 2。`run` 解析模型与密钥；执行退出码为 0 成功、2 有失败、130 中断。

## 环境与配置

[config.example.ini](../config.example.ini) 是渠道与环境模板。每个 `[channel.<id>]` 提供独立地址、密钥和 API；相同模型在不同渠道中仍是不同选择。修改后重启，密钥不入库。

```ini
[channel.evaluation-gateway]
base_url = https://your-gateway.example/v1
api_key = your-gateway-key
api = openai-responses
```

评测入口只接受 `openai-responses`，不自动降级协议。URL 保留网关要求的路径；`models = model-a,model-b` 声明静态目录，适合没有 `/models` 的自部署服务。未声明时才发现远程目录；一个渠道发现失败不隐藏其他渠道，错误在看板按渠道呈现。重复或未知字段报错，支持整行注释和引号字符串，不支持行尾注释或变量插值。完整字段以模板和 [settings.ts](../apps/host/src/settings.ts) 为准。

`[environment]` 保存搜索、Mongo、代理等服务端变量，覆盖同名进程变量。代理配置须让 localhost、127.0.0.1、::1 直连。评测和服务器 Eris 均不读取本机 .env，Eris 独立配置见 [Agent 配置](../agent/README.md#模型与设置)。测试或独立部署可用 `EVAL_CONFIG_FILE` 指定 INI。

JSON 配置的 `models.<profile>.channel` 引用渠道。`--config` 可重复，按顺序深度合并；数组整体覆盖，相对路径按各自文件目录解析。共享配置在 [host.json](../configs/host.json)，本机模型填入 `configs/local/models.json`。

启动与 preflight 会在派发任务前逐个校验 `models.json` 的模型以及阶段绑定覆盖：模型必须存在于对应 channel 的 `models` 声明中。错误包含 channel、model 和可用 models；同一配置只产生一次启动/预检失败。多个渠道使用相同模型时，每个渠道都必须声明该模型，并通过 `[automation].channels` 显式加入渠道池。

渠道是协议与能力的唯一来源：INI 中配置 `api`、`context_window`、`max_output_tokens`、`supports_developer_role`、`supports_explicit_prompt_caching` 与 `efforts`。JSON 模型档案只声明 `channel / model / thinking`，阶段 `bindings` 选择档案或覆盖这三项。更换端点和模型无需修改业务 Agent；不支持 developer 角色时显式配置 false，显式提示词缓存仅在声明 true 时启用。

协议探测默认只检查配置，显式执行才调用模型：

```bash
npm run eval -- model-probe --stage comparison --config configs/local/models.json
npm run eval -- model-probe --stage comparison --config configs/local/models.json --execute
```

探测通过实际 SDK 验证流式工具参数、工具结果续轮、最终文本与用量。一次执行计一次阶段尝试，通常包含两次模型请求；60 秒截止，不自动重试。输出 `status / attempts / modelRequests / toolCalls / usage` 和脱敏错误。探测使用所选阶段的思考参数，单次响应最多 512 输出 token；若单独选择低推理配置测协议，应在实验记录中注明，不能据此宣称生产推理条件已通过。

| 配置 | 用途 |
|---|---|
| evaluatorVersion | 必填的[评测器标识](contract.md#评测器版本标识) |
| inputs / comparisons | 来源、适配器、耗时单位与同档模型组 |
| models / bindings | 模型档案与阶段覆盖 |
| execution | 并发、期限、工具预算、修正、重试与熔断 |
| reviewQuestions | 按 batch/case 声明待核问题，不预置判词；重评已接受结果用新 run |
| standardAnswerReview | 默认关闭；显式启用标准答案质疑与复核 |
| rewrite | 归因、对比、逐项点评及聚类改写，默认开启 |
| clustering | 主线默认关闭；后置聚类的支持数与类数预算 |
| output / problemLibrary | 运行根目录与每模型问题库 |

默认值与字段全集直接查 [EvalConfig](../packages/workflows/src/comparison/types.ts)、[DEFAULT_POLICY](../packages/contracts/src/index.ts)、[loadConfig](../apps/host/src/config.ts)，不复制到文档。

归因中的私密规范裁剪容器只用于导航；证据从未改写的原文叶子读取。业务链路检查点覆盖已登记的完整边界，分页窗口不限制可引用的后文；调查事实、环节、责任主体与证据各用自身目录编号。用户问题与设备事实不自动成为专有规范，真实本方规范继续按其作用域检查。提交仅使用工具当前 Schema 的字段和枚举，修正不增加提交上限。

Attribution 的 `execution.sessionWindow` 默认 16，必须是正整数；执行、进度和续跑使用同一 effective 值。`execution.taskConcurrency` 是任务槽位硬上限且不再随模型并发放大，内置 Worker 按实际可派发任务惰性启动。

共用配置把 Rewrite 的推理档位单独设为 `low`，保留润色，只处理已接受文本；其他阶段沿用各自配置。专项的后置覆盖也须保留该阶段设置，不能用全阶段 `high` 覆盖。降低推理档位不是语义保真证明，仍按改写验收流程对照原文抽查。

`run / reattribute / cluster --balance-channels` 按 INI 的 traffic_weight 分配完整任务，普通重试保持渠道，明确配额耗尽才切换；各渠道须提供相同阶段模型。自动化渠道池见[自动化启动与调度](automations.md#启动与调度)。

## 目录约定

真实评测产物统一放在数据源的 `/mnt/fin_bench/eval_data/{source}/eval_output/` 下；不得写到 checkout 或 runtime 的其他目录。配置、流水线状态、输入快照与日志仍由外部 runtime 管理。生产目录与启动方式见[远程部署](deployment.md)。

| 位置 | 内容 |
|---|---|
| configs/local/ | 不入库的本机覆盖配置 |
| data/sources/ | 原始 JSONL，长期只保留在这里 |
| data/input-catalog/ | 业务身份及字节位置索引，不存正文 |
| {source}/eval_output/0_daily_eval/<YYYY-MM-DD>/results/ | 日常正式评测，按业务日期归档 |
| {source}/eval_output/0_daily_eval/<YYYY-MM-DD>/cluster/ | 当天的聚类树与状态；未开始时保留空的 `cluster_tree.jsonl` 和 `state.json` |
| {source}/eval_output/1_task_eval/<任务>/ | 专项正式评测 |
| 当前评测目录的 attribution/、clustering/ | 独立归因与聚类作业 |
| {source}/eval_output/test_eval/ | 所有小样本、试跑、benchmark 与稳定性验证 |
| data/problems/ | 每模型问题库 |
| log/ | 共用日志与统计交付记录 |
| .runtime/、.venv/、dist/ | 执行环境与构建产物 |
| .artifacts/ | 临时开发验证材料 |

日常来源按 `data/sources/model-answers/<model>/<运行开始日>.jsonl` 整理，也可使用任务命名文件。记录身份以 JSON 为准，不按文件名分批。原始输入、运行结果、缓存和本机配置不入库。

### 历史问题样本的来源复核

原材料反证已有问题时，按 [occurrence-review Schema](../schemas/clustering/occurrence-review.schema.json) 准备含稳定 UUID、目标和真实来源证据的决定文件：

```bash
npm run eval -- review-problem-occurrences --review-file /tmp/problem-review.json
npm run eval -- review-problem-occurrences --review-file /tmp/problem-review.json --apply
```

默认预览；apply 在模型锁内追加撤销事件，不调用模型、不改原归因或历史结果。语义与幂等边界见[问题库契约](contract.md#问题库与聚类)。

## 输入治理

先在 inputs.versions 注册模型、适配器和来源，再在 comparisons 选择同档模型组。同 case 的 batch_id、case_id、问题及标准须符合[输入契约](contract.md#输入)。

命名评测集显式登记一组来源，避免目录扫描混入其他日期：

```bash
npm run eval -- index --dataset competitor_comparison --dataset-name 竞品对比 \
  --input a_fast=data/sources/model-answers/a_fast/竞品对比.jsonl \
  --input b_fast=data/sources/model-answers/b_fast/竞品对比.jsonl \
  --config configs/host.json
npm run eval -- preflight --dataset competitor_comparison
npm run eval -- run --dataset competitor_comparison --run-id competitor-001 \
  --config configs/host.json --config configs/local/models.json
```

`--input ID=PATH` 可重复；`--catalog DIR` 改变索引根目录，后续选择使用同一目录。`--dataset` 与临时 `--input` 不可混用。缺少 batch_id 且没有全局默认批次时，使用评测集 ID。

索引只存文件、行号、UTF-8 字节位置及诊断。选择时重新核对原始文件，修正文件后重新 index；无效或重复记录不能因已建索引而参评。未传 dataset 时扫描配置来源。

续跑按 state.json 中的原来源恢复，再传 dataset 不切换来源。未完成记录缺失或无效时跳过并报告诊断，已接受结果保留。运行中修改源文件会拒绝受影响读取，保存进度后同 ID 续跑。数据与任务页支持按压缩包批次清洗和核对输入，并将所选批次交给新运行预检、启动，操作见[批次运行](workbench.md#当前批次运行操作)；命名评测集使用 CLI。

### 第三方模型

用 [third-party.example.json](../configs/third-party.example.json) 注册第三方及完整模型数组。最小输入为真实原问和完整最终答案：

```json
{"batch_id":"baseline-check","case_id":"q1","messages":[{"role":"user","content":"2+2等于多少？"},{"role":"assistant","content":"4"}]}
```

适配器与厂商无关，未采集的内部过程、耗时与 token 不补造。新增参赛模型用新 run ID；自动化仍限定其四模型输入。

```bash
npm run eval -- preflight --config configs/host.json --config configs/third-party.example.json
npm run eval -- run --run-id third-party-001 \
  --config configs/host.json --config configs/third-party.example.json --config configs/local/models.json
```

## 日志

| 文件 | 用途 |
|---|---|
| log/runtime.log | 命令、任务、Worker 与自动化诊断；错误保留原因、堆栈和可用身份 |
| log/evaluation.log | 已接受收据的业务结果，按提交身份去重；改写不单独记录 |
| log/comparison-statistics-log.jsonl | 自动化统计交付记录，见[四小时统计快照](automations.md#四小时统计快照) |

日志为 UTF-8 单行 JSON，持续追加。正常重复事件一分钟内合并，错误逐条保留；密钥脱敏。续跑补记已接受结果，日志失败不撤销判决。日志不是恢复数据源，不按日期或 run 新建日志文件。

```bash
tail -f log/runtime.log
```

写入、锁与中断末行处理由 [logging.ts](../packages/data/src/logging.ts)维护。

## 运行与恢复

`--batch ID`、`--case ID` 可重复，批次取并集再与 case 取交集；`--limit-cases N` 按排序限制整个范围，保存在 run 中。`--output DIR` 可覆盖运行根目录，`--debug` 额外保存排查材料。

相同 run-id 保留原筛选、A/B 映射、UUID、成功收据和累计用量；代码、模型、预算、评测器变化不阻止续跑。未完成任务使用当前有效材料与配置，发现原范围内新增任务。新增日期、模型集合或重评成功结果使用新 ID。

试跑、补失败或定向改写会保存 executionScope。普通续跑只执行该清单，不发现输入或按开关重规划；`--discover-inputs` 才释放范围，且不扩大原 batch/case/limit 条件。`--skip-failed` 推进其他可完成任务，保留已有失败状态。

| 预算/故障 | 恢复规则 |
|---|---|
| 内容提交 | 同任务跨 attempt 和续跑共享 `1 + (stageRepairAttempts[stage] ?? repairAttempts)` |
| 文件/JSON 加载错误 | 独立累计 fileErrors，新的加载失败达到三次上限时停止；续跑不清零，但已成功加载的内容仍可使用剩余内容修正预算 |
| 传输、流中断及可恢复提前结束 | 按 retries / retryDelaySeconds 有界重试 |
| 取消、总期限、耗尽预算 | 停止，不靠重启清零 |
| 未确认 Worker 最终账本 | 保存已知计数与原因，不推测用量 |
| 源材料修订 | 清除失效草稿与阅读状态，保留历史计数 |

文件提交任务会保存最近一次成功 `edit_json` 写入的草稿。超时或中断后，续跑从 `submission-rejected.json` 恢复；写草稿不计内容提交，也不代表通过校验，仍须正常提交。仅写草稿、尚无校验拒绝时，空闲超时或无提交结束仍按 retries / retryDelaySeconds 有界重试；写入不清除已有校验错误，也不重置累计预算。失败的写入不覆盖已保存草稿，盲核查通过后清除核查阶段草稿。

提高实际阶段上限只增加差额，不补发完整预算。标准复核开关关闭会撤下未接受复核，已接受结果保留。提交反馈见[数据契约](contract.md#提交方式与反馈)。

### 只补失败与同类故障熔断

停止该 run 的 Host，先预览，再准备固定补跑范围：

```bash
npm run eval -- retry-failed --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001
npm run eval -- retry-failed --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --task <task-uuid> --apply
npm run eval -- run --run-id pi-001 --config configs/host.json --config configs/local/models.json
```

task / result 可重复；成功任务不重评，必要未完成依赖进入清单。准备不重置内容和加载账本。

同阶段、不同任务的同类错误达到 failureGuard 阈值时暂停该阶段，其他健康阶段继续。修复原因后显式解除：

```bash
npm run eval -- run --run-id pi-001 --resume-stage rewrite \
  --config configs/host.json --config configs/local/models.json
```

resume-stage 可重复，保留固定范围。自动化的退避与保护性暂停另见[自动化启动与调度](automations.md#启动与调度)。

### 小批验收再放量

真实模型测试使用 `run --test-eval`，输出自动进入同来源的 `eval_output/test_eval/`；问财测试也可最后加载 `configs/test-eval.json`。`--pilot-cases` 自动使用该目录，按日期、模型组选择对局并带上依赖，保留完整计划。续跑或释放剩余测试计划时保留 `--test-eval`。benchmark 和 validate-stability 同样强制使用同来源 test_eval，越界的 --output 会报错。

```bash
npm run eval -- run --run-id pilot-001 --pilot-cases 40 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/pilot-001 --selected --require-rewrite verdicts
npm run eval -- rewrite-review --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/pilot-001 --limit-cases 50
npm run eval -- run --test-eval --run-id pilot-001 --discover-inputs \
  --config configs/host.json --config configs/local/models.json
```

释放前按[改写放量验收](quality.md#改写放量验收)检查。运行中用 `concurrency --run PATH --value N` 调整上限，`progress --run PATH` 查看状态；降低并发让在途任务自然完成。以新增正式交付衡量产出，不用 Worker 数代替。

问财优先执行所选范围的标准、归因与比较；主评测仍有待执行或在途任务时，后置指令复核和改写不占用执行槽位。主评测收尾后完成独立指令检查与全部改写，成功收据在同 run 续跑中保留。指令复核的来源目录按消息字段和规范标题提供原文读取坐标，完整输入快照仍可按需读取。

### 清洗批次运行

工作台「数据与任务」选中同任务的清洗批次后进入预检；具体操作见[批次工作流](workbench.md#当前批次运行操作)。Host 接口由网关映射到 `/runtime/api/dashboard/`：

| 接口 | 行为 |
|---|---|
| `POST batch-runs/preview` | batch_ids、settings；生成 UUID 和固定范围，返回预检及输出目录 |
| `GET batch-runs` | 持久化批次关联和当前运行状态 |
| `POST batch-runs/<run>/start` | 重新校验输入/模型后启动，重复启动拒绝 |
| `POST batch-runs/<run>/resume` | 恢复全部未完成任务，可显式传 resume_stages 解除阶段暂停 |
| `POST batch-runs/<run>/retry` | 可传 task_ids 定向补失败，缺省补全部失败与依赖，不重评成功项 |
| `POST batch-runs/<run>/archive` | 停止后登记归档时间；续跑清除标记，结果原地保留 |
| `GET batch-runs/<run>/artifacts` | 正式产物清单；file 参数下载清单内单文件 |
| `POST analysis/scope` | task_id、batch_ids（空为全部包）、run_ids；page/status 分页筛选回答纳入状态 |
| `POST analysis/preview` | 同上范围字段；冻结最新接受归因引用，返回作业 UUID 与计划，不占用 |
| `POST analysis/<job>/start` | 原子占用冻结范围并执行独立聚类 |
| `POST analysis/<job>/resume` | 同作业续跑；可传 resume_stages 解除已暂停阶段 |
| `POST analysis/<job>/stop` | 停止分析；保留收据和范围占用 |
| `GET analysis` | 已启动分析作业、真实任务状态和错误 |
| `GET analysis/<job>/errors` | page、stage、case、history；聚类任务错误及统一日志历史 |
| `GET analysis/<job>/sources` | page 分页返回冻结归因与待观察召回引用，附各自总数 |
| `GET analysis/<job>/artifacts` | 分析正式产物清单；file 参数单文件下载 |
| `GET runs/<run>/errors` | page、stage、case、history；未恢复任务及统一日志中的历史 |

启动关联存于 `EVAL_WORKBENCH_RUNS_DIR`，由 supervisor 设置在运行配置目录内；数据服务内部地址由 `EVAL_WORKBENCH_DATA_URL` 注入。输入只从服务端清洗报告获取。现有 runs 的样本、结果、停止和并发接口识别批次运行的实际输出目录。分析登记在其同级 `workbench-analysis/`，正式结果在任务输出目录的 `clustering/`；操作与纳入语义见[手动分析](workbench.md#结果归档与手动分析)。

### 运行实例 API

```bash
npm run eval -- dashboard --port 4173 --config configs/host.json --config configs/local/models.json
```

该命令只启动运行实例 API，不提供独立页面。生产由 `workbench.sh` 启动同一服务并只监听 `127.0.0.1:4173`，由远程 `/` 统一工作台读取接口。端口被占用时启动失败，不自动切换。

统一工作台按需读取评测运行、正式结果、改写与问题库；删除须确认，清除该 run 产物及两份运行日志中的对应记录。活动或损坏锁、损坏日志阻止删除，原始输入、共享问题库、其他 run 与聚合交付回执保留。界面规范见 [PRODUCT](../PRODUCT.md)。

## 可选复核与后置聚类

### 后置稳定性实验

`validate-stability` 通过同一 Host 注入独立 Workflow，默认预览，`--execute` 才派发。可用显式样本清单从原材料建立新基准，也可用 `--run` 引用符合当前契约的已接受来源结果。清单类型见 [StabilityCase](../packages/workflows/src/comparison/stability.ts)，每项包含完整 batch/case、两个同档回答的模型身份、来源文件和一基行号，以及 rewrite/end_to_end 开关。

```bash
npm run eval -- validate-stability --cases /path/to/cases.json --run-id stability-001 \
  --max-attempts 240 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- validate-stability --cases /path/to/cases.json --run-id stability-001 \
  --max-attempts 240 \
  --config configs/host.json --config configs/local/models.json --execute
npm run eval -- validate-stability --run-id stability-001 \
  --config configs/host.json --config configs/local/models.json --execute
```

同实验 ID 续跑时省略样本、来源、种子和限额选项，沿用已保存的计划、UUID 与累计额度，不重复接受成功试次。首次引用来源结果及续跑都会按业务身份重读原材料，允许文件行重排；问题、参考答案、最终回答位置或其他评测元数据与计划不一致时明确报错，应使用当前来源结果，或通过 `--cases` 新建实验。每题五次原位与五次真正重新调用的换位交错执行；可选择五次整场改写及三次完整链路。失败、重试也消耗阶段额度，240 次是阶段尝试上限，不是 API 请求数或金额；外部协议探测须先从实验额度中扣除。可选 `--stop-starting-at` 接受带时区的 ISO 截止时间，阻止到期后新派发，在途调用仍可完成。

产物为 `validation.json`、`validation.md`、`results/stability-results.jsonl` 和 Host 恢复状态。辅助 `model-behavior.jsonl` 只汇总基准归因。实验不更新来源判决，不进入业务胜率或统计上传。解释方式与语义复核见[质量指南](quality.md#后置稳定性实验)。

`validation.json` 的 `execution.tasks` 保留全部原计划任务，包括未派发改写和整链各阶段，列出当前状态、累计尝试、当前原因、等待依赖与执行范围；`execution.paused_stages` 和 `stop_reason` 分别保留阶段熔断与预算/时间停止原因。未完成任务仍在原分母中，预算不足不冒记为内容失败。当前原因最多 500 字符，完整上下文在 `state.json`。这不是历史失败账本：成功恢复会清除当前失败上下文，历史失败按 `run_id`、`task_id`、`attempt_id` 查询仓库根目录 `log/runtime.log`，报告不复制草稿或证据库。

独立审阅结果写入实验根目录 `semantic-review.json` 数组：每项包含 `task_id`、`submission_id`、`reviewer: {kind: "agent" | "human", name}`、`result: "passed" | "failed"` 和 `rationale`。只绑定当前已接受的改写收据；重复、过期或未知引用会报错。未记录的改写保持未审，整链中的改写也进入覆盖分母。重建报告保留已记录的语义失败，不改写原判词。

按[三层验收](quality.md#三层验收)填写审阅：保真硬错误为 failed；仅有非决定性措辞缺陷可为 passed，并在 rationale 留下缺陷与不影响原意的依据。Comparison 的 needs_review 表示已停下等待来源或关键口径复核，单列在未裁决数量中，不等于执行失败，也不冒充胜负或平局。

停止实验 Host 后，用 `npm run eval -- report --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/stability-001` 重新生成实验报告，不调用模型。

### 独立核验与聚类

已接受正式对比的独立核验：

```bash
npm run eval -- verify-comparisons --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --result <comparison-id>
npm run eval -- verify-comparisons --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --result <comparison-id> --apply
npm run eval -- run --run-id pi-001 --config configs/host.json --config configs/local/models.json
```

省略 result 选择全部正式对比。默认预览，apply 保存核验范围；结果不替换主线判词。

归因结束后，可跨 comparison 或 answer-review run 创建独立聚类，聚类命令使用包含 clustering 和 problemLibrary 设置的对战配置：

```bash
npm run eval -- cluster --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --run-id problems-001
npm run eval -- cluster --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --run-id problems-001 \
  --config configs/host.json --config configs/local/models.json --apply
npm run eval -- cluster --run-id problems-001 --apply \
  --config configs/host.json --config configs/local/models.json
```

工作台使用 `--clustering-selection FILE` 读取冻结来源引用，不能与 `--run` 同传；不会扩展到后续接受的结果。

已冻结的成功归因可与源评测并行聚类。源 run 中无关任务更新不阻断读取；所选归因、收据或输入引用在读取期间变化仍会报错。

run 可重复；续跑只给作业 ID，查看进度省略 apply。来源状态及正式归因须可读，聚类不等待对比、改写或可选核验；失败归因跳过。新增日期或显式重聚类用新作业 ID。评测 run 内延期观察也可用 `recluster --run PATH --task ID` 或 --all 预览，apply 后同 run 续跑。

独立聚类全部任务完成后，在作业根目录生成 `cluster_tree.jsonl`，每行一个模型、实际组件/处理环节/功能、问题方向或具体问题节点；待观察问题单列，无问题回答仍列入模型节点的冻结来源范围。组件分桶直接继承归因，不能用业务问题名称或笼统模型能力标签替代真实节点。节点内问题计数按回答和 finding 去重，多责任问题可出现在不同责任分支，父计数按并集计算。`validate --run` 核对来源收据、全量任务覆盖及已落盘树与当前问题库的一致性；缺失、篡改或未完成不能通过。

### 从正式对比数据重新归因

reattribute 按明确来源的正式对比定位回答，重做共同标准、归因与改写，不执行 Comparison，也不改来源 run。

```bash
npm run eval -- reattribute --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 \
  --from-date YYYY-MM-DD --pilot-answers 30 --run-id attribution-pilot
npm run eval -- reattribute --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 \
  --from-date YYYY-MM-DD --pilot-answers 30 --run-id attribution-pilot \
  --config configs/host.json --config configs/local/models.json --config configs/test-eval.json --apply
npm run eval -- reattribute --run-id attribution-pilot --apply \
  --config configs/host.json --config configs/local/models.json --config configs/test-eval.json
```

默认预览，apply 执行。pilot-answers 和 pilot-per-model 自动写入同来源 test_eval/attribution；续跑加载相同测试输出覆盖配置。pilot-answers 选择回答数，冻结完整计划及当前范围；`--pilot-per-model N` 可在原计划内扩充每模型配额，不得缩小或超过可选数。`--discover-inputs` 释放完整计划，不能与扩充参数同用。

试跑校验用 `validate --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/attribution/attribution-pilot --selected`。定向语义复核通过公开 prepareAttributionTargetedReviews 入口准备；接受后补齐改写。后置聚类可读取已完成试跑范围。

```bash
node scripts/attribution-review.mjs --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/attribution/attribution-pilot \
  --clustering /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/clustering/attribution-pilot-tree
```

审阅脚本生成 review.html 与每模型 JSONL；默认读取 data/problems，可用 --library / --samples 指定问题库和摘要。不修改正式结果、问题库或执行范围。

专题仅导出一个模型时，增加 `--model b_post_train_fast`；`--json PATH` 同时保存归因树 JSON。只导出所选模型的节点、待观察池、样本及模型 JSONL，其他模型不会生成文件。独立聚类的来源由作业冻结引用确定，可把 `--run` 指向单独的交付目录，将审阅产物与来源 run 分开保存。

同一问题库的原聚类与增量聚类可重复传入 `--clustering`，合并各作业冻结的归因来源及待观察原因，按当前问题库投影已归类样本。作业目录或来源输入重复时拒绝导出；来源收据与正文保持原样，不重新调用模型。

专题最终归因树须等源评测及完整输入安装结束；覆盖范围使用 `full-evaluation`，列出目标、已接受和最终排除的归因数量。原聚类与增量聚类的来源及成功收据分别保存在 `clustering.jobs`，全部作业须完成聚类和改写，合并后严格对应源评测的最新成功归因，不能把中途快照当成完整交付。

### 重新改写对比文案

停止该 run 的 Host，预览后加 apply，再同 ID 续跑：

```bash
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --scope items
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 \
  --scope items --mode refresh --result <comparison-id> --slot comparison.2.B.summary --apply
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 --scope verdicts --apply
```

默认 missing 补缺；refresh 必须指定 task、result 或 --all。scope 为 items 或 verdicts，slot 可重复。应用保存固定清单，只更新选中槽位；应执行完当前清单再准备下一份。未完成同范围任务复用 UUID 与预算，已接受改写的刷新创建新 UUID。

## 运行产物

| 文件 | 用途 |
|---|---|
| state.json | 周期性派生快照：任务状态、来源索引、收据引用和累计用量；不保存完整修复/复核现场 |
| progress.jsonl | 已投影的追加式状态事件，按序号配合 state.json 恢复；不复制正式结果正文 |
| overview.json | 运行目录与预计算统计：正式战绩、比例和结果引用，不保存正文 |
| results/criteria.jsonl | 共同标准 |
| results/attribution.jsonl | 单回答归因与证据 |
| results/comparison.jsonl | 已决的正式两两对比 |
| results/comparison-review.jsonl | 主线待核，不计对战结果 |
| results/comparison-verification.jsonl | 可选独立核验 |
| results/clustering.jsonl | 归类与来源引用 |
| 源结果的 rewritten | 改写文案；独立聚类作业另用 results/rewrite.jsonl |
| report.md、task_summaries.md | 总览与逐题呈现，优先用已接受改写 |
| stats.json | 数量、覆盖、冲突、版本、用量及产物清单 |
| model-behavior.jsonl | 由当前有效归因派生的责任分类与 finding 来源，不提供底座排名 |

正式 JSONL 是判词的权威存储，state 不重复保存已接受正文。运行中的提交先在本地 SQLite WAL 热日志中原子确认，再由 outbox 投影到正式 JSONL 和 progress.jsonl；进程崩溃重放本地事件，整机故障允许最多 5 秒未投影进度。崩溃恢复可处理相同重复行与中断尾行，冲突或缺失正式结果明确报错，不自动重评。写入顺序见[生命周期](architecture.md#生命周期)。

`state.json` 仅周期写入，并对错误消息、错误数量和 receipt 审计做固定压缩；draft、completion candidate、inspection、evidence bank 与完整 review 上下文不进入检查点。热日志和 outbox 路径由 `EVAL_HOT_STATE_ROOT` 控制，默认位于 `~/.cache/eval-agent-harness/hot`；生产应放在本机 SSD，不放在 Ceph。

Worker 健康检查暂时失败时，Host 暂缓使用该槽位并重查，不终止仍存活的进程，也不增加任务尝试次数。托管槽位绑定具体子进程，确认进程退出后才重建，避免端口复用误认其他 Worker。

stats 的胜负按对局，标准一致性及核心完成按回答去重；未知、冲突与覆盖单列。Token 包含已记录失败与重试，未知终态不算零；缓存命中率为 cacheRead / (input + cacheRead + cacheWrite)。任务累计耗时与首次启动后的 wall_seconds 分开，后者包含停机间隔。

debug 才保存 _internal/：契约快照、attempt 参数与记录、事件日志、工具产物及诊断。已有 run 可开启 debug，但不补造历史材料。事件收集不完整时保留副本及错误，不重评成功任务。report --details 仅用于 debug 运行。

report 重建报告与统计，不调用模型；validate 检查结果、证据、覆盖及可选附件。计划未完成时整体 valid=false，不能用已有行合法代替全量完成。

```bash
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/pi-001 \
  --require-batch <batch-id> --require-rewrite verdicts --require-rewrite items
```

require-batch / require-rewrite 可重复。selected 只缩小交付覆盖范围，已有收据与证据仍检查；缺失槽位或未完成刷新明确报告。语义验收另见[质量指南](quality.md)。

## 独立运行 Worker

默认由 Host 管理，外部 Worker 可显式启动：

```bash
npm run worker -- --engine pi --directory .runtime/workers/pi-1 --port 4101
npm run eval -- run --worker http://127.0.0.1:4101 --run-id external-001 \
  --config configs/host.json --config configs/local/models.json
```

外部 Worker 读取同一 INI，须具备所选渠道凭据，由调用方管理恢复。仅监听回环地址。代码工作区不是安全沙箱，隔离边界见[架构](architecture.md#新工具)。

高并发可用 `worker --slots 25` 在一个 Node 进程内启动 25 个独立 HTTP 槽位，复用已加载的 SDK。ready 消息的 `urls` 列出各槽位地址，向 Host 重复传入 `--worker URL`；Host 总并发上限保持不变。各槽位独立保存任务、会话、工具预算及取消状态，目录按 slot 隔离。非零 `--port` 使用连续端口，默认由系统分别分配。池进程退出影响该池的全部槽位，由调用方监督恢复；关闭池会收尾全部活动任务。

## 独立评测分析 Agent

在服务器使用 `bash agent/run.sh --config <eris.json>` 启动 Eris，配置、数据、会话和验证见 [Agent 说明](../agent/README.md)。
