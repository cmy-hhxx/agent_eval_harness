# Eris

在项目根目录启动：

```bash
bash agent/run.sh
```

脚本读取根目录 `.env`，检查依赖和两套 SDK 构建，构建独立 Web 应用，等服务监听成功后打开浏览器。正常启动仅显示准备状态和访问地址；准备失败会输出完整错误并退出，`--debug` 显示全部安装与构建诊断。对话运行时只使用 Pi。首次安装沿用项目的 Node/npm/uv/Python 工具链，见根目录 [README](../README.md)。

```bash
bash agent/run.sh --port 4181 --user alice --no-open
```

默认端口 `4180`、用户 `local`。入口 `/u/alice/` 或 `/?user=alice` 可指定用户；不同端口的本机副本共享 `data/assistant`。只监听 `127.0.0.1`。`userId` 是可信本机环境下的数据归属标志，不是登录或鉴权。按 Ctrl+C 停止服务。

`.env` 使用现有 `EVAL_BASE_URL`、`EVAL_API_KEY`，可设置 `AGENT_MODEL` 指定总 Agent 的网关模型、`AGENT_CONTEXT_WINDOW`（默认 131072）、`AGENT_MAX_TOKENS`（默认 8192）。设置 `AGENT_MODEL` 时总 Agent 使用默认 `high` 推理强度；未设置时使用 `configs/local/models.json` 的 Attribution 模型配置及其推理等级（未指定时默认 `high`）。专业调用继续使用现有阶段模型绑定；不加载内置第三方模型目录。

点击左下角“设置”→“常用模型”→“勾选常用模型”，服务端使用 `.env` 的网关地址和密钥读取 `/models`。勾选并保存后，在输入框右下角切换模型与推理等级；`/model` 也使用同一选择器。常用模型按用户保存，当前模型与推理等级写入会话追加记录，刷新、续聊和本机副本转发后保持一致。切换不打断正在执行的轮次，下次用户请求使用新选择。取消当前轮次或关闭服务时，即使模型目录或会话仍在准备，也不会在准备完成后发起该轮模型调用；中断消息仍保留，后续请求可继续。密钥不会发送给浏览器。

设置直接复用上游面板。通用设置包含语言、会话字号、工作步骤展示、性能与用量和繁忙时的发送行为（排队 / 插话），按用户保存，刷新和本机副本间保持同步。外观固定浅色；运行中的思考状态显示“正在分析”。

## 能力与数据

可查询已登记的本地评测运行，分页读消息、搜索、查看图片、定位证据、做十进制计算，独立调用 Attribution / Comparison，并保存有正式结果引用的 Markdown 总结。Comparison 缺少归因时返回 `missingAttributions`，由总 Agent 决定补调。看板和批量 Workflow 仍由原入口启动。

对话面向关心最终效果的业务负责人：先给结论，再说明关键证据与必要的下一步；中间进展说明已确认的事实、对目标的影响和接下来的动作。默认用日期、模型、问题主题与回答片段定位讨论对象，内部编号、工具名和评测器标识留在执行与追溯记录中，用户明确要求技术排查时才提供。目录为空只表示当前没有可查询的评测记录，不能推断当天未评测或原始数据不存在。

原始数据由 `AnalysisDataSource` 访问：业务 ID 先定位本地源文件，再读取正文。对原始消息的读取，会话工具记录只保存定位引用，恢复时重新读取；不会把原始输入文件复制进会话。展开读取、搜索或图片工具时，服务端根据当前用户、Session 和已记录的 callId 解析引用，使用只读工具返回材料；前端继续使用上游 ToolDetails、代码块、图片画廊和大图预览，原始消息详情可展开对应证据 ID 与引文。浏览器不能自填工具参数或执行专业任务；读取失败直接显示错误，重新展开可重试。

数据目录返回可直接使用的 `reference`：原始材料为 `runId + inputId`，正式结果为 `runId + taskId`；两者不能混用。本会话独立任务使用 `operationId`。目录、搜索与原始消息的分页结果标明单位、`hasMore` 和 `nextOffset`：消息目录默认 30 条，正文默认 8000 个 UTF-16 字符；无下一页时 `nextOffset` 为 `null`。正式结果整条返回、不分页；缺少时错误会指明其他读取入口。

会话的权威记录为 `data/assistant/users/<user>/sessions/<id>/events.jsonl`；`state.json` 只存列表索引、进度和请求状态。Pi 使用内存 Session，并从追加记录重建消息与压缩边界。模型请求、工具执行前等待相关记录持久化。总结位于 Session 的 `artifacts/`，工具返回浏览器下载链接；保存前逐项核验正式结果引用，引用及 `evaluatorVersion` 保存于该工具结果的元数据并随会话记录持久化，下载正文只保留用户可读的总结。工具步骤摘要呈现业务动作、状态与数量；调用参数不完整或校验失败时仍可呈现动作与状态，不中断页面。技术引用在主动展开详情时可核对。专业任务位于 `operations/<operationId>/execution/`，通过现有 Host 校验和 JSONL 结果提交路径写入。专业任务的过程预览每秒合并一次，仍沿用上游工具事件与序号，完成时写入完整过程；重复的同一预览不再追加。总 Agent 自身的 token 流不受此合并影响。工具的业务 JSON 只保存一份，元数据仅保留读取定位信息。

同一 Session 仅一个进程持锁，其他副本转发请求及原始 Deepseek 多路流；锁 token 与 PID 同时匹配，确认进程退出后才接管。已接收用户请求及专业任务使用 UUID 去重，冲突内容拒绝。崩溃中未完成的轮次标为中断；再次继续前，助手按 operationId 读取已接受结果。排队消息会恢复，已发送的请求不盲目重放。

日志仍写入根 `log/runtime.log`、`log/evaluation.log`。`--debug` 才保存专业 Worker 排查材料。

## 模块与上游

- `src/core`：`createEris` 统一装配提示词、Schema、工具和依赖，只依赖公共接口。
- `src/server`：Session / Workspace 产品操作，将 HTTP 和 WebSocket 交给 Runtime。
- `src/client`：原组件装配；没有自定义 CSS。
- `packages/runtime`：Pi、会话执行者、Deepseek Connection/Gateway 接入。
- `packages/data`：追加记录、文件锁、数据与产物 IO。
- `apps/host`：配置、本地数据和专业 Agent 的具体组装。
- `packages/prompts/resources/eris`：总 Agent 提示词和工具文案。
- `schemas/eris`：分析工具输入约束。

界面固定浅色，直接使用 Deepseek 的布局、输入、消息、工具树、Markdown 和代码块源码。MiniMax 等网关的正文 `<think>` 包装在服务端转换为 reasoning 流，分片标签不会混入正文；原始会话仍保留用于 Pi 恢复的消息。思考和工具过程沿用上游折叠组件，业务结果使用上游 ToolDetails 卡片，统计沿用上游 Session / Token 投影。

上游 Logo 图形源码与默认引用已移除，官方品牌插件不装配。原创 Eris 标记通过现有品牌插槽显示在侧栏与欢迎页，同一 SVG 用作浏览器图标；页面标题和品牌名称统一为 Eris。不提供主题切换、第三方模型市场、编程工具或工作目录管理。

来源基线和变更见 [upstream.json](../vendor/upstream.json)、[源码映射](../vendor/deepseek/sources.json)、[局部补丁](../vendor/deepseek/local.patch)及 [MIT 许可证](../vendor/deepseek/LICENSE)。普通构建完全使用本仓库源码；只有维护命令 `node scripts/vendor-deepseek.mjs <上游仓库>` 才读取外部仓库，并重新应用已登记补丁。

## 修改 Eris

| 修改内容 | 唯一入口 |
|---|---|
| 身份、工作规则、恢复指令 | [system.md](../packages/prompts/resources/eris/system.md)、[recovery.md](../packages/prompts/resources/eris/recovery.md) |
| 各工具的模型可见说明 | [resources/eris/tools/](../packages/prompts/resources/eris/tools/) 中的独立 Markdown 文件 |
| 工具参数 | [schemas/eris/tools.json](../schemas/eris/tools.json) |
| 工具注册、校验和执行 | [core/tools.ts](src/core/tools.ts) |
| 完整 Agent 定义 | [core/profile.ts](src/core/profile.ts) 导出的 `createEris` |
| 界面名称和标记 | [brand.js](src/client/brand.js)、[eris.svg](src/client/brand/eris.svg)；浏览器标题通过 [vite.config.mjs](vite.config.mjs) 的上游 `DSH_CLIENT_TITLE` 配置；欢迎语维护在上游 [local.patch](../vendor/deepseek/local.patch) |

新增工具时同步 Schema、工具说明、执行器与测试；Host 仅注入 `ErisDependencies`，不再单独拼装提示词。构建并重启 `bash agent/run.sh` 后生效。当前工具提供数据分析和专业评测；命令执行、数据整理与持续监控尚未接入。

## 验证

```bash
npm run typecheck
npm test
npm run test:integration
node scripts/test-clean.mjs
npm run test:agent:upstream
npm run test:agent:browser
npm run test:agent:performance
```

浏览器检查使用 `CHROME_PATH`，默认本机 Google Chrome；浏览器回归包含常用模型勾选、模型与推理等级切换、设置保存与语言切换、思考状态文案与折叠、工具详情和刷新恢复。上游性能负载与预算保持原值，包括十万增量前缀重连、240 轮长历史、代码块、分页、Trajectory 和流式期间输入。

视觉检查先运行 `node scripts/build-agent-reference.mjs`，再执行 `AGENT_VISUAL_REFERENCE=1 npm run test:agent:browser`。参考构建反向应用 UI 局部补丁，使用原始上游组件和同一份会话内容；对侧栏、标题栏、消息、Markdown、代码块区域逐像素比较。输入文案、不可用的功能入口和品牌标识属于明确差异。截图与检查结果写入 `.artifacts/agent-browser/`。
