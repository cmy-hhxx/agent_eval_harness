# 自动评测流水线

[返回首页](../README.md) · [远程接口](handoff.md) · [运行与恢复](usage.md#运行与恢复)

流水线按日期下载 `remoteModels` 指定的模型输入，调用 Host 完成共同标准、归因、对比和改写，再增量交付 Mongo 与统计日志。它不运行聚类。主线待核不上传；润色失败保留原文、错误和补写入口。

## 启动

先配置依赖、模型与 INI。在 `[environment]` 设置 AUTOMATIONS_MONGODB_URI；需要自定义 CA 时设置 AUTOMATIONS_MONGODB_TLS_CA_FILE。连接和密钥不写入 JSON 状态。

```bash
npm run automations -- check
bash automation.sh
```

check 只读，不下载、不调用模型、不上报。automation.sh 每次构建当前应用，启动流水线与只读看板，默认 127.0.0.1:4174；支持 --port、--config 和 --debug。端口占用直接退出，Ctrl+C 保存进度并停止；再次启动沿检查点恢复。

[automations.json](../configs/automations.json)维护日期范围、轮询、每日限额、路径和交付目标；hostConfigs 依次合并 Host 与本机模型配置，再加载[自动化预算](../configs/automations-host.json)。修改配置后重启，不热更新。直接 CLI 使用现有构建：

```bash
npm run automations -- status
npm run automations -- run --once
npm run automations -- run --dashboard --port 4174
```

once 处理一轮可执行日期，会调用模型；不等待本轮失败退避。status 的 ownerAlive 区分活进程与遗留状态。

### 默认优先评测 GPT 六路输入

[六模型 Host 配置](../configs/six-models.json)定义两个独立对比组：

- Fast：`a_fast`、`b_fast`、`6_luna`。
- Expert：`a_expert`、`b_expert`、`6.1sol`。

每题分别展开三场，共六场，不跨档比较。同题且标准一致时共用 Criteria；每份回答在同一判据下只归因一次。扩组后比较实际判据、标准和来源证据；一致则复用，变化则独立复核，已有正式收据保留。

六路使用独立数据源 `http://117.50.195.94:2256/gpt`：通过 `/gpt/dashboard-data` 声明六路就绪及行数，并提供 `/gpt/data/YYYY-MM-DD/<模型ID>.jsonl`。原四路继续使用服务根路径；远端监听与输出目录见 [服务说明](../server_dashboard_ths/README.md#gpt-六路)。`6.1sol` 的点号保留；文件名、remoteModels 与 Host id 须一致。`6_luna`、`6.1sol` 示例采用 adapter=a（OpenAI 消息格式）；如采集使用显式轮次格式，须把对应 adapter 改为 b。JSONL 的 version 若提供，须等于 Host 配置的 name。

默认 [automations.json](../configs/automations.json) 已指向 GPT 六路源，日期范围从 2026-10-16 开始，覆盖当前已就绪批次及后续日期。直接运行 `bash automation.sh` 即自动下载、评测、续跑与 Mongo 交付；无需手动下载或指定额外配置。默认只处理 GPT 六路源，不调度原四路积压。

GPT 六路设置 `publishStatisticsLog: false`：不生成、追加或上传统计交付日志，不续传历史待发日志，`publish-log / resolve-log` 也拒绝执行。Mongo、远端进度以及本地 `runtime.log / evaluation.log` 照常运行。该开关是必填布尔配置；需要统计交付的其他自动化显式设为 true。历史交付记录保留原样。

六个文件从 `/gpt/data/YYYY-MM-DD/<模型ID>.jsonl` 流式下载至 `data/sources/automations/remote-six-model-evaluation/YYYY-MM-DD/.incoming/`，核对字节数、JSONL 与行数，再复查远端目录；全部通过后提升到同日期目录。`6_luna.jsonl` 和 `6.1sol.jsonl` 保留原名。下载失败自动退避重试，不用手动搬运文件；重启会重新同步未完成下载。

状态保存在 `data/automations/remote-six-model-evaluation/state.json`，评测结果在 `data/runs/comparison/daily-six-YYYY-MM-DD/`，与原四路状态和来源隔离。当前批次的六路行数可以不同，按实际题目身份配对；缺回答的对局按预检规则跳过，其余可配对题目照常评测。remoteModels 以外的本地基线仍从 Host 配置的 sources 读取。

[六路配置示例](../configs/automations-six-models.example.json)供自定义部署复制使用；修改 sourceUrl、日期范围或路径后用 `--config` 指定。已有 daily run 支持显式扩组续跑，但保留旧结果；跨对局绝对判断冲突会阻断统计快照，不能当作无冲突的新基准。

Mongo 与本机进度覆盖全部六个模型对；统计日志仅在 publishStatisticsLog=true 时交付。六路向 `/gpt/evaluation-progress` 上报六组独立计数，键为模型 ID 按字典序排列后以 `__vs__` 连接；远端六路看板逐对显示。原四路 `/evaluation-progress` 仍只接收 `fast / expert`，不能将三对计数塞进原 A/B 计数。统计日志沿用冻结结构，仅增加模型及日期数组条目。

### 渠道

```ini
[automation]
channels = evaluation-gateway
```

渠道须存在且有密钥，阶段模型和参数仍由 Host 配置决定。完整任务按 traffic_weight 分配，普通重试保持渠道；明确额度耗尽才切换，不把普通429、超时或鉴权失败当作额度耗尽。切换保留提交账本。

channelConcurrency 限制指定渠道的并发，总并发仍由 Host 控制；等待槽位或退避不占执行槽位。当前自动化预算为 16 并发，evaluation-gateway 的渠道上限同为 16；本机 `[automation].channels = evaluation-gateway` 时所有自动化任务仅走该渠道。临时预算保留到下次明确调整，重启生效。耗尽记录在本进程内共享，重启后重查完整渠道池。省略 automation 渠道池则使用阶段原绑定。

## 历史接管与更新

fromDate / throughDate 约束发现、恢复、下载、评测与 Mongo；范围外数据保持原样，累计只读统计仍可包含历史。不要把配置中的当前日期范围抄成长期规则。

completedDates 可显式接管范围内已完成的 daily-日期 run：须有完整成功收据，且各模型输入条数与远端一致。条数不变时保留原阶段范围，不下载或补评；数量变化转普通下载和同 ID 续跑。

每日期一个 run。自动化可在原 run 补齐配置模型，保留已有任务与结果；不补旧结果后来新增的改写槽位。全量续跑释放固定修复范围，有限抽样的历史 run 明确拒绝接管为全日期覆盖。

全部 remoteModels 均 ready 才下载。数量变化优先同步；同量文件按 refreshMs 逐块复查，更早且完整完成的日期降低复查频率。未变化文件不替换，修正来源不撤销已接受判词。远端准备中等待下一轮，不当作网络错误。

远端无不可变快照身份，行数与字节校验不能证明各模型文件来自同一生成时刻；接口边界见[输入下载](handoff.md#输入下载)。

## 后置聚类

选择归因已结束的日期 run，按[聚类命令](usage.md#可选复核与后置聚类)创建独立作业。它不改来源 run、上传状态或自动化重试池，也不需要停止其他稳定日期的评测。

## 调度与状态

取数、评测、Mongo 和日志是四个独立通道；上传失败不消耗评测重试。评测或 Mongo 读取某日期时延后替换其源文件，全局日志读取时暂停所有源文件替换，其他通道继续。

下载写入 .incoming，完整校验后先保存 installing 再提升源文件。提升前失败保留上一份完整来源；提升中失败或崩溃，下次先完整同步该日。requestTimeoutMs 限制无数据进展时间，收到数据后重新计时。

dailyComparisonLimitPerTier 对每个同档模型对分别限制当日对战，不互借额度。两个三模型组展开六个模型对，配置 300 时最多 1,800 场，不是每档三对合计 300 场。已接受对战优先保留，再保留已选未完成任务，最后补新任务；重启、追加或重排不重置额度。超额输入仍完整下载，手动 Host 不受自动化限额影响。

| 状态位置 | 内容 |
|---|---|
| data/automations/<id>/state.json | 日期、通道、退避及交付回执，不存正文 |
| data/runs/comparison/<run-id>/state.json | Host 逐任务权威账本 |
| results/*.jsonl | 正式结果及内嵌改写 |

| 状态 | 处理 |
|---|---|
| waiting_inputs | 输入无效或未达额度且缺配对，等待来源变化 |
| retry | 临时传输、下载或可恢复执行错误，按持久化时间退避 |
| blocked | 持续校验错误、内容预算耗尽或仅剩待核，停止盲目重跑 |
| completed | 当前选定额度内主线完成，已安排润色结束或失败兜底 |

取消和依赖阻塞不计任务执行失败；failed / timed_out 才计失败。nextRetryAt 是 Host 已安排的时间，看板只读，不另行调度。归因、对比与改写任务数、输入数、正式场数分别统计。

启动先核对 Host 检查点，恢复中断任务；有剩余内容额度时传输故障自动续跑。连续无新增结果转冷却退避，次数与用量跨重启保留。已确认内容预算耗尽不能靠重启补满；修复持续校验问题后，停止流水线并执行：

```bash
npm run automations -- retry --date YYYY-MM-DD
```

输入内容修正可解除旧材料暂停，但仍使用剩余额度。润色失败或暂停不阻塞已接受正式对比，正在运行的润色须等结束；补润色使用独立命令。

## 日志与进度

沿用根 runtime.log、evaluation.log；统计交付另写 comparison-statistics-log.jsonl。错误保留原始原因并脱敏，无变化轮询不反复写日志。

监控按文件变化更新轻量投影，不存检查点正文。执行恢复与发布仍读权威文件。publishProgress 控制远端进度上报，协议见[远程接口](handoff.md#进度上报)；上报失败不阻断评测。

只读看板显示四通道、日期进度、完成量与交付回执；缓存率按 Token 汇总，Mongo 数量取最新成功回执或核验记录，不累加历次累计数。界面、分页与断连规则统一见[监控规则](../PRODUCT.md#问题库与监控)。

## 错误日志页面

/errors 逐条展示本流水线及登记 run 的 runtime.log 错误，按落盘顺序倒排。详情是原始脱敏 JSON，不分类、合并或补造缺失信息；条数不等于失败任务数。

读取使用轻量字节索引和按页详情，未完成末行等下轮，不改原日志。页面只读，交互规则见[监控规则](../PRODUCT.md#问题库与监控)。

## MongoDB 增量交付与每四小时日志

### 交付资格

以 [publishableComparisons](../packages/workflows/src/comparison/publication.ts) 为准：主线对比及依赖有成功收据，已安排润色不再运行或正常排队，即可交付。失败润色按原文兜底，保留已有成功槽位；校验按收据声明范围，不强加后来新增槽位。待核与独立核验不作为正式对战上传。

重复输入按日期、case、模型隔离，同身份全部排除；只暂缓受影响对局，不改源文件或正式结果。来源修正后重新扫描恢复交付。

### MongoDB

输入完成下载校验后开始同步，不等整日评测；输入或可交付结果变化时增量更新。业务键 upsert，已有相同内容不重写，失败按原身份续传。目标集合和批次参数见[配置](../configs/automations.json)与 [mongo-publication.ts](../packages/runtime/src/mongo-publication.ts)。

输入保留原消息与标签，comparison 保留正式判词和已接受改写。模型 ID 使用与 Host 相同的安全标识规则，保留 `6_luna`、`6.1sol` 原名；versionA/B 按稳定版本 ID 排序，Workflow 用源检查点映射盲测槽位，缺失或冲突拒绝交付，不按正文猜身份。本地收据不变。

刷新输入时保留库中后补标签，显式输入标签可更新。现有集合对 comparison 的校验例外由上传器处理，不修改集合配置、不删除或迁移历史记录。只读核验保存 verified 时间与数量，不虚构上传事件。

### 统计日志

仅在 `publishStatisticsLog: true` 时启用以下流程；默认 GPT 六路关闭。

[statistics-log.schema.json](../schemas/workflow/statistics-log.schema.json) 是冻结外部契约，落盘与恢复续传均严格校验。只更新值、标签与日期条目；字段、类型、层级的修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

按北京时间 00、04、08、12、16、20 点生成一条累计快照；停机跨多个周期只补当前一份。每条含完整累计与逐日数据，消费者读取最新一条，不能把各周期相加。

胜率按 wins / evaluated；单个模型对的 A.wins + B.wins + both_good + both_bad = evaluated。三模型时每份回答参与两场；对战数按模型对累计，准确率、耗时和 Token 按同题同模型去重。双方的 both_* 各表示参与次数，不能相加当场数。未知指标保留 null，分位数由原始数值重算，不平均逐日分位数。

日期优先用同题有效 request_time 的北京时间日期，全部缺失才用批次日期。分类和难度读取输入及 Mongo 后补标签；难度按最新入库记录选择，未分层不回退旧值。来源读取失败或分类冲突拒绝本轮快照，不静默生成空标签统计。

先追加本地日志，再 POST 配置目标。只有 HTTP 201、written=true 且有 requestId 才确认；同 traceId 不重复落盘。停止流水线后可立即执行：

```bash
npm run automations -- publish-log
```

未完成日志复用原 traceId 和内容，不重评。Mongo 与日志交付互不等待。

### 上传恢复

日志接口是追加接口，无法去重。POST 前保存 sending；超时、异常响应或退出后结果未知时标记 uncertain，停止自动重发。评测与 Mongo 继续。

停止流水线，在日志平台核实该 traceId 后执行对应命令：

```bash
npm run automations -- resolve-log --outcome written --request-id <已核实请求编号>
npm run automations -- resolve-log --outcome retry
```

written 用于确认已写入，retry 仅用于确认未写入；然后 run 恢复。不要在结果未知时选 retry。

## 模块

流水线状态机在 [Automations](../packages/automations/src/index.ts)，网络与 SDK 在 Runtime，文件在 Data，交付筛选与统计在 Workflow，配置与监控组装在应用 Host。完整入口见[模块地图](modules/README.md)。
