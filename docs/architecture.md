# 架构与扩展

[返回首页](../README.md) · 安装和操作见[使用指南](usage.md)。

## 模块

```mermaid
flowchart LR
  CLI --> Host
  Pack[公共任务包] --> Host
  Host <-->|HTTP / JSON + SSE| Pi[Pi Worker]
  Host <-->|HTTP / JSON + SSE| Prime[Prime Worker]
  Pi --> PiSDK[vendored Pi SDK]
  Prime --> PrimeSDK[vendored Prime SDK]
  Pi --> Tools[公共工具模块]
  Prime --> Tools
```

| 位置 | 职责 |
|---|---|
| `apps/host` | CLI、依赖、调度、收据、增量更新、恢复 |
| `packages/contracts` | 跨进程任务、工具、事件与收据类型 |
| `packages/worker` | HTTP/SSE、预算、会话生命周期与提交 |
| `packages/agent-pi`、`packages/agent-prime` | 各自 SDK Adapter |
| `packages/pairwise-eval` | 唯一评测规则、输入适配、schema、证据校验、报告 |
| `packages/tools` | 材料、检索、图片、计算、代码执行和产物 |
| `vendor/pi`、`vendor/prime-agent` | 可直接开发的固定源码和锁文件 |

## 生命周期

Host 是单一写入者。每个任务可有多个 attempt，只有当前有效 attempt 能提交。提交 ID 为 UUID，同次提交重发沿用原 ID；相同 ID 内容冲突时拒绝。`state.json` 原子保存完整计划、收据、草稿与错误，输入快照单独保存在 `inputs/`。状态落盘、正式结果追加并刷盘后才确认。提交、取消和替换 attempt 串行化，旧输入的过期提交不能覆盖新任务。结构与引用校验继续保留，不计算内容摘要。

`.run-lock` 排除第二个 Host。进程不存在时回收陈旧锁；初始化不完整或遗留 `.run-lock.reclaim` 时拒绝继续，确认原进程停止后再清理。锁不提供跨机高可用。

每个 Worker 同时运行一个 attempt，独立会话、配置目录、材料副本、代码目录和日志；会话与临时工作目录清理完成后才对外报告最终状态。默认 Host 只保留 `state.json` 中的收据、状态和用量，托管 Worker 使用系统临时目录并在结束时清除。开启 debug 后，参数、状态、用量、失败原因及未接受提交合并到 `_internal/` 的 `attempt.json`，事件单独压缩；记录与工具产物收齐后才释放 Worker 副本。失联先查收据，无收据才可重试。Host 管理的失效 Worker 会被替换，外部失效 Worker 需调用方重启后恢复。

## HTTP V1

路由使用 `/v1` 命名空间；Host 和 Worker 通过 `PROTOCOL_VERSION` 核对运行时协议，当前值为 3。

请求用任务、输入和产物 ID，不传 Host 本机路径。输入与任务按业务标识首次登记持久化 UUID，产物使用 UUID。输入更新直接比较对象，不计算哈希。模型配置仅含 `apiKeyEnv`，实际密钥从环境注入。首版只支持可信单机调用，未配置远程认证，不应直接暴露公网。

| 接口 | 行为 |
|---|---|
| Worker `GET /v1/health` | 协议、引擎版本与构建 UUID、工具、活动 attempt |
| Worker `POST /v1/attempts` | 校验能力并创建会话 |
| Worker `GET /v1/attempts/:id` | 查询状态 |
| Worker `POST /v1/attempts/:id/cancel` | 中断所属会话与进程 |
| Worker `GET /v1/attempts/:id/events?after=N` | SSE 续读，也支持 Last-Event-ID |
| Worker `GET /v1/attempts/:id/artifacts/:id` | 产物字节 |
| Worker `GET /v1/attempts/:id/record` | 已结束尝试的完整记录，包括最终用量、工具审计及未接受提交 |
| Worker `DELETE /v1/attempts/:id` | Host 归档后释放已结束 attempt 的副本 |
| Host `GET /v1/inputs/:id` | 原始快照 |
| Host `POST /v1/submissions` | 校验、原子提交 |
| Host `GET /v1/submissions/:id` | 确认已保存收据 |
| Host `POST /v1/tasks/:id/checkpoint` | 持久化最后草稿、结构化错误和修复计数 |
| Host `POST /v1/control/concurrency` | 使用本机运行锁 token 调整目标并发并唤醒调度器 |
| Host `GET /v1/progress` | 当前进度、失败分类、吞吐和 ETA 区间 |

事件包含 `seq/attemptId/time/type/data`，在单个 attempt 内连续编号。Host 检测缺口、去重并续读；模型结束事件不代表提交成功。流式更新仅记录增量，完整消息保存在 `message_end`；开始、回合结束和会话结束事件不重复保存消息正文。

## 任务包和底座路由

实现 `EvaluationPack`：`plan` 生成任务与依赖；`reconcile` 合并原批次输入并使受影响结果失效；`prepare` 返回契约和 prompt；`resolve` 展开证据和发现 ID；`validate` 执行业务校验；`readRun` / `writeRun` 负责状态与结果引用的读写；`createResultWriter` 创建每个 run 的结果写入器，在 Host 的串行保存队列中、状态落盘后恢复或追加结果；`report` 重建最终结果与展示；可用 `snapshots` 保存契约快照。Host 使用内存中的完整运行状态，任务包决定精简的磁盘结构。传给 `runEvaluation`，不修改 Adapter。

`AttemptSpec` 包含任务标识、引擎版本与构建 UUID、模型、输入引用、预算、截止时间和评测契约。Host 不依赖上游 SDK 类型；底座公共接口只覆盖创建、运行、事件、取消和释放。

```ts
await runEvaluation({
  ...options,
  engine: 'pi',
  engineForTask: task => task.stage === 'correctness' ? 'pi' : 'prime',
  workerUrls: ['http://127.0.0.1:4101', 'http://127.0.0.1:4102'],
});
```

同 run ID 沿用持久化任务 ID 及 A/B 分配，保留未受输入变化影响的收据，未完成任务按当前路由和参数继续。CLI 选择统一底座，Host 库支持混合池；实际并发始终受总配置限制。

## 新工具

```ts
const extraTool: ToolDefinition = {
  name: 'count_inputs',
  description: '统计当前任务的输入份数',
  inputSchema: {type:'object', properties:{}, additionalProperties:false},
  async execute(context, _arguments, signal) {
    signal.throwIfAborted();
    return {content:[{type:'text',text:String(context.inputs.size)}]};
  },
};
await startWorker(backend, workerDirectory, createRegistry([extraTool]));
```

将工具名加入任务包的 `toolNames`。两种 Adapter 自动转换为原生 SDK 工具，无须修改调度代码。首版按代码注册，未提前建设 MCP、HTTP 工具连接器或插件市场。

探索调用统一计数，参数错误也占预算；提交有独立修正预算。材料工具提供分页、定位和可直接提交的 evidence。代码返回摘要，完整 stdout/stderr、脚本和 `outputs` 声明的文件存为可分页读取的产物；代码执行不缓存。

代码进程不注入模型凭证。生命周期监护进程在 IPC 断开、取消或超时后回收所属进程组。工作目录不是安全沙箱，主动脱离进程组的代码不属于此清理保证。

## 底座源码开发

直接修改对应 vendor，在 `upstream.json` 的 `local_changes` 记录说明后重建。两套上游 npm 包同名，必须保持独立依赖树。根 workspace 不包含 vendor。

Pi Git 归档缺少发布生成的模型目录数据，因此单独保存同版本 `vendor/pi-model-data` 及发布包 integrity；构建先恢复数据，再执行上游 `build:offline`，运行禁用自动网络刷新。

构建记录位于 `.runtime/pi.json`、`.runtime/prime.json`，记录显式版本、上游提交和随机构建 UUID；启动及 doctor 检查版本、入口与运行能力，不扫描源码树或计算摘要。修改源码必须重建。更新上游属于显式升级，需要更新提交、锁文件、来源清单并重新验证，不在运行时自动升级。
