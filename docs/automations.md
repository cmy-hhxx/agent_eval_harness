# 自动评测流水线

[返回首页](../README.md) · [部署](deployment.md) · [远程接口](handoff.md) · [运行与恢复](usage.md#运行与恢复)

生产自动化只由 `workbench.sh` 启动。流水线按登记来源轮询同机数据服务，下载并校验输入快照，调用 Host 完成 Criteria、Attribution、Comparison 和 Rewrite，再增量交付 MongoDB 并生成统计快照。自动化不运行聚类。

## 来源清单

`configs/automations.manifest.json` 是生产来源清单。清单中的每个 `config` 相对 `workbench.json` 的 `runtime.configDirectory` 解析；当前只登记：

```json
{
  "sources": [
    { "name": "普通四路", "config": "automations.json" }
  ]
}
```

增加来源只修改外部自动化配置并登记清单，然后重启工作台；`workbench.sh` 和调度实现不保存来源名称列表。显式 `--config` 只用于开发、测试或单来源 CLI；生产不传 `--config`。

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
npm run automations -- run --dashboard --port 4174
```

生产由工作台向第二个命令传入清单与外部配置目录。`check` 只读，不下载、不调用模型、不交付。`run --once` 执行每个来源的一轮可执行工作。看板按来源显示状态和并发；并发设置为 0 时只暂停该来源的新模型请求，使用中请求、工具、下载、校验、Mongo 和统计生成继续执行。

同一任务 ID、状态目录、输入目录或 run 前缀不能被多个来源共享；独立实验使用新的 `id`、`stateDirectory`、`sourceDirectory` 和 `runPrefix`。同一实验续跑沿用这些值。

## 数据链路

1. 数据服务检测新包并稳定 30 秒，处理为 JSONL 和 ready 状态。
2. 自动化轮询 `http://127.0.0.1:8081/data/wencai/dashboard-data`。
3. 对已就绪日期流式下载各模型 JSONL，校验 `Content-Length`、JSONL 和实际行数。
4. 完整输入提升为可恢复快照；旧输入的评测与 Mongo 交付结束前不替换。
5. Host 执行标准、归因、对比和改写，接受结果与 UUID 写入 run 状态。
6. 比较改写成功的结果增量写入 MongoDB；Mongo 失败不阻塞其他日期。
7. 同机 POST 进度到数据服务。
8. 每四小时生成累计统计快照并进入 relay 待传队列。

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

`publishStatisticsLog: true` 的自动化为每个四小时窗口生成一条累计快照。启动后生成当前窗口快照，停机跨多个周期不补造中间历史；已生成当前窗口后重启不重复生成。

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

`/runtime/` 显示自动化状态、来源、日期、阶段任务、实际 LLM 调用、并发分配、Mongo 回执、统计 relay 状态和错误日志。`/runtime/runs/` 显示当前正式 run、样本与结果；问题库和当前数据与流程定义分别在 `/runtime/problems` 和 `/runtime/reference`。

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
