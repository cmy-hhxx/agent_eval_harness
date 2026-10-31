# Eris

[返回首页](../README.md) · [产品规范](../PRODUCT.md#eris-评测助手) · [部署](../docs/deployment.md#eris-只读分析助手)

Eris 是部署在评测服务器的小团队只读分析助手。浏览器入口为 `http://117.50.195.94:3928`，映射服务器 `0.0.0.0:5004`。本机仅用于开发与模拟测试。

## 启动与配置

```bash
bash agent/run.sh --config /mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime/config/eris.json
```

[配置 Schema](../schemas/eris/server.schema.json)指定监听地址、外部来源、产物清单文件 `collectionsFile`、外置运行目录和模型 INI，[配置示例](../configs/eris.example.json)提供完整字段。产物清单用 `id / path / test` 显式登记目录，见[清单示例](../configs/collections.example.json)；相对路径按各自配置文件解析。来源与物理目录可任意命名，不在代码中维护来源列表或拼接固定输出目录。端口占用或实例锁冲突直接失败，不终止其他进程，不自动打开浏览器。代码在系统盘 `/opt/eval_harness/eris-code` 独立 checkout，启动进程在 `eris` tmux 中前台运行。

## 模型与设置

INI 的 `[agent]` 必须指定渠道；模型使用本段或该渠道的显式默认值，不继承评测阶段绑定。模型选择器只展示配置渠道允许且实际可用的模型，已有会话选择不可用时明确报错。上下文和输出上限遵从渠道能力。

Eris 默认以 `system` 发送提示词，避免 Responses 端点将 `developer` 当作普通用户消息；渠道显式设置 `supports_developer_role` 时遵从该值。此默认值只在 Eris 组装时应用，不修改评测渠道配置。

服务器使用现有 Responses 渠道的 `deepseek-v4.1-flash`，上下文 524288、输出上限 32768；默认推理等级 `high`，可选 `low / high / xhigh / max`。集群网关自动绕过继承的 HTTP 代理。密钥只留在服务器。

语言、字体与独立字号、工作步骤及折叠时机、用量、排队/插话和常用模型按账号保存。上下文接近容量时先持久化压缩摘要；取消后不启动新的模型请求。下一问预测复用会话模型，无工具，每轮一次；默认 low 推理检查是否答过或重复，预算1024 token，会话关闭推理时也保持关闭。只读可见对话与图表的紧凑投影，保留双方摘要和最终结论，沿最新意图自主选择具体追问。Tab 补全而不发送，Esc 隐藏，输入与切换会中止过期预测；失败不阻断主回复。

外部搜索使用服务器 INI `[environment].SEARCH_API_KEY`，不读取本机 `.env`。未配置或检索失败时报告错误。

## 用户与会话

管理员创建、停用和重置成员密码；不开放注册。普通用户只能修改自己的密码。账号入口在侧栏「账号」，管理员在该页面管理成员，不能浏览成员聊天。最后一位管理员不能停用。

账号使用持久化 UUID；聊天、分页、设置、图表和原材料展开均校验登录身份，URL 不授予权限。共享评测数据不按账号重复保存。

登录使用独立 HttpOnly、SameSite=Strict Cookie，绝对有效期 7 天，服务重启后仍有效。支持单设备退出、退出全部设备；改密、重置、停用撤销登录和现有连接，停用还取消正在执行的模型请求。当前 HTTP 入口缺少传输加密。

账号及登录保存于 `runtime/secrets/eris/accounts.json`，权限 600。初始管理员为 `cmy`，首次通过 `ERIS_ADMIN_PASSWORD` 初始化；不在代码或日志中保存明文。

### 会话与恢复

权威聊天记录为 `runtime/data/assistant/users/<用户UUID>/sessions/<聊天UUID>/events.jsonl`；`state.json` 只保存索引、进度和请求状态。新建服务器聊天，不导入旧记录。

请求 UUID 去重，刷新和断线只重建订阅，不重发轮次。服务重启保留聊天并将未完成轮次标记为中断。每个聊天由持锁执行者运行；其他进程经回环 HTTP/WS 认证转发，内部授权不进入 owner 文件或浏览器。

连接状态以实际传输和订阅就绪为准。浏览器误报离线不会阻止首次连接或断开可用连接；真实断网按有上限的指数退避持续重试，上线事件仅加速尚未连接时的恢复。

## 数据与只读工具

按服务器产物清单读取已登记来源的日常和专项结果；清单中 `test:true` 的目录须显式 `includeTests:true` 才纳入列表，已返回的测试引用仍可直接读取。不会从 ID 或目录名判断是否为测试。运行目录只读元数据，正式正文按引用按需读取，不复制输入、不补写索引、不新增跨 run 结果缓存。

`list_assets` 直接发现公开产物，包括 `.archive` 内的报告、已存统计、各阶段正式结果，以及独立聚类与问题树；不要求存在活动运行，也不把归档状态恢复成运行。`read_asset` 沿目录引用按 Unicode 码点分页读取原始 JSON、JSONL、Markdown 或压缩 JSONL，不转换旧材料的结构。配置、状态、锁、软链接和 `_internal` 排查材料不进入此目录。资产引用为 `collectionId + assetId`，运行引用仍为 `collectionId + runId`；文件数不是样本量，快照之间不能直接相加。

Comparison 在保存运行时，将正式战绩、四类战绩比例、核心达标率、问题维度占比和运行完成率写入既有 `overview.json`，只存统计与引用，不复制正文。Eris 总览直接读取该投影，不重新扫描正式结果；比例为 0–100 的百分数，零分母为 null。正常保存窗口内有界重读一次，仍未就绪时返回可重试状态；停止后仍缺失或过期的概要用 `node scripts/rebuild-run-overviews.mjs <运行根目录>` 重建，读取工具不自动补写。统计查询按 run 返回已有统计，包含运行中与已结束运行并支持分页；不同 run 可能重叠，不能直接相加。

指定 `collectionId` 的统计只纳入该目录内运行。来源内的历史报告与统计通过公开资产引用读取，避免把其他来源的胜率带入。

`list_data`、案例及原始链路的结构化查询当前面向带 `overview.json` 的 Comparison 运行。独立 Attribution 的 `attribution.jsonl`、报告和历史快照通过 `list_assets` / `read_asset` 读取；不提供旧 Answer-review 的分阶段评分与来源分页接口。独立 Attribution 没有两两胜负，不能生成比较图；缺少 Comparison overview 不代表没有归因结果，也不应为此重建 Comparison 索引。

运行引用必须保留 `collectionId + runId`，资产引用必须保留 `collectionId + assetId`；collectionId 是来源、类别、任务的业务坐标，不是任意文件路径。相同 runId 在不同来源下互不混用。资产分页使用 Unicode 码点；Comparison 链路节点按工具返回的消息坐标、格式和偏移续读。

保留读取回答、正式判词、证据、数据搜索、公开网页搜索/读取、图片、精确计算、统计图和比较图。工具不执行代码、不创建专业评测，也不修改原判词。工具参数与工作规则分别维护在 [Schema](../schemas/eris/tools.json) 和 [提示词](../packages/prompts/resources/eris/)。

模型根据请求选择文字、表格或图表，先解释已有结果，按需补读；明确要求复核或材料存在关键矛盾时再查证。随机案例直接返回原问与评测摘要，选题由主模型完成。比较图由主模型填写解释，程序绑定正式身份与胜负；选题和作图不另发模型请求。统计图引用正式统计，未知不补零。聊天分析不形成新的评测结果。

图形覆盖横向柱状对比、趋势、组成、分布、矩阵、关系和单例比较。正式战绩和比例可直接指定统计指标，由程序填写数值与分母；普通资产图可引用 `list_assets` 的来源。默认回复首屏可读，用具体结论和关键依据表达，不固定模板或堆叠图形。

## 验证

基础检查见[开发指南](../docs/development.md#验证)。涉及上游和界面时运行：

```bash
npm run test:agent:upstream
npm run test:agent:browser
```

本机测试使用模拟服务和临时合成数据；真实 DeepSeek 对话与评测材料验收只在服务器执行。浏览器测试使用 `CHROME_PATH`，默认本机 Google Chrome。

## 修改 Eris

提示词与工具文案在 [packages/prompts](../packages/prompts/README.md)，工具参数在 [Schema](../schemas/eris/tools.json)，工具注册在 [core/tools.ts](src/core/tools.ts)。

应用 Host 注入数据、模型和账户；Runtime 提供会话与认证传输，Data 维护账号和追加记录。跨包使用公开导出，修改后同步当前调用方、测试和文档，不维护旧引用格式。
