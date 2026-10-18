# Eris

[返回首页](../README.md) · [产品规范](../PRODUCT.md#eris-评测助手)

Eris 是本机 Web 评测分析助手，使用 Pi 对话，专业评测复用 Host。启动依赖项目 POSIX 工具链，不提供独立桌面安装。

```bash
bash agent/run.sh
bash agent/run.sh --port 4181 --user alice --no-open
```

默认 127.0.0.1:4180、用户 local。脚本会终止目标端口的旧监听进程，准备依赖和构建，再打开浏览器；--port 0 使用动态端口，--debug 显示构建诊断。Ctrl+C 停止。

入口 /u/alice/ 或 ?user=alice 指定用户。本机副本共享 data/assistant，userId 只表示数据归属，不是鉴权。

## 模型与设置

渠道格式见[配置指南](../docs/usage.md#环境与配置)。Eris 选择器只提供渠道中的 **GPT Luna** 系列；默认继承 Attribution 绑定，可用 INI 的 agent 段覆盖 channel、model、thinking、context_window 和 max_output_tokens，默认模型也须为 Luna。

渠道目录独立加载，故障只影响本渠道；全部不可用才阻断请求。重试重新加载，已有会话选择不被静默替换。常用模型只影响排序与新会话默认，不过滤其他可用 Luna 模型。

上下文容量统一取 agent 配置；每次模型请求前检查，超阈值先持久化压缩摘要再继续。模型切换不打断当前轮次，下次请求生效；取消后的准备工作不会再触发该轮模型调用。

语言、字号、工作步骤、用量、繁忙时排队/插话和常用模型按用户保存。排队消息可编辑、移除或转为插话。视觉与交互规则只维护在 [PRODUCT](../PRODUCT.md#eris-评测助手)。

外部搜索需 SEARCH_API_KEY。Eris 启动时 .env 仅补充未设置变量，INI 的 environment 随后覆盖；评测入口不读 .env。未配置或失败时报告错误，不伪装检索成功。

## 下一问补全

完成回答且输入为空时显示一句灰色短追问；Tab 填入草稿，Enter 发送，Esc 隐藏。切换会话、输入法组合或改写为其他内容不误采纳。

预测复用会话模型、无工具，每轮一次，失败不阻塞输入、不写入正式评测。语义与长度规则见[预测提示词](../packages/prompts/resources/eris/prediction.md)，执行限制见 [assistant-prediction.ts](../packages/runtime/src/assistant-prediction.ts)。

## 能力与数据

Eris 可读本地运行与正式判词、定位原始回答与证据、搜索、查看图片、复算、查公开网页，以及调用专业归因与对比。专业任务先固定 Criteria，同档两两比较，结果经 Host 校验保存；不因普通分析改写历史判词。

工具参数以 [schemas/eris/tools.json](../schemas/eris/tools.json) 为准，工作规则以 [Eris 提示词](../packages/prompts/resources/eris/) 为准。文档不另维护工具字段或调查顺序。

## 自主代码核验

execute_code 使用公共 Python / Shell 执行器，在会话工作目录复算与生成中间产物；取消回收所属进程组，环境不继承网关密钥。工作区不是操作系统沙箱。

输出截断时通过 read_code_output 续读，不为翻页重跑代码。正式结果默认返回保留完整结论、过滤证据的 summary；details 或分页参数读取原结果，nextRead 提供真实续读入口，读取不改落盘结果。

### 外部查证

search_data 搜本地输入，search_web 搜网页/新闻，read_web 读公开 HTML、PDF 和文本。搜索计划可并发，但来源与分页存在依赖时先取得真实引用。原文请求校验公共地址，页面不执行脚本；PDF 不做 OCR，表格须核对表头、单位和脚注。

精确数字与冲突须读原文。搜索日期只是过滤，不能证明历史可得性；页面声明时间、检索时间与事件时间分开。未命中不等于反证，截断或访问失败保持未知。外部事实与原始评测分开，不写回正式判决。

同轮独立只读工具有界并行，含专业调用的批次按序执行；每个结果先持久化再进入下轮。相同工具参数连续失败达到限制时停止调用并总结已知结果，不盲目扩展重试。

### 图表与来源

show_chart 的本地 statistics 引用由程序读取正式战绩，保留真实模型、日期、单位与来源；外部数据须说明来源和口径。未知不补零，区间来自真实上下界，不虚构显著性。

show_comparison 的原问、双方回答、身份和胜负绑定正式引用。展示前独立核对完整回答及会话已读证据，发现实质矛盾或材料不完整则返回草稿错误，不展示；核对不重评专业任务，也不复用旧核对结论。

图稿完整回答请求时 complete=true 可结束回复，否则继续。成功回执先落盘，刷新可恢复。统计图模板、视觉及辅助阅读见 [PRODUCT](../PRODUCT.md#eris-评测助手)，参数见工具 Schema。

### 本地运行与结果

| 入口 | 读取范围 |
|---|---|
| list_data | 轻量运行目录；指定 inputs / comparisons 后分页 |
| view:statistics | 最近成功发布的累计快照，运行中批次单列，不能相加 |
| read_case | 原问、回答与正式对战；review:true 用于不预载旧评语的复核 |
| read_data / read_specialist | 原结果 summary 或 details |
| read_evidence / search_data | 按原始引用读取、定位与续页 |

currentRun 优先有输入的活动运行，否则选最近开始的有输入运行；指定 run 后不自动换范围。查询与分页不改变 run 统计分母。原材料用 runId + inputId，正式结果用 runId + taskId，专业调用用 operationId，引用不能混用。

运行目录只读 overview.json；索引缺失、损坏或过期明确报告，不自动全量重扫。停止相关运行后可用 `node scripts/rebuild-run-overviews.mjs [运行根目录]` 重建，原状态和结果不变。

自主选例可用 sample=true，先随机候选再按完整原问语义筛选；不读旧输赢决定题目质量，不改总体统计。空候选只代表本次范围，筛选结果不作为总体质量样本。

本地搜索返回原文位置与续读边界；多词同节点命中不证明同句关系。截断、未知字段与原始引用保留。会话只保存原材料定位引用，恢复时按来源重读，不复制原始输入。

“链路小现场”展开才读对应原材料，不触发模型或专业重评；详情可复制业务引用追问。呈现规则见产品规范。

### 会话与恢复

权威记录为 `data/assistant/users/<user>/sessions/<id>/events.jsonl`；state.json 仅保存索引、进度和请求状态。Pi 内存会话由追加记录重建，模型与工具执行前先持久化相关请求。

同一 Session 单进程持锁，其他副本转发，确认 owner 退出后才接管。请求 UUID 去重，冲突内容拒绝。未开始的调用可重试；已开始而结果未落盘的调用保留未知，先核对副作用；已保存结果不重放。专业任务按原 operationId 恢复接受结果和剩余工作。

专业产物在 operations/<operationId>/execution/，日志仍使用根 runtime.log / evaluation.log；debug 才保存专业 Worker 排查材料。

## 模块与上游

Eris 的 core 定义能力，server 提供产品操作，client 装配界面；Runtime 负责 Pi 与 Deepseek 传输，Data 管追加记录，应用 Host 注入数据和专业网关。完整入口见[模块地图](../docs/modules/README.md)。

界面复用选定 Deepseek 源码，固定浅色，品牌见[素材说明](src/client/brand/README.md)。来源与变更由 [upstream.json](../vendor/upstream.json)、[sources.json](../vendor/deepseek/sources.json)和 [local.patch](../vendor/deepseek/local.patch)记录，保留 [MIT 许可](../vendor/deepseek/LICENSE)。同步与构建见[开发指南](../docs/development.md#构建与依赖)。

## 修改 Eris

| 修改 | 入口 |
|---|---|
| 目标、调查、恢复、预测与核对规则 | [resources/eris/](../packages/prompts/resources/eris/) |
| 工具参数 | [tools.json](../schemas/eris/tools.json) |
| 工具注册与执行 | [core/tools.ts](src/core/tools.ts) |
| 完整定义 | [core/profile.ts](src/core/profile.ts) 的 createEris |
| 品牌 | [brand.js](src/client/brand.js)、[素材](src/client/brand/README.md) |
| 网关与模型选择 | [assistant-models.ts](../apps/host/src/assistant-models.ts) |

同步当前调用方与测试，构建并重启后生效。不要在 Host 另拼提示词。

## 验证

基础检查见[开发指南](../docs/development.md#验证)，按变化追加：

| 范围 | 命令 |
|---|---|
| 上游组件与协议 | npm run test:agent:upstream |
| 浏览器与全部图形模板 | npm run test:agent:browser |
| 长历史与增量性能 | npm run test:agent:performance |
| 单独图表布局 | node agent/tests/chart-layout.mjs |

浏览器用 CHROME_PATH，默认本机 Google Chrome；布局检查多个桌面及手机宽度。视觉对照先运行 build-agent-reference.mjs，再以 AGENT_VISUAL_REFERENCE=1 运行浏览器测试，产物在 .artifacts/agent-browser/。它验证明确保留的上游区域，不把品牌与受限功能差异当错误。

### 外部搜索查证基准

```bash
npm run build:app
node scripts/search-audit.mjs --live --output .artifacts/search-audit
```

基准使用[固定查询](../tests/fixtures/search-audit.json)，消耗真实 Serper 额度，不纳入离线测试。Hit@k、字面锚点与耗时不等于开放互联网召回率或事实正确性；相关性、口径、历史可得性及 Eris 实际引用须人工复核。
