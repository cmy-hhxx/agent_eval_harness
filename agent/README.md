# 评测分析 Agent

在项目根目录启动：

```bash
bash agent/run.sh
```

脚本读取根目录 `.env`，检查依赖和两套 SDK 构建，构建独立 Web 应用，等服务监听成功后打开浏览器。对话运行时只使用 Pi。首次安装沿用项目的 Node/npm/uv/Python 工具链，见根目录 [README](../README.md)。

```bash
bash agent/run.sh --port 4181 --user alice --no-open
```

默认端口 `4180`、用户 `local`。入口 `/u/alice/` 或 `/?user=alice` 可指定用户；不同端口的本机副本共享 `data/assistant`。只监听 `127.0.0.1`。`userId` 是可信本机环境下的数据归属标志，不是登录或鉴权。按 Ctrl+C 停止服务。

`.env` 使用现有 `EVAL_BASE_URL`、`EVAL_API_KEY`，可设置 `AGENT_MODEL` 指定总 Agent 的网关模型、`AGENT_CONTEXT_WINDOW`（默认 131072）、`AGENT_MAX_TOKENS`（默认 8192）。未设置 `AGENT_MODEL` 时使用 `configs/local/models.json` 的 Attribution 模型配置。专业调用继续使用现有阶段模型绑定；不加载内置第三方模型目录。

点击左下角“常用模型”→“勾选常用模型”，服务端使用 `.env` 的网关地址和密钥读取 `/models`。勾选并保存后，在输入框右下角切换模型与推理等级；`/model` 也使用同一选择器。常用模型按用户保存，当前模型与推理等级写入会话追加记录，刷新、续聊和本机副本转发后保持一致。切换不打断正在执行的轮次，下次用户请求使用新选择。密钥不会发送给浏览器。

## 能力与数据

可查询已登记的本地评测运行，分页读消息、搜索、查看图片、定位证据、做十进制计算，独立调用 Attribution / Comparison，并保存有正式结果引用的 Markdown 总结。Comparison 缺少归因时返回 `missingAttributions`，由总 Agent 决定补调。看板和批量 Workflow 仍由原入口启动。

原始数据由 `AnalysisDataSource` 访问：业务 ID 先定位本地源文件，再读取正文。会话工具记录只保存原始消息的读取引用，恢复时重新读取；不会把原始输入文件复制进会话。

会话的权威记录为 `data/assistant/users/<user>/sessions/<id>/events.jsonl`；`state.json` 只存列表索引、进度和请求状态。Pi 使用内存 Session，并从追加记录重建消息与压缩边界。模型请求、工具执行前等待相关记录持久化。总结位于 Session 的 `artifacts/`，工具返回浏览器下载链接。专业任务位于 `operations/<operationId>/execution/`，通过现有 Host 校验和 JSONL 结果提交路径写入。

同一 Session 仅一个进程持锁，其他副本转发请求及原始 Deepseek 多路流；锁 token 与 PID 同时匹配，确认进程退出后才接管。已接收用户请求及专业任务使用 UUID 去重，冲突内容拒绝。崩溃中未完成的轮次标为中断；再次继续前，助手按 operationId 读取已接受结果。排队消息会恢复，已发送的请求不盲目重放。

日志仍写入根 `log/runtime.log`、`log/evaluation.log`。`--debug` 才保存专业 Worker 排查材料。

## 模块与上游

- `src/core`：工具和能力注册，只依赖公共接口。
- `src/server`：Session / Workspace 产品操作，将 HTTP 和 WebSocket 交给 Runtime。
- `src/client`：原组件装配；没有自定义 CSS。
- `packages/runtime`：Pi、会话执行者、Deepseek Connection/Gateway 接入。
- `packages/data`：追加记录、文件锁、数据与产物 IO。
- `apps/host`：配置、本地数据和专业 Agent 的具体组装。
- `packages/prompts/resources/assistant`：总 Agent 提示词和工具文案。
- `schemas/assistant`：分析工具输入约束。

界面固定浅色，直接使用 Deepseek 的布局、输入、消息、工具树、Markdown 和代码块源码。MiniMax 等网关的正文 `<think>` 包装在服务端转换为 reasoning 流，分片标签不会混入正文；原始会话仍保留用于 Pi 恢复的消息。思考和工具过程沿用上游折叠组件，业务结果使用上游 ToolDetails 卡片，统计沿用上游 Session / Token 投影。

Logo 图形源码与默认引用已移除，官方品牌插件不装配，侧栏显示“评测分析 Agent”。不提供主题切换、第三方模型市场、编程工具或工作目录管理。

来源基线和变更见 [upstream.json](../vendor/upstream.json)、[源码映射](../vendor/deepseek/sources.json)、[局部补丁](../vendor/deepseek/local.patch)及 [MIT 许可证](../vendor/deepseek/LICENSE)。普通构建完全使用本仓库源码；只有维护命令 `node scripts/vendor-deepseek.mjs <上游仓库>` 才读取外部仓库，并重新应用已登记补丁。

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

浏览器检查使用 `CHROME_PATH`，默认本机 Google Chrome；浏览器回归包含常用模型勾选、模型与推理等级切换、思考折叠、工具详情和刷新恢复。上游性能负载与预算保持原值，包括十万增量前缀重连、240 轮长历史、代码块、分页、Trajectory 和流式期间输入。

视觉检查先运行 `node scripts/build-agent-reference.mjs`，再执行 `AGENT_VISUAL_REFERENCE=1 npm run test:agent:browser`。参考构建反向应用 UI 局部补丁，使用原始上游组件和同一份会话内容；对侧栏、标题栏、消息、Markdown、代码块区域逐像素比较。输入文案、不可用的功能入口和品牌标识属于明确差异。截图与检查结果写入 `.artifacts/agent-browser/`。
