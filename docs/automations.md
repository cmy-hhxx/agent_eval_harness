# 自动评测流水线

[返回首页](../README.md) · [远程接口](handoff.md) · [运行与恢复](usage.md#运行与恢复)

流水线按日期下载四模型输入，调用 Host 完成共同标准、归因、对比和改写，再增量交付 Mongo 与统计日志。它不运行聚类。主线待核不上传；润色失败保留原文、错误和补写入口。

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

### 渠道

```ini
[automation]
channels = openai, evaluation-gateway
```

渠道须存在且有密钥，阶段模型和参数仍由 Host 配置决定。完整任务按 traffic_weight 分配，普通重试保持渠道；明确额度耗尽才切换，不把普通429、超时或鉴权失败当作额度耗尽。切换保留提交账本。

channelConcurrency 限制指定渠道的并发，总并发仍由 Host 控制；等待槽位或退避不占执行槽位。耗尽记录在本进程内共享，重启后重查完整渠道池。省略 automation 渠道池则使用阶段原绑定。

## 历史接管与更新

fromDate / throughDate 约束发现、恢复、下载、评测与 Mongo；范围外数据保持原样，累计只读统计仍可包含历史。不要把配置中的当前日期范围抄成长期规则。

completedDates 可显式接管范围内已完成的 daily-日期 run：须有完整成功收据，且各模型输入条数与远端一致。条数不变时保留原阶段范围，不下载或补评；数量变化转普通下载和同 ID 续跑。

每日期一个 run。自动化可在原 run 补齐四模型，保留已有任务与结果；不补旧结果后来新增的改写槽位。全量续跑释放固定修复范围，有限抽样的历史 run 明确拒绝接管为全日期覆盖。

四模型均 ready 才下载。数量变化优先同步；同量文件按 refreshMs 逐块复查，更早且完整完成的日期降低复查频率。未变化文件不替换，修正来源不撤销已接受判词。远端准备中等待下一轮，不当作网络错误。

远端无不可变快照身份，行数与字节校验不能证明四文件来自同一生成时刻；接口边界见[输入下载](handoff.md#输入下载)。

## 后置聚类

选择归因已结束的日期 run，按[聚类命令](usage.md#可选复核与后置聚类)创建独立作业。它不改来源 run、上传状态或自动化重试池，也不需要停止其他稳定日期的评测。

## 调度与状态

取数、评测、Mongo 和日志是四个独立通道；上传失败不消耗评测重试。评测或 Mongo 读取某日期时延后替换其源文件，全局日志读取时暂停所有源文件替换，其他通道继续。

下载写入 .incoming，完整校验后先保存 installing 再提升源文件。提升前失败保留上一份完整来源；提升中失败或崩溃，下次先完整同步该日。requestTimeoutMs 限制无数据进展时间，收到数据后重新计时。

dailyComparisonLimitPerTier 分别限制 Fast、Expert 当日对战，不互借额度。已接受对战优先保留，再保留已选未完成任务，最后补新任务；重启、追加或重排不重置额度。超额输入仍完整下载，手动 Host 不受自动化限额影响。

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

只读看板显示四通道、日期进度、完成量与交付回执；缓存率按 Token 汇总，Mongo 数量取最新成功回执或核验记录，不累加历次累计数。界面、分页与断连规则统一见[监控设计](../apps/host/.impeccable/DESIGN.md)。

## 错误日志页面

/errors 逐条展示本流水线及登记 run 的 runtime.log 错误，按落盘顺序倒排。详情是原始脱敏 JSON，不分类、合并或补造缺失信息；条数不等于失败任务数。

读取使用轻量字节索引和按页详情，未完成末行等下轮，不改原日志。页面只读，交互规则见[监控设计](../apps/host/.impeccable/DESIGN.md#错误页)。

## MongoDB 增量交付与每四小时日志

### 交付资格

以 [publishableComparisons](../packages/workflows/src/comparison/publication.ts) 为准：主线对比及依赖有成功收据，已安排润色不再运行或正常排队，即可交付。失败润色按原文兜底，保留已有成功槽位；校验按收据声明范围，不强加后来新增槽位。待核与独立核验不作为正式对战上传。

重复输入按日期、case、模型隔离，同身份全部排除；只暂缓受影响对局，不改源文件或正式结果。来源修正后重新扫描恢复交付。

### MongoDB

输入完成下载校验后开始同步，不等整日评测；输入或可交付结果变化时增量更新。业务键 upsert，已有相同内容不重写，失败按原身份续传。目标集合和批次参数见[配置](../configs/automations.json)与 [mongo-publication.ts](../packages/runtime/src/mongo-publication.ts)。

输入保留原消息与标签，comparison 保留正式判词和已接受改写。versionA/B 按稳定版本 ID 排序，Workflow 用源检查点映射盲测槽位，缺失或冲突拒绝交付，不按正文猜身份。本地收据不变。

刷新输入时保留库中后补标签，显式输入标签可更新。现有集合对 comparison 的校验例外由上传器处理，不修改集合配置、不删除或迁移历史记录。只读核验保存 verified 时间与数量，不虚构上传事件。

### 统计日志

[statistics-log.schema.json](../schemas/workflow/statistics-log.schema.json) 是冻结外部契约，落盘与恢复续传均严格校验。只更新值、标签与日期条目；字段、类型、层级的修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

按北京时间 00、04、08、12、16、20 点生成一条累计快照；停机跨多个周期只补当前一份。每条含完整累计与逐日数据，消费者读取最新一条，不能把各周期相加。

胜率按 wins / evaluated；同组 A.wins + B.wins + both_good + both_bad = evaluated。双方的 both_* 各表示参与次数，不能相加当场数。未知指标保留 null，分位数由原始数值重算，不平均逐日分位数。

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
