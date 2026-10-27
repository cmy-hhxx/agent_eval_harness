# 临时夜间三路评测

`scripts/night-eval.mjs` 在同一个进程内分配问财、AIME 流失用户、AIME 日常的模型请求额度。先在 worktree 开发验证，合并就绪后才由操作者在服务器启动；不会部署、注册自启或修改外部清洗服务。

## 启动与交付

使用已完成 bootstrap/build 的服务器 checkout。默认配置为 `configs/night-evaluation.json`，INI 路径和 `hostConfigs` 可指向 checkout 外的现行配置；路径相对该 JSON 解析。启动前用 `check` 核对实际输入、渠道和清洗状态。问财流程有独立改动时，在合并后让 `hostConfigs.wencai` 指向合并后的配置。

```bash
node scripts/night-eval.mjs check
node scripts/night-eval.mjs run
node scripts/night-eval.mjs status
node scripts/night-eval.mjs close-input
```

需要 SSH 断开后保持运行时，先进入 tmux。所有命令支持 `--config /absolute/path/night-evaluation.json`。`check` 只读，不收包、不瘦身、不调用模型。`run` 首次锁定两路日常输入，以及操作者已经放入流失瘦身目录的存量文件及记录坐标，后续同一状态目录只恢复已锁定范围。启动后日常源文件须保持稳定，源被覆盖或追加会明确失败；不会偷偷改变今晚范围。

| 来源 | 工作流 | 正式输出 |
|---|---|---|
| 问财 | 当前 Comparison，含配置启用的阶段 | `/mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/<业务日期>/` |
| AIME 流失用户 | Attribution | `/mnt/fin_bench/eval_data/1_aime/eval_output/3_lost_user_eval/lost-<UUID>/` |
| AIME 日常 | Attribution | `/mnt/fin_bench/eval_data/1_aime/eval_output/0_daily_eval/<业务日期>/` |

正式结果遵循各 workflow 的现行契约，AIME 在 `results/attribution.jsonl` 增量落盘。既有 `.archive` 不读取、不移动、不计入覆盖。本管线交付上述本地结果，独立于工作台的持续取数与 MongoDB 交付服务；运行期间不要再用其他评测进程占用同一日常 run 或这份模型请求额度。`3_lost_user_eval` 当前不会自动出现在只枚举日常、专项和测试目录的助手检索入口。

## 调度

1. 问财只选择业务日期 **2026-10-23 至 2026-10-27（含首尾）** 的启动快照，最先运行，完成后不再接收新增问财数据。范围由 `night-wencai.json` 的 `inputs.batches` 限定。
2. 就绪的流失批次优先于 AIME 日常。首次准备完存量即登记首批，之后每两小时登记新增瘦身文件。
3. 流失就绪队列清空时运行 AIME 日常。新流失批次登记后停止派发新的日常任务，已派发任务继续完成，状态保存后切换；之后按原 run 恢复日常。
4. 两个配置渠道分别硬限 **200 个实际模型请求**，整条管线最多 400。工具调用与材料准备不占请求许可。额度只约束该管线，外部清洗等其他进程在相同网关上的请求独立计算。

运行失败会保存错误，保留同一 run 的已接受结果，并继续其他可运行批次。失败批次不计为完成。修正原因后停止管线，再执行 `run --retry-failed` 重试；这沿用 Host 的累计预算，不清空失败记录或绕过业务校验。

## 流失数据链路

启动前由操作者补齐 `6_lost_user_eval_clean_slim/{aime_fast,aime_expert}/` 的存量 JSONL；每个文件只包含一个业务日期。首次启动逐行检查瘦身格式、业务身份、重复与文件稳定性，将存量直接登记到评测队列和持久化去重索引，不重复瘦身或复制正文。隐藏目录与 `.archive` 不参与。存量入队后不得覆盖或追加原文件；后续新增压缩包继续走下面的自动链路，生成独立增量文件。清洗输出再次包含存量时，只核对正文一致，不重复交付或评测。已有状态的重启直接恢复索引，不重新导入存量。

以下路径相对 `/mnt/fin_bench/eval_data/1_aime`：

| 环节 | 目录 |
|---|---|
| 收包 | `1_7z_data/lost_user` |
| 原压缩包归档 | `1_7z_data/lost_user/3_processed_archives/<YYYYMMDD>/` |
| 解包规范输入 | `5_lost_user_eval_input` |
| 外部清洗输出 | `6_lost_user_eval_clean` |
| 瘦身交付 | `6_lost_user_eval_clean_slim/<模型>/<日期>-<UUID>.jsonl` |

每 30 秒逐包检查稳定性，正在写入或发生变化的包等待；坏包保留并报错，其他包与已有清洗输出继续处理。沿用已存在的 `.extract-lost-user.json` 进行增量提取，断点缺失、损坏或同名冲突明确报错，禁止自动全量重建。与既有 `watch-lost-user.mjs` 共用规范输入目录的实例锁，避免两个 watcher 同时追加。手工 extractor 也不应与管线并发运行。

按清洗 `status.json` 已提交的 `output_records` 读取输出 JSONL 的完整记录前缀，先瘦身再交付评测。`processing`、`completed_with_backlog` 和持有整轮清洗锁都不阻挡已提交记录；未完成标注或翻译的记录继续等待清洗服务补齐，后续以新业务身份增量交付。清洗器先持久化追加记录，再原子更新提交计数；未计入该计数的尾部不会进入评测。只有状态 `completed`、输入游标与解包回执一致且 backlog 清零，才把该文件标记为全部收尾。管线不启动、停止或重启外部服务；剩余等待原因和错误通过 `status`、统一日志查看。

瘦身复用现有消息池转换并逐行反向还原校验。每轮仅捕获清洗 **输出** `output_records` 对应的前缀到临时文件，允许清洗正常过滤输入。发布前逐字节核对该前缀，文件替换、截断或前缀改写会延后并报出原因；正常追加不阻挡发布。临时原文随本次操作清理，评测只引用已经发布的不可变瘦身文件。每轮交付一次后返回，避免持续追加让单个文件独占准备循环。

每个成功交付文件保持不变，后续同日期仅发布新业务身份。索引只保存业务标识、文件坐标和元信息；既有身份若正文改变、被删除或同批重复则报错，不能静默沿用旧结果。崩溃发生在文件发布和回执保存之间时，通过持久化发布意图恢复，避免重复加入评测队列。输入正文只在数据源目录，不复制到每个 run。

## 收尾与恢复

`close-input` 保存截止时收包目录已有的包名，之后的新包不纳入本次任务；截止时仍在上传的包继续等待稳定，已接收数据继续等待清洗和评测。收尾阶段就绪数据立即登记，不再等待两小时间隔。清洗等待、归档错误和失败任务没有解决前不会报告全部完成。没有执行 `close-input` 时持续监听，不把暂时空队列当最终完成。

Ctrl+C/SIGTERM 停止继续调度，等待已派发任务和当前数据操作收尾。同命令重启沿用 `runtime/state/night-evaluation/state.json`，不会重新扫描归档的旧评测结果。状态损坏报错，不自动丢弃重建。控制与状态只在既定 runtime 目录；日志由 `@eval/data` 写入 `runtime/log/runtime.log`、`evaluation.log`，无新增运行日志文件。

本地验证使用临时合成数据与模拟 Worker，不写服务器真实产物。需要真实小样本验证时，另走既有 CLI 的 `--test-eval` 和对应来源 `test_eval/`，不要用本管线的正式配置试跑。
