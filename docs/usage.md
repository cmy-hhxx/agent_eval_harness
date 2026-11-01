# 使用指南

[返回首页](../README.md) · [数据契约](contract.md)

## 最短路径

本地完成开发和推送，服务器拉取代码、安装构建并准备真实输入后，再在服务器预检和运行。数据选择范围与目录配置见[服务器数据目录](deployment.md#服务器数据目录)。以下普通运行显式指定服务器产物目录：

```bash
npm run eval -- preflight --config configs/host.json --config configs/local/models.json
npm run eval -- run --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json \
  --output /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval
npm run eval -- status --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001
npm run eval -- report --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001
```

`preflight` 不调用模型，统一检查模型声明、密钥、Worker 构建、目录可写性、运行锁与日志位置。先应用 INI 环境再初始化日志。坏记录登记文件、行号、batch/case ID 与原因，其余记录继续；直接输入和命名评测集使用相同隔离语义。处理结束后 `outcome:complete` 表示全部成功，`outcome:partial` 表示有缺损。执行退出码为 0 全部成功、2 有输入拒绝/任务失败/资源暂停、130 中断。

## 当前限制

Eris 的结构化运行查询当前读取带 `overview.json` 的 Comparison 产物。独立 Attribution 与历史材料通过 `list_assets` / `read_asset` 读取正式 JSONL、报告和快照；不提供旧 Answer-review 的分阶段评分查询。具体引用与统计范围见 [Eris 数据工具](../agent/README.md#数据与只读工具)。

## 环境与配置

[config.example.ini](../config.example.ini) 是渠道与环境模板。每个 `[channel.<id>]` 提供独立地址、密钥和 API；相同模型在不同渠道中仍是不同选择。修改后重启，密钥不入库。

```ini
[channel.evaluation-gateway]
base_url = https://your-gateway.example/v1
api_key = your-gateway-key
api = openai-responses
```

评测入口只接受 `openai-responses`，不自动降级协议。URL 保留网关要求的路径；`models = model-a,model-b` 声明静态目录，适合没有 `/models` 的自部署服务。未声明时才发现远程目录；一个渠道发现失败不隐藏其他渠道，错误按渠道报告。重复或未知字段报错，支持整行注释和引号字符串，不支持行尾注释或变量插值。完整字段以模板和 [settings.ts](../apps/host/src/settings.ts) 为准。

`[environment]` 保存搜索、代理等服务端变量，覆盖同名进程变量。统一网络初始化合并 `NO_PROXY/no_proxy`，始终让 localhost、127.0.0.1、::1 直连；其他地址保留配置的代理规则。评测和服务器 Eris 均不读取本机 .env，Eris 独立配置见 [Agent 配置](../agent/README.md#模型与设置)。测试或独立部署可用 `EVAL_CONFIG_FILE` 指定 INI。

JSON 配置的 `models.<profile>.channel` 引用渠道。`--config` 可重复，按顺序深度合并；数组整体覆盖，相对路径按各自文件目录解析。共享配置在 [host.json](../configs/host.json)，本机模型填入 `configs/local/models.json`。

启动与 preflight 会在派发任务前逐个校验 `models.json` 的模型以及阶段绑定覆盖：模型必须存在于对应 channel 的 `models` 声明中。错误包含 channel、model 和可用 models；同一配置只产生一次启动/预检失败。多个渠道使用相同模型时，每个渠道都必须声明该模型。

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
| output.path / output.testPath / output.layout / output.business / problemLibrary | 正式交付根目录、独立测试根目录、交付布局、业务类别与每模型问题库；layout 默认 business，只有显式 run 才交付隔离运行目录；business 声明日常或流失，其分区目录固定为路径最后一级 |

默认值与字段全集直接查 [EvalConfig](../packages/workflows/src/comparison/types.ts)、[DEFAULT_POLICY](../packages/contracts/src/index.ts)、[loadConfig](../apps/host/src/config.ts)，不复制到文档。

归因中的私密规范裁剪容器只用于导航；证据从未改写的原文叶子读取。业务链路检查点覆盖已登记的完整边界，分页窗口不限制可引用的后文；调查事实、环节、责任主体与证据各用自身目录编号。用户问题与设备事实不自动成为专有规范，真实本方规范继续按其作用域检查。提交仅使用工具当前 Schema 的字段和枚举，修正不增加提交上限。

Attribution 按模型版本轮转、在物理文件内部按小批流式载入：`plan` 只读取配置，不扫描输入；每次最多读取 16 行且不超过 `execution.sessionWindow`，读到首批即规划和派发，不等待首个大文件或整个数据集读完。每个版本的绑定窗口独立推进，失败且已结算的会话保留恢复信息，但不阻塞后续输入；成功会话须完成导出后才释放。`state.json` 保存未完成输入的坐标与来源修订号，以及各文件的读取字节游标，正文按需读取。续跑从游标继续，不重读已释放的前缀；只有读到文件末尾且该文件所有输入均已交付，才将文件标为完成。未读完的来源不能因暂时没有可运行任务而 finished；文件在读取期间变化时明确报错。业务类别必须在 `output.business` 声明（`daily` 或 `lost`）；输入位于 `eval_input/<分区>/` 时，`output.path` 最后一级必须是同一分区（输入侧 `_input` 后缀不计，如 `0_daily_eval_input` 对应 `0_daily_eval`）；一个 run 对应一个业务根，日常与流失不得共用 `output.path`。

Attribution 的 `execution.sessionWindow` 默认 16，必须是正整数；执行、进度和续跑使用同一 effective 值。`execution.taskConcurrency` 是任务槽位硬上限且不再随模型并发放大。`execution.concurrency` 限制真实在途模型请求，`execution.modelRequestLimits` 可进一步声明各网关上限。`execution.workerSlots` 控制每个托管进程的槽位数，应用默认 4；Supervisor 按需求小批预热，每次最多并行启动两个进程，派发循环只领取就绪槽位。

共用配置把 Rewrite 的推理档位单独设为 `low`，保留润色，只处理已接受文本；其他阶段沿用各自配置。专项的后置覆盖也须保留该阶段设置，不能用全阶段 `high` 覆盖。降低推理档位不是语义保真证明，仍按改写验收流程对照原文抽查。

`run / reattribute / cluster --balance-channels` 显式声明评测渠道可互换：各阶段的模型、思考档位、协议和能力必须相同。每次模型请求在真正发出前选择有额度的渠道；在途流保持原路由，普通工具执行不占模型额度。鉴权或账户额度失效会隔离对应渠道，保留未完成任务；其他健康渠道继续。全部所需渠道不可用时明确暂停，修复配置或额度后同 run ID 续跑。

## 批次调度

在服务器准备外部批次配置，参考 [batch.example.json](../configs/batch.example.json)：

```bash
EVAL_CONFIG_FILE=/absolute/path/config.ini npm run eval -- batch --batch-config /absolute/path/batch.json
```

`runs` 显式声明稳定 `runId`、按顺序合并的 `configs` 与整数 `priority`，数字越小越优先；相对路径以批次文件所在目录解析。每路配置分别提供输入和正式输出目录，调度器不从目录名推导业务来源。`stateDirectory` 只用于批次实例锁，正式产物仍在各来源的配置输出目录。

`channels` 限制跨 run 的真实在途模型请求；`equivalentChannels` 显式声明可互换的网关集合。示例每网关 150、合计 300 个模型请求，`taskConcurrency:350` 是整批任务槽位上限。`workers` 统一配置共享池的槽位数、启动重试数和退避。单路的任务槽位与模型请求上限分别展示，不能把 350 当作模型并发。

优先级控制新请求的排队顺序，同优先级等权；任务槽位按实际在途任务和就绪需求分配，暂停、预检等待和收尾路不占空闲份额，不抢占在途任务。某路完成后直接重新分配额度，并复用共享池中的就绪 Worker。配置中的优先恢复路结束后，另外两路自动接力；单路中断保留原执行范围恢复，不要求当前输入选择能够重新生成任务。模型能否满载取决于就绪请求数，工具执行和提交等待分别观测。

批次重启沿用相同 run ID：已完成的成功或缺损运行不自动重评。一路运行级故障明确记录，其余独立路继续。Worker 容量耗尽时保留 pending 记录、隔离容量，批次每 30 秒进行一轮恢复；全部模型渠道不可用则停止并等待配置/额度修复。新输入、新任务或显式补评应通过对应运行配置和已有恢复命令声明。

## 超时与故障隔离

额度排队不计入模型执行期限，可以取消。`firstResponseTimeoutSeconds`、`streamIdleTimeoutSeconds`、`toolTimeoutSeconds` 分别限制首包、流式停顿与工具执行；省略时沿用 `idleTimeoutSeconds`。代码工具另受 `codeTimeoutSeconds` 约束。`submissionTimeoutSeconds` 限制提交确认等待，省略时由整体 `timeoutSeconds` 兜底，不套用模型空闲期限；`cleanupTimeoutSeconds` 默认 10 秒。

只有模型首包/流式停顿最多自动重试一次；整体 deadline 终止当前任务。Worker 重建、传输重试、超时重试和内容修复分别计数，续跑保留任务累计预算。提交重试先查持久收据，已接受结果优先于失败或超时观察。

Worker 启动和重建预算属于容量，耗尽后隔离容量而不把健康记录判失败；其余健康 Worker 继续。单槽位无法清理时回收所属进程，同进程未提交任务重新排队，持久收据保留。外部 Worker 不由 Host 杀进程，不可复用时隔离并报告。未分类 Host 执行异常向运行级报告，不能被任务级 catch 当作普通坏记录吞掉。

本地 WAL 无法可靠写入时立即停止新派发。周期 checkpoint 失败后每 30 秒重试，连续 5 分钟失败暂停新派发，保存成功自动解除；在途任务仍可可靠提交。outbox 保留积压 5 分钟/10 GB 的准入保护。失败快照不会压缩进度日志，故障通过统一 runtime.log、CLI 和实时进度明确报告。

## 目录约定

真实评测产物统一放在数据源的 `/mnt/fin_bench/eval_data/{source}/3_eval_output/` 下；不得写到 checkout 或 runtime 的其他目录。配置、运行状态与日志由外部 runtime 管理。生产目录与启动方式见[远程部署](deployment.md)。

| 位置 | 内容 |
|---|---|
| configs/local/ | 不入库的本机覆盖配置 |
| /mnt/fin_bench/eval_data/{source}/2_eval_input/ | 服务器评测输入，不复制到本地或每个 run |
| /mnt/fin_bench/eval_data/4_user_kyc_data/{source}/ | 当前任务需要的用户 KYC 数据 |
| data/input-catalog/ | 业务身份及字节位置索引，不存正文 |
| {source}/3_eval_output/0_daily_eval/<模型>/<模型>_attribution-YYYY-MM-DD.jsonl | 日常单模型归因 |
| {source}/3_eval_output/1_lost_user_eval/<模型>/<模型>_attribution-YYYY-MM-DD.jsonl | 流失样本归因 |
| <正式根>/criteria/criteria-YYYY-MM-DD.jsonl | 当天共享的共同标准 |
| <正式根>/comparison/<模型A>_vs_<模型B>/<模型A>_vs_<模型B>-YYYY-MM-DD.jsonl | 当天对局；comparison-review、comparison-verification 等对应产物采用相同的模型对/日期命名 |
| <正式根>/<模型>/<其他产物>/<模型>-YYYY-MM-DD.jsonl | 其他单模型正式产物 |
| <正式根>/.delivery/provenance/YYYY-MM-DD.jsonl | 正式行与原始业务回答、来源收据、评测器和判官的溯源索引，不保存正文 |
| <正式根>/.runs/<run ID>/ | 内部运行账本、恢复状态与来源结果，不作为默认交付入口 |
| {source}/3_eval_output/1_task_eval/<任务>/ | 专项正式评测 |
| 当前评测目录的 attribution/、clustering/ | 独立归因与聚类作业 |
| {source}/3_eval_output/test_eval/ | 所有小样本、试跑与稳定性验证 |
| data/problems/ | 每模型问题库 |
| log/ | 共用运行与评测日志 |
| .runtime/、.venv/、dist/ | 执行环境与构建产物 |
| .artifacts/ | 临时开发验证材料 |

输入文件布局由各来源的 `2_eval_input/` 决定，通过配置显式选择；不假定固定的模型或日期子目录。记录身份以 JSON 为准，不按文件名分批。原始输入、运行结果、缓存和本机配置不入库。`0_archive/` 与 `1_7z_data/` 不属于默认读取范围。

正式交付日期使用原始输入已确定的业务日期/批次日期。当前 AIME 日常、AIME 流失和问财均使用完整的 `batch_id: YYYY-MM-DD`，索引保留该值；缺失或不是有效日历日期时明确暂缓，不退回评测启动日期。AIME 日常可能出现 `batch_id=2026-10-26`、`request_time=2026-10-25T17:22:06.486Z`，两者不能通过截取时间互相替代。流失输入已经有日期型 batch_id，不另行转换 recalled_date；问财的无时区 request_time 也不重新解释。被评模型使用外部配置的 `version.id`，不以底层模型名称、目录名或判官模型分区。

启动评测时先核对当前正式根目录中的已接受结果、来源收据和原始输入。只有模型、业务样本、原始回答、trace 范围及适用材料一致，且完整成功的结果才复用；run ID 和 evaluatorVersion 不参与排除复用。同一回答多份完整成功结果以最新 `acceptedAt` 为准，交付文件只保留该份，原收据和来源仍可追溯。当前迭代允许旧评测器判词缺少后来新增的字段，复用时原样保留，不调用模型补字段或伪装成当前版本。部分完成继续补评；已有行但身份、完成状态或来源无法核实时列出原因并暂缓该样本，不自动当作未评重新执行。

相同日期/模型的并发运行共用分区准入锁，避免两个新 run 同时检查后重复评测；占用分区暂缓，其他独立分区继续。正式视图与溯源索引使用统一文件写入队列和发布锁，发布中断从原接受行恢复。一次写入中的多条结果按日期合并为一次索引与交付追加，共享文件系统的逐条 fsync 不再串行阻塞 Host；每条行仍先进入溯源索引再落盘。内部 `.runs/` 继续保存恢复账本与来源结果；除非用户明确要求 `output.layout: "run"`，不能把 `daily-production-*` 等目录当成交付入口。不同来源和日常/流失根目录由外部配置隔离，不扫描或猜测其他业务根。

已整理的历史结果通过 `output.receiptSources` 显式登记原运行账本目录，包括确有需要的输出归档内的具体 run；不把整个归档作为默认递归扫描根。存在 `organization.json` 时，读取其 `artifact/relative/source_lines` 核对原正式行与当前目标行。旧清单中的来源绝对路径可能因移动失效，使用登记的实际 run 根及相对结果坐标，不把整理时间当作评测接受时间。缺少映射或收据时保留原文件并暂缓相关样本，不通过覆盖或追加来猜测归属。

`output.reuseCompleted` 默认 true，显式 run 布局也不因换 run ID 自动重评。只有用户明确要求重新评测时才设为 false；隔离模拟测试使用该显式开关。复用只导入原接受判词与溯源，当前运行不把历史模型用量当作新调用。

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

索引只存业务标识、文件、行号、UTF-8 字节位置和具体诊断。选择时重新核对原始文件；少量无效行不会拒绝整个集，坏记录仍被排除并报告。修正或变更文件后重新 index，文件变化、索引损坏与坐标错位不能静默忽略。未传 dataset 时扫描配置来源。

续跑按 state.json 中的原来源恢复，再传 dataset 不切换来源。未完成记录缺失或无效时跳过并报告诊断，已接受结果保留。运行中修改源文件会拒绝受影响读取，保存进度后同 ID 续跑。

### 第三方模型

用 [third-party.example.json](../configs/third-party.example.json) 注册第三方及完整模型数组。最小输入为真实原问和完整最终答案：

```json
{"batch_id":"baseline-check","case_id":"q1","messages":[{"role":"user","content":"2+2等于多少？"},{"role":"assistant","content":"4"}]}
```

适配器与厂商无关，未采集的内部过程、耗时与 token 不补造。新增参赛模型用新 run ID。

```bash
npm run eval -- preflight --config configs/host.json --config configs/third-party.example.json
npm run eval -- run --run-id third-party-001 \
  --config configs/host.json --config configs/third-party.example.json --config configs/local/models.json
```

## 日志

| 文件 | 用途 |
|---|---|
| log/runtime.log | 命令、任务与 Worker 诊断；错误保留原因、堆栈和可用身份 |
| log/evaluation.log | 已接受收据的业务结果，按提交身份去重；改写不单独记录 |

日志为 UTF-8 单行 JSON，持续追加。正常重复事件一分钟内合并，错误逐条保留；密钥脱敏。续跑补记已接受结果，日志失败不撤销判决。日志不是恢复数据源，不按日期或 run 新建日志文件。

```bash
tail -f log/runtime.log
```

写入、锁与中断末行处理由 [logging.ts](../packages/data/src/logging.ts)维护。

## 运行与恢复

`--batch ID`、`--case ID` 可重复，批次取并集再与 case 取交集；`--limit-cases N` 按排序限制整个范围，保存在 run 中。`--output DIR` 可覆盖运行根目录，`--debug` 额外保存排查材料。

相同 run-id 保留原筛选、A/B 映射、UUID、成功收据和累计用量；代码、模型、预算、评测器变化不阻止续跑。未完成任务使用当前有效材料与配置，发现原范围内新增任务。新增日期、模型集合或重评成功结果使用新 ID。

试跑、补失败或定向改写会保存 executionScope。普通续跑只执行该清单，不发现输入或按开关重规划；`--discover-inputs` 才释放范围，且不扩大原 batch/case/limit 条件。`run --skip-failed` 在 Comparison 与独立 Attribution 中均保留既有 `failed / timed_out / blocked` 状态和尝试次数，只推进其余可完成任务；`--resume-stage STAGE` 可同时解除指定阶段的暂停，不会取消跳过策略。

| 预算/故障 | 恢复规则 |
|---|---|
| 内容提交 | 接受或明确内容校验拒绝计入额度；同任务跨 attempt 和续跑共享 `1 + (stageRepairAttempts[stage] ?? repairAttempts)` |
| 文件/JSON 加载错误 | 独立累计 fileErrors，新的加载失败达到三次上限时停止；续跑不清零，但已成功加载的内容仍可使用剩余内容修正预算 |
| 传输、流中断及可恢复提前结束 | 按 retries / retryDelaySeconds 有界重试 |
| 提交与材料核查交付失败 | 短暂网络错误及 408/429/502/503/504 重传同一请求，最多三次；提交另查询原收据。无法确认时保留草稿与原始原因并结束尝试，不要求模型改稿，不消耗内容修复预算；Host 已确认的收据和核查计数仍为准 |
| Host 程序或协议错误 | 保留草稿与原始原因，结束尝试并立即暂停受影响阶段；只有携带内容校验问题的 422 才进入模型修复 |
| 取消、总期限、耗尽预算 | 停止，不靠重启清零 |
| 未确认 Worker 最终账本 | 保存已知计数与原因，不推测用量 |
| 源材料修订 | 清除失效草稿与阅读状态，保留历史计数 |

文件提交任务会保存最近一次成功 `edit_json` 写入的草稿。超时或中断后，续跑从 `submission-rejected.json` 恢复；写草稿不计内容提交，也不代表通过校验，仍须正常提交。仅写草稿、尚无校验拒绝时，空闲超时或无提交结束仍按 retries / retryDelaySeconds 有界重试；写入不清除已有校验错误，也不重置累计预算。失败的写入不覆盖已保存草稿，盲核查通过后清除核查阶段草稿。

提高实际阶段上限只增加差额，不补发完整预算。标准复核开关关闭会撤下未接受复核，已接受结果保留。提交反馈见[数据契约](contract.md#提交方式与反馈)。

### 只补失败与同类故障熔断

停止该 run 的 Host，先预览，再准备固定补跑范围：

```bash
npm run eval -- retry-failed --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001
npm run eval -- retry-failed --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --task <task-uuid> --apply
npm run eval -- run --run-id pi-001 --config configs/host.json --config configs/local/models.json
```

task / result 可重复；成功任务不重评，必要未完成依赖进入清单。准备不重置内容和加载账本。

当前 `configs/host.json` 使用 `execution.failureGuard.enabled: false` 关闭阶段熔断，续跑时也清除既有阶段暂停；失败仍保留真实状态和结果校验，其他任务继续。显式设为 `true` 时，同阶段、不同任务的同类错误达到 failureGuard 阈值才暂停该阶段，其他健康阶段继续。提交或材料核查的 Host 程序、协议错误在启用熔断时首个失败即暂停；网络交付故障仍按阈值处理。启用熔断后修复原因可显式解除：

```bash
npm run eval -- run --run-id pi-001 --resume-stage rewrite \
  --config configs/host.json --config configs/local/models.json
```

resume-stage 可重复，保留固定范围。

### 小批验收再放量

真实模型测试使用 `run --test-eval`，输出进入服务器配置的 `output.testPath`，按当前目录约定设置为同来源的 `3_eval_output/test_eval/`；配置字段示例见 [test-eval.json](../configs/test-eval.json)。`--pilot-cases` 使用同一测试根目录，按日期、模型组选择对局并带上依赖，保留完整计划。续跑或释放剩余测试计划时保留 `--test-eval`。归因试跑与 validate-stability 也使用 `output.testPath`；未配置该字段或 --output 越界时明确报错，不猜目录名。

```bash
npm run eval -- run --run-id pilot-001 --pilot-cases 40 \
  --config configs/host.json --config configs/local/models.json
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/pilot-001 --selected --require-rewrite verdicts
npm run eval -- rewrite-review --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/pilot-001 --limit-cases 50
npm run eval -- run --test-eval --run-id pilot-001 --discover-inputs \
  --config configs/host.json --config configs/local/models.json
```

释放前按[改写放量验收](quality.md#改写放量验收)检查。运行中用 `concurrency --run PATH --value N` 调整上限，`progress --run PATH` 查看状态；降低并发让在途任务自然完成。以新增正式交付衡量产出，不用 Worker 数代替。`status` 明确标记 checkpoint 观察，并分别核实 owner 进程和匹配 run ID/PID 的存活 Host；`progress` 是实时观测。进度分别提供 `task_concurrency`、`model_request_allocation`（当前分配额）、真实请求 active/queued/limit、手动 run 限额和各网关额度、输入拒绝、内部 accepted/failed/partial 以及 `formal_result_count`，accepted 不等同于正式落盘行数。

Worker 启动或任务准备期间若有任务完成，Host 会重新排序可执行任务，让刚就绪的下游及时共享槽位，不等待旧的上游派发队列走完。

运行进度的总计与各阶段同时提供 `accepted / complete / partial`：已接受总数等于完整结果与部分结果之和。`partial` 表示结果仍有未完成依赖，缺口沿流水线传递；暂停留下的 `cancelled` 单列，不计作原始执行失败。

中断报告只呈现正式 session 归因和 comparison；组件、trace 收据保留在恢复状态中，不当作 comparison 导出。

问财优先执行所选范围的标准、归因与比较；主评测仍有待执行或在途任务时，后置指令遵循归因和改写不占用执行槽位。主评测收尾后完成独立指令遵循归因与全部改写，成功收据在同 run 续跑中保留。指令遵循归因的来源目录按消息字段和规范标题提供原文读取坐标，完整输入快照仍可按需读取。

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

产物为 `validation.json`、`validation.md`、`results/stability-results.jsonl` 和 Host 恢复状态。辅助 `model-behavior.jsonl` 只汇总基准归因。实验不更新来源判决，不进入业务胜率。解释方式与语义复核见[质量指南](quality.md#后置稳定性实验)。

`validation.json` 的 `execution.tasks` 保留全部原计划任务，包括未派发改写和整链各阶段，列出当前状态、累计尝试、当前原因、等待依赖与执行范围；`execution.paused_stages` 和 `stop_reason` 分别保留阶段熔断与预算/时间停止原因。未完成任务仍在原分母中，预算不足不冒记为内容失败。当前原因最多 500 字符，完整上下文在 `state.json`。这不是历史失败账本：成功恢复会清除当前失败上下文，历史失败按 `run_id`、`task_id`、`attempt_id` 查询仓库根目录 `log/runtime.log`，报告不复制草稿或证据库。

独立审阅结果写入实验根目录 `semantic-review.json` 数组：每项包含 `task_id`、`submission_id`、`reviewer: {kind: "agent" | "human", name}`、`result: "passed" | "failed"` 和 `rationale`。只绑定当前已接受的改写收据；重复、过期或未知引用会报错。未记录的改写保持未审，整链中的改写也进入覆盖分母。重建报告保留已记录的语义失败，不改写原判词。

按[归因执行边界](quality.md#归因执行边界)填写审阅：保真硬错误为 failed；仅有非决定性措辞缺陷可为 passed，并在 rationale 留下缺陷与不影响原意的依据。Comparison 的 needs_review 表示已停下等待来源或关键口径复核，单列在未裁决数量中，不等于执行失败，也不冒充胜负或平局。

停止实验 Host 后，用 `npm run eval -- report --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/stability-001` 重新生成实验报告，不调用模型。

### 独立核验与聚类

已接受正式对比的独立核验：

```bash
npm run eval -- verify-comparisons --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --result <comparison-id>
npm run eval -- verify-comparisons --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --result <comparison-id> --apply
npm run eval -- run --run-id pi-001 --config configs/host.json --config configs/local/models.json
```

省略 result 选择全部正式对比。默认预览，apply 保存核验范围；结果不替换主线判词。

执行前先核对[当前限制](#当前限制)中的 session 归因证据映射问题。

Comparison run 的归因结束后，可跨多个该类 run 创建独立聚类，聚类命令使用包含 clustering 和 problemLibrary 设置的对战配置：

```bash
npm run eval -- cluster --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --run-id problems-001
npm run eval -- cluster --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --run-id problems-001 \
  --config configs/host.json --config configs/local/models.json --apply
npm run eval -- cluster --run-id problems-001 --apply \
  --config configs/host.json --config configs/local/models.json
```

`--clustering-selection FILE` 读取冻结来源引用，不能与 `--run` 同传；不会扩展到后续接受的结果。

已冻结的成功归因可与源评测并行聚类。源 run 中无关任务更新不阻断读取；所选归因、收据或输入引用在读取期间变化仍会报错。

run 可重复；续跑只给作业 ID，查看进度省略 apply。来源状态及正式归因须可读，聚类不等待对比、改写或可选核验；失败归因跳过。新增日期或显式重聚类用新作业 ID。评测 run 内延期观察也可用 `recluster --run PATH --task ID` 或 --all 预览，apply 后同 run 续跑。

独立聚类全部任务完成后，在作业根目录生成 `cluster_tree.jsonl`，每行一个模型、实际组件/处理环节/功能、问题方向或具体问题节点；待观察问题单列，无问题回答仍列入模型节点的冻结来源范围。组件分桶直接继承归因，不能用业务问题名称或笼统模型能力标签替代真实节点。节点内问题计数按回答和 finding 去重，多责任问题可出现在不同责任分支，父计数按并集计算。`validate --run` 核对来源收据、全量任务覆盖及已落盘树与当前问题库的一致性；缺失、篡改或未完成不能通过。

### 从正式对比数据重新归因

reattribute 按明确来源的正式对比定位回答，重做共同标准、归因与改写，不执行 Comparison，也不改来源 run。

```bash
npm run eval -- reattribute --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 \
  --from-date YYYY-MM-DD --pilot-answers 30 --run-id attribution-pilot
npm run eval -- reattribute --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 \
  --from-date YYYY-MM-DD --pilot-answers 30 --run-id attribution-pilot \
  --config configs/host.json --config configs/local/models.json --config configs/test-eval.json --apply
npm run eval -- reattribute --run-id attribution-pilot --apply \
  --config configs/host.json --config configs/local/models.json --config configs/test-eval.json
```

默认预览，apply 执行。pilot-answers 和 pilot-per-model 自动写入同来源 test_eval/attribution；续跑加载相同测试输出覆盖配置。pilot-answers 选择回答数，冻结完整计划及当前范围；`--pilot-per-model N` 可在原计划内扩充每模型配额，不得缩小或超过可选数。`--discover-inputs` 释放完整计划，不能与扩充参数同用。

试跑校验用 `validate --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/attribution/attribution-pilot --selected`。定向语义复核通过公开 prepareAttributionTargetedReviews 入口准备；接受后补齐改写。后置聚类可读取已完成试跑范围。

```bash
node scripts/attribution-review.mjs --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/attribution/attribution-pilot \
  --clustering /mnt/fin_bench/eval_data/0_wencai/3_eval_output/test_eval/clustering/attribution-pilot-tree
```

审阅脚本生成 review.html 与每模型 JSONL；默认读取 data/problems，可用 --library / --samples 指定问题库和摘要。不修改正式结果、问题库或执行范围。

专题仅导出一个模型时，增加 `--model b_post_train_fast`；`--json PATH` 同时保存归因树 JSON。只导出所选模型的节点、待观察池、样本及模型 JSONL，其他模型不会生成文件。独立聚类的来源由作业冻结引用确定，可把 `--run` 指向单独的交付目录，将审阅产物与来源 run 分开保存。

同一问题库的原聚类与增量聚类可重复传入 `--clustering`，合并各作业冻结的归因来源及待观察原因，按当前问题库投影已归类样本。作业目录或来源输入重复时拒绝导出；来源收据与正文保持原样，不重新调用模型。

专题最终归因树须等源评测及完整输入安装结束；覆盖范围使用 `full-evaluation`，列出目标、已接受和最终排除的归因数量。原聚类与增量聚类的来源及成功收据分别保存在 `clustering.jobs`，全部作业须完成聚类和改写，合并后严格对应源评测的最新成功归因，不能把中途快照当成完整交付。

### 重新改写对比文案

停止该 run 的 Host，预览后加 apply，再同 ID 续跑：

```bash
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --scope items
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 \
  --scope items --mode refresh --result <comparison-id> --slot comparison.2.B.summary --apply
npm run eval -- rewrite-comparisons --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 --scope verdicts --apply
```

默认 missing 补缺；refresh 必须指定 task、result 或 --all。scope 为 items 或 verdicts，slot 可重复。应用保存固定清单，只更新选中槽位；应执行完当前清单再准备下一份。未完成同范围任务复用 UUID 与预算，已接受改写的刷新创建新 UUID。

## 运行产物

下表是内部运行账本的文件集合。默认 business 布局的正式交付入口见[目录约定](#目录约定)；显式 run 布局才直接交付这些运行目录。

| 文件 | 用途 |
|---|---|
| state.json | 周期性派生快照：任务状态、来源索引、收据引用、累计预算与未完成任务的完整恢复上下文 |
| progress.jsonl | 检查点之后的增量状态与收据；检查点成功落盘后压缩已覆盖事件，保留序号边界 |
| overview.json | 运行目录与预计算统计：正式战绩、比例和结果引用，不保存正文 |
| results/criteria.jsonl | 共同标准 |
| results/compact.jsonl | 会话过程摘要，作为归因必需输入 |
| results/attribution.jsonl | 单回答归因与证据 |
| results/comparison.jsonl | 已决的正式两两对比 |
| results/comparison-review.jsonl | 主线待核，不计对战结果 |
| results/comparison-verification.jsonl | 可选独立核验 |
| results/clustering.jsonl | 归类与来源引用 |
| 源结果的 rewritten / results/rewrite.jsonl | 改写文案；归因与独立聚类作业使用独立 rewrite.jsonl，其他改写附在源结果中 |
| report.md、task_summaries.md | 总览与逐题呈现，优先用已接受改写 |
| stats.json | 数量、覆盖、冲突、版本、用量及产物清单 |
| model-behavior.jsonl | 由当前有效归因派生的责任分类与 finding 来源，不提供底座排名 |

正式 JSONL 是判词的权威存储，state 不重复保存已接受正文。运行中的提交先在本地 SQLite WAL 热日志中原子确认，再由 outbox 投影到正式 JSONL 和 progress.jsonl；进程崩溃重放本地事件，整机故障允许最多 5 秒未投影进度。崩溃恢复可处理相同重复行与中断尾行，冲突或缺失正式结果明确报错，不自动重评。写入顺序见[生命周期](architecture.md#生命周期)。

恢复时，同序号的 progress 投影只允许为热日志 receipt 补充尚未存在的 `exported`；判词、审计、状态或已有结果引用不一致仍拒绝恢复。重放完成后才应用本次配置与评测器标记，已接受 receipt 保留原评测器标记，保证续跑策略记录与实际执行一致。

`state.json` 周期性分块原子写入，读取按流解析，避免整份快照超过运行时单字符串上限；字节数统计来自实际写入，不序列化整份原始 RunState。Attribution 任务只保存 input_id，共享一次 candidate 索引；已接受正文引用正式 JSONL。仅已接受任务压缩诊断；未完成任务完整保留 draft、inspection、evidence bank、review 和累计预算，热库丢失或进度日志压缩后仍可恢复。快照复用不可变已接受正文，只拷贝可变恢复状态，避免重复全量 clone。热日志和 outbox 路径由 `EVAL_HOT_STATE_ROOT` 控制，默认位于 `~/.cache/eval-agent-harness/hot`；生产应放在本机 SSD，不放在 Ceph。

Host 每次成功保存检查点后，原子替换 `progress.jsonl`，仅保留检查点之后的事件和一个序号边界。运行结束并保存成功后通常只剩边界；检查点写入失败时保留原事件。追加与压缩共用同一写入队列；读取遇到检查点切换会重新读取快照，不能跳过缺失增量。该文件不承担完整历史审计。

既有停止运行的目录可执行 `node scripts/compact-progress.mjs <run目录>`，使用已有检查点压缩历史进度，并输出压缩前后字节数。命令持有同一把 run 锁，会拒绝正在运行的 Host；不改原始输入、正式结果或检查点。

Worker 健康检查暂时失败时，Host 暂缓使用该槽位并重查，不终止仍存活的进程，也不增加任务尝试次数。托管槽位绑定具体子进程，确认进程退出或有界清理失败后由 Supervisor 回收对应进程，再重建其槽位，避免端口复用误认其他 Worker。

stats 的胜负按对局，标准一致性及核心完成按回答去重；未知、冲突与覆盖单列。Token 包含已记录失败与重试，未知终态不算零；缓存命中率为 cacheRead / (input + cacheRead + cacheWrite)。任务累计耗时与首次启动后的 wall_seconds 分开，后者包含停机间隔。

debug 才保存 _internal/：契约快照、attempt 参数与记录、事件日志、工具产物及诊断。已有 run 可开启 debug，但不补造历史材料。事件收集不完整时保留副本及错误，不重评成功任务。report --details 仅用于 debug 运行。

report 重建报告与统计，不调用模型；validate 检查结果、证据、覆盖及可选附件。计划未完成时整体 valid=false，不能用已有行合法代替全量完成。

```bash
npm run eval -- validate --run /mnt/fin_bench/eval_data/0_wencai/3_eval_output/0_daily_eval/.runs/pi-001 \
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

默认 Host 配置的各评测阶段均使用 `low` 思考强度。Comparison 的归因材料只传一份，各评分槽通过 Problem 零起始索引引用。Comparison 复用已接受的 Criteria 和归因，以最终回答核对共同要求；只对决定性冲突定向读原文，不重复执行归因。

高并发可用 `worker --slots 25` 在一个 Node 进程内启动 25 个独立 HTTP 槽位，复用已加载的 SDK。ready 消息的 `urls` 列出各槽位地址，向 Host 重复传入 `--worker URL`；Host 总并发上限保持不变。各槽位独立保存任务、会话、工具预算及取消状态，目录按 slot 隔离。非零 `--port` 使用连续端口，默认由系统分别分配。池进程退出影响该池的全部槽位，由调用方监督恢复；关闭池会收尾全部活动任务。

## 独立评测分析 Agent

在服务器使用 `bash agent/run.sh --config <eris.json>` 启动 Eris，配置、数据、会话和验证见 [Agent 说明](../agent/README.md)。
