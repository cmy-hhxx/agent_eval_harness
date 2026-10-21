# 自动评测流水线

[返回首页](../README.md) · [远程接口](handoff.md) · [运行与恢复](usage.md#运行与恢复)

流水线按日期下载 `remoteModels` 指定的模型输入，调用 Host 完成共同标准、归因、对比和改写，再增量交付 Mongo 与统计日志。它不运行聚类。主线待核不上传；启用比较改写时，该场改写成功后才交付。改写失败保留本地原文、错误和补写入口。

## 启动

先配置依赖、模型与 INI。在 `[environment]` 设置 AUTOMATIONS_MONGODB_URI；需要自定义 CA 时设置 AUTOMATIONS_MONGODB_TLS_CA_FILE。连接和密钥不写入 JSON 状态。

```bash
npm run automations -- check
bash automation.sh
```

check 只读，不下载、不调用模型、不上报。automation.sh 每次构建当前应用，默认启动日常四路与本次后训练专题；日常首次 LLM 配额为 2、统计日志上报开启，后训练首次配额为 32，统一看板使用 127.0.0.1:4174，顶部切换查看来源，并按来源分配 LLM 并发。支持 --port、--config 和 --debug；多个来源只占用 --port 指定的一个端口。端口占用则停止本次启动，Ctrl+C 保存各来源进度并一起停止；再次启动沿各自检查点恢复。

[automations.json](../configs/automations.json)维护日期范围、轮询、每日限额、路径和交付目标；hostConfigs 依次合并 Host 与本机模型配置，再加载[自动化预算](../configs/automations-host.json)。修改配置后重启，不热更新。直接 CLI 使用现有构建：

```bash
npm run automations -- status
npm run automations -- run --once
npm run automations -- run --dashboard --port 4174
```

once 处理一轮可执行日期，会调用模型；不等待本轮失败退避。status 的 ownerAlive 区分活进程与遗留状态。

默认 run / check / status 加载 [日常四路配置](../configs/automations.json) 与 [后训练配置](../configs/automations-post-training.json)。GPT 六路和预测来源不会自动启动；需要时通过 `--config` 显式选择各自配置，多个来源重复传入 `--config`。看板调整过的配额保存于 `data/automations/scheduling.json`，后续启动沿用；没有已保存配额时使用各来源的 Host 配额（日常 2、后训练 32）。各来源独立检查和交付；各自的 LLM 并发由看板分配，设置为 0 暂停该来源的新模型请求。已在调用的请求正常结束，工具执行、下载、校验、Mongo 与统计交付继续。配额只覆盖实际 SDK 模型响应流，流结束即释放；等待配额不计入任务和空闲超时。Mongo 写入共用一个独立通道，允许来源共用集合；普通任务按 evaluationTaskId 隔离，预测重评按原比较收据精确替换已有文档。

看板为每个来源提供 LLM 并发输入和应用按钮，查看来源与配额互不影响。配额保存到 `data/automations/scheduling.json` 的 `sources.<来源ID>.concurrency`；无保存记录的来源使用其 Host 配置并发。配置为 0 的来源不启动新评测日期，其他通道继续；运行中的日期在下一次模型请求处等待。全局调用表展示来源、日期、阶段、实际渠道、模型、任务及开始时间，LLM 请求数与运行任务数分别统计。本机同源 `POST /api/llm-concurrency` 接收 `{sourceId, concurrency}`，并发必须为非负整数；保存失败不改变配额，断连时禁用编辑。

四路 `a_fast / b_fast / a_expert / b_expert` 从 2026-10-13 起沿 `data/automations/remote-evaluation/` 检查点续跑，输入保存到 `data/sources/automations/remote-evaluation/`，run 前缀为 `daily-`，统计日志上报开启。显式 `--config FILE` 只处理指定来源，可重复传入多个配置；retry / publish-log / resolve-log 默认操作四路，操作 GPT 或后训练时须指定各自配置。

### 评测任务隔离

自动化配置的 `id` 是持久的评测任务 ID，不是数据源 URL、日期或模型名称。日常任务可持续追加日期；每次后训练或其他独立实验必须使用新的 `id`、`stateDirectory`、`sourceDirectory` 和 `runPrefix`。同一实验续跑沿用这些值。多个任务可以读取同一远端数据源、使用相同模型和日期，但不能共享本地检查点或 run；同批启动发现重复任务 ID、目录或 run 前缀会在执行前拒绝。

任务各自持有输入、正式结果、交付回执及统计。后训练任务 `publishStatisticsLog: false`，不进入日常统计上传；本机看板按任务切换，不合并总数。复用其他任务的远端入口开展独立实验时设置 `publishProgress: false`，避免覆盖该入口的进度；同批启动的多个任务向同一入口上报进度会被拒绝。配置 `throughDate` 可限定一次实验的日期范围。输入中的 `task` / `meta.task` 仍是题目分类，与评测任务 ID 无关。

### GPT 六路输入

[六模型 Host 配置](../configs/six-models.json)定义两个独立对比组：

- Fast：`a_fast`、`b_fast`、`6_luna`。
- Expert：`a_expert`、`b_expert`、`6.1sol`。

每题分别展开三场，共六场，不跨档比较。同题且标准一致时共用 Criteria；每份回答在同一判据下只归因一次。扩组后比较实际判据、标准和来源证据；一致则复用，变化则独立复核，已有正式收据保留。

六路使用独立数据源 `http://117.50.195.94:2256/gpt`：通过 `/gpt/dashboard-data` 声明六路就绪及行数，并提供 `/gpt/data/YYYY-MM-DD/<模型ID>.jsonl`。原四路继续使用服务根路径；远端监听与输出目录见 [服务说明](../server_dashboard_ths/README.md#gpt-六路)。`6.1sol` 的点号保留；文件名、remoteModels 与 Host id 须一致。`6_luna`、`6.1sol` 示例采用 adapter=a（OpenAI 消息格式）；如采集使用显式轮次格式，须把对应 adapter 改为 b。JSONL 的 version 若提供，须等于 Host 配置的 name。

[六路配置](../configs/automations-six-models.example.json) 指向 GPT 六路源，日期范围从 2026-10-16 开始，默认随四路一起检查新增数据。显式运行 `bash automation.sh --config configs/automations-six-models.example.json` 可只运行六路；无需手动下载。

GPT 六路设置 `publishStatisticsLog: false`：不生成、追加或上传统计交付日志，不续传历史待发日志，`publish-log / resolve-log` 也拒绝执行。Mongo、远端进度以及本地 `runtime.log / evaluation.log` 照常运行。该开关是必填布尔配置；需要统计交付的其他自动化显式设为 true。历史交付记录保留原样。

六个文件从 `/gpt/data/YYYY-MM-DD/<模型ID>.jsonl` 流式下载至 `data/sources/automations/remote-six-model-evaluation/YYYY-MM-DD/.incoming/`，核对响应字节数、JSONL 与实际行数；完整文件可包含目录发现后新增的行，少于发现行数则拒绝。全部通过后提升到同日期目录，并记录各文件实际行数。`6_luna.jsonl` 和 `6.1sol.jsonl` 保留原名。各来源共用下载恢复逻辑：临时断连、空闲超时及 HTTP 408 / 429 / 5xx 只重试失败文件，最多三次、间隔 1 和 2 秒，同轮已校验文件保留。超过次数或输入校验失败才交回整日退避，正式输入保持原样。错误记录具体文件、连接错误码与接收字节数。无需手动搬运文件；重启会重新同步未完成下载。

状态保存在 `data/automations/remote-six-model-evaluation/state.json`，评测结果在 `data/runs/comparison/daily-six-YYYY-MM-DD/`，与原四路状态和来源隔离。当前批次的六路行数可以不同，按实际题目身份配对；缺回答的对局按预检规则跳过，其余可配对题目照常评测。remoteModels 以外的本地基线仍从 Host 配置的 sources 读取。

[六路配置示例](../configs/automations-six-models.example.json)供自定义部署复制使用；修改 sourceUrl、日期范围或路径后用 `--config` 指定。已有 daily run 支持显式扩组续跑，但保留旧结果；跨对局绝对判断冲突会阻断统计快照，不能当作无冲突的新基准。

GPT 与四路共用 Mongo 集合 `agent_eval_bench_version_comparisons_new`，分别使用 `remote-six-model-evaluation` 和 `remote-evaluation` 作为 evaluationTaskId。Mongo 与本机进度覆盖全部六个模型对；统计日志仅在 publishStatisticsLog=true 时交付。六路向 `/gpt/evaluation-progress` 上报六组独立计数，键为模型 ID 按字典序排列后以 `__vs__` 连接；远端六路看板逐对显示。原四路 `/evaluation-progress` 仍只接收 `fast / expert`，不能将三对计数塞进原 A/B 计数。统计日志沿用冻结结构，仅增加模型及日期数组条目。

### 后训练三路输入

[后训练 Host 配置](../configs/post-training-models.json) 保留 `a_fast / b_fast / b_post_train_fast` 三路输入，当前专题只新增 A Fast/后训练、B Fast/后训练两组对比；A Fast/B Fast 的已接受结果保留，尚未开始的对比暂停。同一判据下每份回答只归因一次，各场分别随机持久化盲测位置。

每份输入完成字节数、JSONL 与身份校验后立即分批上传，不等其他模型文件或旧评测结束。已上传输入保持不变，新输入携带专题标签；每批最多 16 条或约 8 MiB，与结果共用按任务和日期隔离的写入队列，结果可在输入批次之间交付。下载继续并行，整组输入安装仍等待在途评测结束。文件上传成功回执与当前源文件读取标识一致时，后续结果交付跳过输入正文重传。

[后训练自动化配置](../configs/automations-post-training.json) 使用 `http://117.50.195.94:2256/post_training_model`，本次专题限定 2026-10-19 测试集日期，不按压缩包上传日期分批，也不自动纳入后续日期；服务端只监听 `/mnt/fin_bench/A_AA_comparision_data/post_training_model/*.7z`。文件命名和按测试集日期分日的规则见[后训练输入说明](../server_dashboard_ths/README.md#后训练模型评测)。三路均就绪才开始自动取数；无输入时等待，不影响其他来源。

默认 `bash automation.sh` 只运行日常四路；显式选择后训练时：

```bash
bash automation.sh --config configs/automations-post-training.json
```

后训练评测与独立聚类均使用 `evaluation-gateway`。本次后训练只继续 `b_fast / b_post_train_fast` 对比，不再执行 A Fast 参与的未完成评测和改写；历史成功收据、原始结果及未完成改写声明保留，避免把未完整改写的历史结果误判为可上传。后训练单次模型／工具空闲等待为 300 秒，总任务时限保持 900 秒。日常四路配额为 2，后训练为 32，预测和 GPT 六路为 0；显式启动其他来源后，可由看板调整其配额。后训练当前一组对比的规划不限场次，纳入当前全部可配对数据，保留已接受的历史对比。评测结束后仅对 B post_train_fast 尚未聚类的成功归因做增量聚类，复用既有问题库与结果，本地交付并上传 `agent_eval_bench_comparison_problems`；不重跑已完成聚类。当前专题的任务 ID、状态与来源目录为 `remote-post-training-evaluation`，run 前缀为 `daily-post-training-`；后续独立实验使用新的任务 ID 和路径。Mongo 沿用现有集合，按 evaluationTaskId 隔离；`publication.topic` 写入输入的 `trace.meta.evaluation_topic` 和输出的 `result.comparison.evaluation_topic`，本次为 `后训练三模型专题评测（2026-10-19）`。已上传输入补标签只更新元数据，不重传正文；新增输入与正式结果持续增量上传。统计交付日志关闭，本地运行日志及三个模型对的远端进度正常上报。已完成收据按原规则恢复，追加数据只补未完成工作。

### 预测类自动评测

[预测配置](../configs/automations-prediction.json) 从 `data/sources/automations/prediction-evaluation/answers.jsonl` 读取标答清单，原回答继续引用既有数据源。清单以 `batch_id + question_id` 标识题目；首次按原 case ID 或同日期唯一、完全一致的题文定位，在 `scope.json` 固化原 case 与已接受比较 ID。已登记题目不因原任务后来补评而扩大范围；新增清单题目单独登记。

`question_time` 是提问时刻；每个目标的 `start_date / end_date` 是预测窗口，`sources[].retrieved_at` 是资料检索日，均不冒充精确的“可解答时刻”。只有截止日期已经完整过去（北京时间）、`status=resolved` 且标答非空，才可入队。仅 `actual_outcome` 进入命中核验；事件实现不能验证事前概率，目标早于提问或同日但缺精确截止时刻时排除。多目标等待所有适用目标就绪，逐项核验。`exclusions.json` 保存原因和题目/目标坐标，不存回答正文。

预测使用独立 `prediction-日期` run 和检查点，保留原 run；只重评已登记的成功对局。标准仅提供给归因和对比，不向原回答注入事后信息。正式结果带 `evaluation_purpose: "prediction"` 及 `prediction` 来源和时间坐标，Mongo 内保存在 `result.comparison`，实际评测时间沿用 `evaluatedAt`，顶层契约不变。

上传只更新由原 `comparison_id` 唯一定位的既有结果，不写输入、不新建结果、不改原文档 ID 或任务身份。以双方 `trace_id` 绑定远端已有模型标识，保留其版本身份与 A/B 列。缺结果、缺配对输入、身份不符或目标不唯一均拒绝发布。重复上传幂等，发布中断后核对已写入结果再继续。

原记录必须符合当前 Mongo 契约。缺少 `evaluationTaskId` 或文档 ID 不符时，须先单独修复原记录；自动化在安装该日期的评测计划前只读检查目标，拒绝进入模型评测，不绕过数据库校验，也不自动迁移历史数据。

成功上传后，`published.json` 只保存新 run 与比较 ID 引用；同 run 的增量交付合并此前已确认的 ID，其他对局尚待改写不删除已有引用。原来源的 `predictionResults` 读取这些正式结果，用于后续上传和累计统计；上传未确认时仍沿用旧结果。累计统计按已确认发布的正式比较收据读取，后续新增文本改写不移除已发布判决；新上传仍须通过全部改写就绪校验，待复核结果不计入正式统计。普通重传不能回写已标记的预测结果。预测来源不单独上传统计日志或远端取数进度；原来源发送更新后的累计快照，保持冻结统计日志结构，已交付历史日志不改写。

预测归因本地交付按四个模型分别导出；只接受冻结范围内有成功收据的完整归因，等待相关 run 停止写入后校验重复、缺行和模型身份。比较处于 `needs_review` 不阻挡已完成归因的交付，在归因交付清单中单列待复核对局；这些对局继续保留原结果，不冒充正式判决覆盖 Mongo，其余已裁决结果照常交付。

只检查或运行预测来源：

```bash
npm run automations -- check --config configs/automations-prediction.json
bash automation.sh --config configs/automations-prediction.json
```

### 渠道

```ini
[automation]
channels = evaluation-gateway
```

渠道须存在且有密钥，阶段模型和参数仍由 Host 配置决定。完整任务按 traffic_weight 分配，普通重试保持渠道；明确额度耗尽才切换，不把普通429、超时或鉴权失败当作额度耗尽。切换保留提交账本。

channelConcurrency 限制指定渠道的并发，总并发仍由 Host 控制；等待槽位或退避不占执行槽位。当前自动化初始预算为 2 并发，本机暂时只启用 evaluation-gateway，避开 openai 的持续过载。配置保留 openai 渠道上限 1，重新加入渠道池时生效。渠道池在每个日期开始评测时重新读取；正在执行的日期需要重启后才应用修改，已保存的结果正常续跑。耗尽记录在本进程内共享，重启后重查完整渠道池。省略 automation 渠道池则使用阶段原绑定。

## 历史接管与更新

fromDate / throughDate 约束发现、恢复、下载、评测与 Mongo；范围外数据保持原样，累计只读统计仍可包含历史。不要把配置中的当前日期范围抄成长期规则。

completedDates 可显式接管范围内已完成的 daily-日期 run：须有完整成功收据，且各模型输入条数与远端一致。条数不变时保留原阶段范围，不下载或补评；数量变化转普通下载和同 ID 续跑。

每日期一个 run，多个日期共享来源的 LLM 配额并行推进；每个来源同时推进的日期数不超过其配额，Host 按活动日期数分配任务并发，所有实际模型请求仍共用来源的许可池。到期重试优先补位，不等待其他日期结束；降低配额不取消在途任务。自动化可在原 run 补齐配置模型，保留已有任务与结果；不补旧结果后来新增的改写槽位。全量续跑释放固定修复范围，有限抽样的历史 run 明确拒绝接管为全日期覆盖。

全部 remoteModels 均 ready 才下载。数量变化优先同步；同量文件按 refreshMs 逐块复查，更早且完整完成的日期降低复查频率。后训练专题的 refreshMs 为 null：已收齐且数量未变时不再重复下载，保留已安装输入继续评测；输入缺失或数量变化仍正常同步。日常来源保持定期复查。未变化文件不替换，修正来源不撤销已接受判词。远端准备中等待下一轮，不当作网络错误。

远端无不可变快照身份，行数与字节校验不能证明各模型文件来自同一生成时刻；接口边界见[输入下载](handoff.md#输入下载)。

## 后置聚类

选择归因已结束的日期 run，按[聚类命令](usage.md#可选复核与后置聚类)创建独立作业。它不改来源 run、上传状态或自动化重试池，也不需要停止其他稳定日期的评测。

## 调度与状态

取数、评测、Mongo 和日志是四个独立通道；上传失败不消耗评测重试。评测或 Mongo 读取某日期时延后替换其源文件，全局日志读取时暂停所有源文件替换，其他通道继续。

下载可与当前评测并行，写入 .incoming；目录继续增长不丢弃已校验文件。当前日期的评测和 Mongo 交付自然结束后，取得 run 锁，先保存 installing 再提升源文件；同 run 续跑保留已接受结果。提升前失败保留上一份完整来源；提升中失败或崩溃，下次先完整同步该日。requestTimeoutMs 限制无数据进展时间，收到数据后重新计时。

dailyComparisonLimitPerTier 对每个同档模型对分别限制当日对战，不互借额度；显式设为 null 表示不限场次。两个三模型组展开六个模型对，配置 300 时最多 1,800 场，不是每档三对合计 300 场。已接受对战优先保留，再保留已选未完成任务，最后补新任务；重启、追加或重排不重置额度。取消限额会补入全部可配对任务，保留原任务身份和成功收据。超额输入仍完整下载，手动 Host 不受自动化限额影响。

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

统一看板显示各来源状态和日期数量，点击来源切换日期、四通道、完成量与交付回执；页面标明数据源地址，浏览器标题显示来源名称。URL 的 source 参数保留当前来源，错误日志及返回监控也沿用该来源；未知来源明确报错。每个来源的日期按倒序、每页 10 条；轮询保留筛选、分页及错误详情的展开、滚动位置，切换来源重新加载该来源。长错误默认收起；待复核对比显示数量，展开后逐行显示完整任务 ID。GPT 和后训练的统计日志显示“已关闭”。缓存率按 Token 汇总，Mongo 数量取最新成功回执或核验记录，不累加历次累计数。并发显示当前来源实际 LLM 请求数与已分配配额，运行任务数单独显示；全局调用表可同时查看所有来源。界面规则见[监控规则](../PRODUCT.md#问题库与监控)。

## 错误日志页面

/errors 逐条展示本流水线及登记 run 的 runtime.log 错误，按落盘顺序倒排。详情是原始脱敏 JSON，不分类、合并或补造缺失信息；条数不等于失败任务数。

读取使用轻量字节索引和按页详情，未完成末行等下轮，不改原日志。页面只读，交互规则见[监控规则](../PRODUCT.md#问题库与监控)。

## MongoDB 增量交付与每四小时日志

### 交付资格

以 [publishableComparisons](../packages/workflows/src/comparison/publication.ts) 为准：主线对比及依赖有成功收据，且该场比较的改写全部成功后即可交付。失败改写不能作为完整结果上传；校验按收据声明范围，保留已有成功槽位，不强加后来新增槽位。归因与聚类文案的改写不阻塞该场比较交付。待核与独立核验不作为正式对战上传。

重复输入按日期、case、模型隔离，同身份全部排除；只暂缓受影响对局，不改源文件或正式结果。来源修正后重新扫描恢复交付。

### MongoDB

输入完成下载校验后开始同步，不等整日评测；输入或可交付结果变化时增量更新。业务键 upsert，已有相同内容不重写，失败按原身份续传。目标集合和批次参数见[配置](../configs/automations.json)与 [mongo-publication.ts](../packages/runtime/src/mongo-publication.ts)。

不同目标任务或日期的 Mongo 交付独立推进，每个来源最多同时处理两个日期；普通评测与预测覆盖写入同一目标任务、同一日期时串行，避免相互覆盖。下载下一份快照期间，已安装快照的正式结果仍可增量上传；新快照安装须等评测和上传释放旧输入，待复核结果不上传。

完整输入文件先校验全部行和重复身份，再按小批次与 Mongo 中的实际内容比较，只更新发生变化的字段。同模型、同业务题号不代表正文或元数据未变；回答修正、补充标签和专题标签变更均参与比较，批次之间允许输出交付。只有整份文件完成内容同步后才保存其交付回执。

已有完整快照的日期可在后台下载期间续跑到期重试；首次下载和安装中的日期仍等待输入就绪。成功任务沿用原收据，不重复评测。

每次交付只全量扫描一次输入来检查身份及重复行，独立结果交付也遵守当前快照的重复输入隔离；Mongo 已有配对输入不能绕过这项检查。后续校验与上传按本次固定的字节坐标读取；任何输入文件变化都会使本次交付失败并重试。坐标只在本次交付内存中保存，不复制输入正文。

上传器只写配置指定的现有集合，不创建集合。日常、GPT 六路和后训练任务共用 `agent_eval_bench_version_comparisons_new`。Mongo 文档记录 evaluationTaskId，题目 UUID 只在同任务、同日期内按原始 case_id 复用，文档 ID 同时包含任务 ID。读写与标签查询都限定任务，不接管未标注任务的历史文档。

目标集合须启用 [Mongo 校验规则](../schemas/workflow/mongo-publication.validator.json)，`validationLevel: strict`、`validationAction: error`；输入和判词均不绕过校验。部署时对现有集合执行 `collMod` 应用该规则，并建立 `{ evaluationTaskId: 1, batchId: 1, kind: 1 }` 索引供任务查询使用。保留现有 UUID 身份唯一索引。读取交付集合的消费方也必须指定 evaluationTaskId，不能按日期直接混合不同任务。

Mongo 交付连接协商使用驱动内置的 zlib 压缩，身份列表每批读取 5000 条。完整文件的输入交付每批最多 16 条或 8 MiB，减少重复连接与身份分页的网络往返；写入大小限制、文档内容与回读校验保持一致。

专题归因树在本地验收后手动上传，不接入逐场结果上传器。后训练专题使用用户指定的 `agent_eval_bench_comparison_problems` 集合，保留专题、模型、日期、冻结归因来源与聚类成功收据；本地保留完整树。只读回验收成功才算交付，不覆盖已有日常问题记录。

用户要求按当前数据截止交付时，通过 `prepareClusteringJob` 的 `acceptedOnly` 显式冻结已接受归因；未完成复核不会阻挡已有成功归因。本次截止于北京时间 2026-10-21 15:12:26，共 359 条 B post_train_fast 成功归因；先复用原作业的 322 条，再在同一问题库处理其余 37 条，后续新增归因不自动加入。导出逐条核验冻结的输入、模型、日期、归因收据，以及所有聚类作业的成功收据和互不重复的来源，不要求整个来源评测 run 结束。交付文件及 Mongo 文档使用 `accepted-at-cutoff` 和 `sourceEvaluationComplete: false` 标明范围，不标为全量专题完成。

该截止增量作业每批最多 60 个独立回答，单次新增类预算相应为 6，减少串行批次；原作业的计划和收据不变，模型总类别上限、最小支持数及主体/证据校验仍沿用原配置。增量继续复用问题库中的待观察问题，完成目录合并和复核后再交付。

Mongo 回执绑定评测任务 ID、连接环境变量名、数据库和集合，不保存连接凭据。任务或目标变化、回执无法确认归属时，配置日期范围内已有 Mongo 交付的任务重新交付输入和正式结果，不重跑评测；旧回执保留，但看板只统计当前任务与目标的交付。已混入其他来源的历史记录需核验后恢复，不自动删除或猜测归属。

输入保留原消息与标签，comparison 保留正式判词和已接受改写。模型 ID 使用与 Host 相同的安全标识规则，保留 `6_luna`、`6.1sol` 原名；versionA/B 按稳定版本 ID 排序，Workflow 用源检查点映射盲测槽位，缺失或冲突拒绝交付，不按正文猜身份。本地收据不变。

来源目录可放置 `case-meta.jsonl` 补充文件，每行为 `{case_id, meta}`，`case_id` 必须等于 `meta._testset_name + "_" + meta._original_case_id`。下载完整文件在提升前将补充内容填入回答的 `meta.info`，Mongo 输入组装也读取同一补充文件；不按问题正文匹配。只补缺失字段，保留原有 `meta`、消息和已有 `info` 值；重复身份、采集身份不一致或已有值冲突均报错。正在被 Host 使用的输入文件只能在读者释放后补齐，补标签不重跑成功评测。

刷新输入时保留库中后补标签，显式输入标签可更新。现有集合对 comparison 的校验例外由上传器处理，不修改集合配置、不删除或迁移历史记录。只读核验保存 verified 时间与数量，不虚构上传事件。

### 统计日志

仅在 `publishStatisticsLog: true` 时启用以下流程；默认四路开启，GPT 六路关闭。

[statistics-log.schema.json](../schemas/workflow/statistics-log.schema.json) 是冻结外部契约，落盘与恢复续传均严格校验。只更新值、标签与日期条目；字段、类型、层级的修改权限见 [AGENTS.md](../AGENTS.md#当前契约优先)。

启动后先生成并上传一条当前累计快照，随后按北京时间 00、04、08、12、16、20 点更新；停机跨多个周期不补造中间历史。每次新快照使用独立 traceId；已有待传日志先沿用原 traceId 和已落盘内容续传，成功后立即补发当前快照。每条含完整累计与逐日数据，消费者读取最新一条，不能把各周期相加。

统计读取已安装的完整输入和已完成的正式比较，不等待整批评测、改写或刷新下载结束。刷新下载期间仍统计上一份完整输入；替换输入文件与统计快照互斥，避免多模型文件混读。首次下载未完成的日期暂不纳入，安装中断且无法确认完整的日期须先恢复输入；恢复优先于常规刷新，恢复成功后立即重试尚未落盘的统计快照，不把不完整数据当作空数据上传。场景分类沿用 `meta.task`，难度沿用 `meta.difficulty` 和 Mongo 后补标签，不根据问题文本猜分类，也不将 RUED 数值擅自换算为难度。

按坐标重读统计输入时，逐条让出事件循环，避免累计统计阻塞评测请求。

胜率按 wins / evaluated；单个模型对的 A.wins + B.wins + both_good + both_bad = evaluated。三模型时每份回答参与两场；对战数按模型对累计，准确率、耗时和 Token 按同题同模型去重。双方的 both_* 各表示参与次数，不能相加当场数。未知指标保留 null，分位数由原始数值重算，不平均逐日分位数。

日期优先用同题有效 request_time 的北京时间日期，全部缺失才用批次日期。分类和难度读取输入及 Mongo 后补标签；难度按最新明确填写的值选择，缺字段保留已有标签，显式空值或未分层才清除旧分层。来源读取失败或分类冲突拒绝本轮快照，不静默生成空标签统计。

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
## 改写恢复与逐场交付

改写的 transport/interruption 熔断与其他评测阶段一样自动续跑，保留成功收据和累计内容提交预算。已接受比较的改写优先于归因改写积压，仍共享来源的 LLM 配额。

Pi 模型请求使用独立 HTTP 连接池，TCP/TLS 建连上限为 60 秒，避免 Node 默认 10 秒建连超时导致网关尚未响应就连续失败。模型请求取消信号、响应超时和任务总时限继续生效。

Mongo 比较交付要求该场比较的改写成功；归因或聚类文案尚未改写不会阻塞该场。独立结果交付读取已存在的配对输入，按同一 comparison ID 的改写内容判断增量，每场改写成功即可覆盖旧文案，并查库确认后保存回执。已有结果即使数量不变也能补传改写；较旧的上传快照不能回滚较新的结果。输入、专题标签和原判决保留。

Worker 结束一次模型调用后等待 Host 确认释放许可，控制回执最多等待 60 秒，避免 Host 写入大状态时超过短窗口而误取消已完成的模型调用。该窗口不增加模型调用时限；确认仍失败则结束该次尝试，Host 的尝试清理负责回收许可。
