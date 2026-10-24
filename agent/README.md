# Eris

[返回首页](../README.md) · [产品规范](../PRODUCT.md#eris-评测助手) · [部署](../docs/deployment.md#eris-只读分析助手)

Eris 是部署在评测服务器的小团队只读分析助手。浏览器入口为 `http://117.50.195.94:3928`，映射服务器 `0.0.0.0:5004`。本机仅用于开发与模拟测试。

## 启动与配置

```bash
bash agent/run.sh --config /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/config/eris.json
```

[配置 Schema](../schemas/eris/server.schema.json)指定监听地址、外部来源、数据根目录、外置运行目录和模型 INI。端口占用或实例锁冲突直接失败，不终止其他进程，不自动打开浏览器。代码在独立 `eris-code` checkout，启动进程在 `eris` tmux 中前台运行。

## 模型与设置

INI 的 `[agent]` 必须指定渠道；模型使用本段或该渠道的显式默认值，不继承评测阶段绑定。模型选择器只展示配置渠道允许且实际可用的模型，已有会话选择不可用时明确报错。上下文和输出上限遵从渠道能力。

服务器使用现有 Responses 渠道的 `deepseek-v4.1-flash`，上下文 524288、输出上限 32768；默认推理等级 `high`，可选 `low / high / xhigh / max`。集群网关自动绕过继承的 HTTP 代理。密钥只留在服务器。

语言、字号、工作步骤、用量、排队/插话和常用模型按账号保存。上下文接近容量时先持久化压缩摘要；取消后不启动新的模型请求。下一问预测复用会话模型，无工具，每轮一次；失败不阻断主回复。

外部搜索使用服务器 INI `[environment].SEARCH_API_KEY`，不读取本机 `.env`。未配置或检索失败时报告错误。

## 用户与会话

管理员创建、停用和重置成员密码；不开放注册。普通用户只能修改自己的密码。账号入口在侧栏「账号」，管理员在该页面管理成员，不能浏览成员聊天。最后一位管理员不能停用。

账号使用持久化 UUID；聊天、分页、设置、图表和原材料展开均校验登录身份，URL 不授予权限。共享评测数据不按账号重复保存。

登录使用独立 HttpOnly、SameSite=Strict Cookie，绝对有效期 7 天，服务重启后仍有效。支持单设备退出、退出全部设备；改密、重置、停用撤销登录和现有连接，停用还取消正在执行的模型请求。当前 HTTP 入口缺少传输加密。

账号及登录保存于 `runtime/secrets/eris/accounts.json`，权限 600。初始管理员为 `cmy`，首次通过 `ERIS_ADMIN_PASSWORD` 初始化；不在代码或日志中保存明文。

### 会话与恢复

权威聊天记录为 `runtime/data/assistant/users/<用户UUID>/sessions/<聊天UUID>/events.jsonl`；`state.json` 只保存索引、进度和请求状态。新建服务器聊天，不导入旧记录。

请求 UUID 去重，刷新和断线只重建订阅，不重发轮次。服务重启保留聊天并将未完成轮次标记为中断。每个聊天由持锁执行者运行；其他进程经回环 HTTP/WS 认证转发，内部授权不进入 owner 文件或浏览器。

## 数据与只读工具

覆盖 wencai、AIME、ifind 的日常和专项结果，测试目录须显式 `includeTests:true`。运行目录只读元数据，正式正文按引用按需读取，不复制输入、不补写索引、不新增跨 run 结果缓存。

Comparison 使用既有 overview；AIME Answer-review 使用当前 checkpoint 的只读投影，没有 overview 属于正常布局。后者展示归因、Score 和进度，没有两两胜负，不能生成比较图。

引用必须保留 `collectionId + runId`；collectionId 是来源、类别、任务的业务坐标，不是任意文件路径。相同 runId 在不同来源下互不混用。AIME 证据沿 `taskId + sourceId` 定位，偏移单位为 Unicode 码点，包含已保存的外部核验来源。

保留读取回答、正式判词、证据、数据搜索、公开网页搜索/读取、图片、精确计算、统计图和比较图。工具不执行代码、不创建专业评测，也不修改原判词。工具参数与工作规则分别维护在 [Schema](../schemas/eris/tools.json) 和 [提示词](../packages/prompts/resources/eris/)。

图表引用程序读取的正式统计，未知不补零；比较图展示前核对原问、完整回答和已读证据。单独分析和图稿核对只生成聊天内容，不形成新的评测结果。

## 验证

基础检查见[开发指南](../docs/development.md#验证)。涉及上游和界面时运行：

```bash
npm run test:agent:upstream
npm run test:agent:browser
npm run test:agent:performance
```

本机测试使用模拟服务和临时合成数据；真实 DeepSeek 对话与评测材料验收只在服务器执行。浏览器测试使用 `CHROME_PATH`，默认本机 Google Chrome。

## 修改 Eris

提示词与工具文案在 [packages/prompts](../packages/prompts/README.md)，工具参数在 [Schema](../schemas/eris/tools.json)，工具注册在 [core/tools.ts](src/core/tools.ts)。

应用 Host 注入数据、模型和账户；Runtime 提供会话与认证传输，Data 维护账号和追加记录。跨包使用公开导出，修改后同步当前调用方、测试和文档，不维护旧引用格式。
