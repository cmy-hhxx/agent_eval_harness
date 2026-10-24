# 自动评测流水线

[返回首页](../README.md) · [部署](deployment.md) · [远程接口](handoff.md) · [运行与恢复](usage.md#运行与恢复)

工作台自动化服务由 `workbench.sh` 启动，默认等待手动运行。首页并列问财日常四路与 AIME 日常全量，独立控制、可同时运行。

问财使用持续比较流水线：自动清洗目录包、安装输入、执行标准／归因／比较／改写，正式结果独立增量交付 MongoDB。AIME 使用[两阶段增量入口](aime-incremental.md)，执行 Score 与 Attribution，只保存正式文件和页面结果。两者默认全量，统计日志生成与上报关闭，聚类另行手动启动。

## 来源清单

`configs/automations.manifest.json` 是生产来源清单。来源配置相对 `workbench.json` 的 `runtime.configDirectory` 解析。当前登记问财 `comparison` 与 AIME `answer-review`，两者分别组装自己的执行器与正式状态读取器。

增加来源只修改外部自动化配置并登记清单，然后重启工作台；`workbench.sh` 和调度实现不保存来源名称列表。显式 `--config` 只用于开发、测试或单来源 CLI；生产不传 `--config`。

日常评测在手动运行后自动清洗并持续评测；专项任务独立导入、核对后再按需执行。后训练专项在数据与任务区选择批次清洗，操作见[数据服务](../server_dashboard_ths/README.md)。来源范围、模型、推理档位、并发和交付开关以[专项来源配置](../configs/automations-post-training.json)及其 `hostConfigs` 为准，不登记到日常清单。单独启动时，将工作台的 `runtime.manifest` 指向 checkout 外仅登记该专项的清单；看板按独立任务显示进度，点击该来源「运行」后才执行。

Comparison 自动化来源必须显式配置 `publishMongo`。问财日常为 `true`；后训练专项为 `false`，输入校验和本地评测不依赖 MongoDB，结果与恢复状态仍正常落盘，监控显示“本地保存”。关闭时不执行输入上传、增量结果上传或日期交付，也不要求 MongoDB 凭据；预测替换任务必须启用该项。此开关与 `publishStatisticsLog` 独立，开启交付时仍严格报错，不因权限或连接失败自动切换为本地模式。AIME 使用独立执行器，只落盘正式结果，不走 MongoDB 交付。

工作台配置通过环境变量传入：

```text
EVAL_AUTOMATION_SCHEDULING_FILE
EVAL_STATISTICS_DELIVERY_FILE
EVAL_LOG_DIR
EVAL_LOG_LOCK_DIR
EVAL_CONFIG_FILE
```

自动化配置文件中的 `stateDirectory`、`sourceDirectory`、`publication.logFile` 和 Host 输出目录必须位于 checkout 外。来源检查点、日期范围、并发额度、续跑和交付语义由配置定义，修改后重启生效，不热更新。

## 启动与调度

```bash
npm run automations -- check
npm run automations -- run --once
npm run automations -- serve --port 4174
```

生产由工作台向 `serve` 传入清单与外部配置目录。`serve` 只读历史状态并提供看板；点击「运行」才启动选定来源，其他来源保持待运行。点击「停止」会中断当前流水线并等待 Host 保存进度，停止中禁止再次运行；已接受结果保留。服务启动、崩溃重启和页面刷新均不会隐式启动来源；已手动运行的来源可在页面关闭后继续，重开页面会读取其状态。空闲页面不持续轮询运行状态，运行或停止中每 5 秒更新，空闲时可点击「刷新」。`check` 只读，不下载、不调用模型、不交付。显式 CLI `run` 直接执行，`run --once` 执行每个来源的一轮可执行工作。看板按来源显示状态和并发；并发设置为 0 时只暂停该来源的新模型请求，使用中请求、工具、下载、校验、Mongo 和统计生成继续执行。

同一任务 ID、状态目录、输入目录或 run 前缀不能被多个来源共享；独立实验使用新的 `id`、`stateDirectory`、`sourceDirectory` 和 `runPrefix`。同一实验续跑沿用这些值。

## 数据链路

1. 数据服务检测登记任务的新包并等待稳定；运行中的问财来源自动清洗待处理包，AIME 使用专用增量清洗器。专项仍支持手动清洗。
2. 手动点击来源「运行」后，流水线轮询 `http://127.0.0.1:8081/data/wencai/dashboard-data`。
3. 对已就绪日期流式安装各模型 JSONL，校验 `Content-Length`、JSONL 和实际行数；安装不依赖 MongoDB。
4. 完整输入提升为可恢复快照；旧输入的评测与 Mongo 交付结束前不替换。
5. Host 执行标准、归因、对比和改写，接受结果与 UUID 写入 run 状态。
6. 交付队列固定一致的输入和已接受结果，先上传输入再上传比较；Mongo 失败不阻塞评测或新快照安装。
7. 同机 POST 进度到数据服务。
8. 仅显式启用统计日志的来源生成四小时快照；日常来源默认关闭。

输入、恢复和产物的本地路径语义见[使用指南](usage.md)。原始源输入只保留在 `/mnt/fin_bench/eval_data`，不在每个 run 复制正文。

## 续跑

同一 run ID 续跑读取现有 Host 状态，只执行未接受任务；代码、模型或参数变化不拒绝续跑。已接受结果、正式输入快照和交付回执保留，不重复成功评测。

输入文件按业务身份重新核对；行重排允许，身份或正文变化会明确报错。整日输入仅在全部模型校验成功后提升。中断下载、输入安装、Mongo 写入和统计生成都在下一次运行恢复当前事实，不建立旧格式兼容层。

## MongoDB

MongoDB 是正式结果交付目标。外部 `config.ini` 的 `[environment]` 提供：

```text
AUTOMATIONS_MONGODB_URI=mongodb://interactive-q1qu5v9oqj3n:5000
AUTOMATIONS_MONGODB_TLS_CA_FILE=<可选 CA 路径>
```

数据库与集合来自自动化配置：

```text
query_quality_new
agent_eval_bench_version_comparisons_new
```

凭据只存在 checkout 外的配置/环境，不写入 JSON 状态或日志。输入与比较结果均按业务 ID 和 MongoDB 回执增量处理；同一目标日期串行写入，不把其他任务的回执当作当前目标已交付。

## 四小时统计快照

`publishStatisticsLog: true` 的自动化为每个四小时窗口生成一条累计快照。手动运行来源后生成当前窗口快照，停机跨多个周期不补造中间历史；已生成当前窗口后重启不重复生成。

生成顺序：

1. 读取完整的已安装输入与已接受比较。
2. 生成累计记录，保留 `wins` 同级的 `both_good / both_bad`。
3. 使用冻结 Schema 严格校验，不转换、不补字段。
4. 原子追加到 `runtime/log/comparison-statistics-log.jsonl`。
5. 在 `runtime/state/automations/statistics-delivery.json` 登记 `pending`。

[statistics-log.schema.json](../schemas/workflow/statistics-log.schema.json) 是冻结外部契约。普通实现、看板、自动化和 relay 改动不得修改字段、类型或层级。

## 本地 relay

服务器不访问外部报表地址，也不保留服务器直传路径。看板显示每条记录的 `pending / sending / uploaded / uncertain`、traceId、最后错误和回执时间。

本地 relay：

```bash
export WORKBENCH_SERVER_URL=http://117.50.195.94:3309
export WORKBENCH_RELAY_TOKEN='<共享 token>'
export WORKBENCH_RELAY_STATE="$HOME/.agent-eval-workbench/report-relay.json"
npm run report:relay -- --once
```

relay 只保存待传记录、回执和错误状态，按服务器返回的 `logUrl` 上传。明确 4xx 拒绝保持 `pending`；网络中断、超时、5xx、重定向或无法解析的成功响应标记 `uncertain`。`uncertain` 不会自动重发，必须核实：

```bash
npm run report:relay -- --resolve <traceId> --outcome written --request-id <requestId>
npm run report:relay -- --resolve <traceId> --outcome retry
```

只有确认未写入时才选择 `retry`。

## 监控与错误

`/` 通过评测、结果、更多组织两条日常主线。评测页展示来源、日期、阶段、实际请求、并发及问财 Mongo 回执；结果页读取两种 workflow 的正式产物；低频任务、错误历史、问题库和显式统计交付收在更多。

错误进入根 `runtime.log`；正式接受记录进入 `evaluation.log`；统计交付记录进入 `comparison-statistics-log.jsonl`。不新增自动化私有日志、轮转或 daemon。

## 验证

```bash
npm run typecheck
npm test
npm run test:full
```

涉及 Worker/SDK 时追加 `npm run test:integration`；涉及安装、构建或依赖时追加 `node scripts/test-clean.mjs`。

## 预测类自动评测

`configs/automations-prediction.json` 读取既有 answers 文件，按原比较收据替换预测结果和统计，不重新配对。它保留为显式开发配置，当前生产清单不登记；启用时须使用独立任务 ID、状态目录、输入目录和 run 前缀，并关闭共享来源进度与统计上传。
