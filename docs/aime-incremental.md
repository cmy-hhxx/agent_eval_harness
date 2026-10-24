# AIME 日常评测

工作台的 AIME 日常来源扫描 `1_aime/1_7z_data/online_data`，等待文件稳定，校验、清洗并全量执行 Score 与 Attribution。首次启动还会纳入已有规范输入，沿原每日 run 补齐缺失阶段；已接受结果不重复评测。CLI 与 Workbench 共用执行器：默认执行一轮后退出，加 `--watch` 后持续运行，直到主动停止。

```bash
npm run aime:ingest-and-attribute -- --config /absolute/path/aime-ingest-and-attribute.json --watch
```

配置参考 [示例](../configs/aime-ingest-and-attribute.example.json)。`hostConfigs` 指向当前 AIME 配置，两阶段的模型、thinking 和调用预算沿用这些配置。`concurrency` 默认 `64`，是整个 AIME 来源的上限，多日期与两阶段共享，不与问财混用。`pollSeconds` 默认 `60`：一轮评测全部结束后等待这一间隔，再扫描新包；无数据时同样等待，不启动空评测或重叠执行两轮。首次部署需执行 `npm run build:app`；数据处理继续使用项目已有 `py7zr`，压缩包完整性使用 `7z t`。

按 `Ctrl+C` 停止；等待期间立即退出，评测期间中断并保存进度。之后重复同一命令恢复。持续模式持有现有锁，阻止另一实例写入同一范围。成功的 Score 与 Attribution 行不重复调用模型。自动恢复按阶段选择精确任务，保留任务 ID、已用次数及内容额度；网络中断、超时等可恢复任务在下一轮继续。中文校验失败先在当前任务中修复，仍有剩余额度时也纳入下一轮自动续修；已耗尽额度或确认不可恢复的内容失败保留在报告中，不阻塞新增回答。去掉 `--watch` 手动运行一轮或在工作台选择失败任务重试，仅将所选失败任务重新待评，不更换任务 ID、不清零尝试或内容账本。达到次数或内容预算上限的任务仍不派发，需提高当前预算；未知或回退的最终账本安全闸不因重试而解除。此命令自行启动所需的 Host/Worker，不依赖工作台页面服务。

工作台默认等待手动点击 AIME 的「开始评测」。启动后关闭浏览器仍继续处理新包；「暂停」停止新扫描、清洗和任务分配，已有任务完成后保存进度；「继续」沿原 run 接续；「停止」中断并保存。服务重启不自动恢复评测。模型、档位、预算、Worker 引擎和 debug 设置在下一次启动或暂停后继续时生效，并发可实时调整。结果页直接查看评分、归因、原始坐标和错误，AIME不交付MongoDB，也不自动聚类。

显式 CLI 可用独立 tmux 会话保持运行，关闭 SSH 后继续执行。工作台与 CLI 不能同时拥有同一 AIME 来源；原 `aime-auto` 进程存在时，工作台明确报错，先停止原进程再启动。以下命令在 checkout 中运行；没有 cron、systemd timer 或开机自动启动：

```bash
tmux new-session -d -s aime-auto 'exec node dist/apps/host/src/aime-ingest-and-attribute.js --config /mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/config/aime-ingest-and-attribute.json --watch'
tmux attach -t aime-auto
```

停止使用 `tmux send-keys -t aime-auto C-c`，等待进程保存状态并退出；再次运行启动命令即可恢复。不要直接杀掉 Worker 或删除锁文件。

## 更新、分类与隔离

- 每轮扫描固定当时的目录快照；持续模式下一轮处理之后到达的包。同名包的大小或修改时间变化也属于更新，按修改时间顺序检查；不把同名包永久跳过。归档名、文件大小和纳秒修改时间是文件处理收据，不使用内容哈希。完全保留文件名、大小和修改时间的原地修改无法识别，更新包应正常更新修改时间。
- 新包和更新包先做有限的稳定检查及完整性检查，再在临时目录解包。尚未稳定、损坏或被替换的包列入报告，下一轮重试。
- fast/expert 取记录的 `agent_mode`、`session_type` 和 trace 的 `mode`；相互冲突或未知时隔离。业务日期沿用清洗器的请求时间规则，换算为北京时间；缺请求时间时仅使用已捕获 trace 的明确时间，不取归档文件名。
- 本次保留评测器的单 trace 契约：多 trace、空回答、缺失真实 `trace_id`、模式冲突及当前 TypeScript 输入适配器拒绝的记录均隔离，不拆分、不裁剪、不拼接。回答和工具轨迹保留原文。
- 记录层按真实 `trace_id` 和现有业务身份查重。完全相同的已发布记录报告为重复；同一身份内容不同报告为冲突，不覆盖既有输入或判词。
- 隔离报告保存归档、成员文件、原始行号、数组项位置和原因。原始记录仍在原包中，不再复制原始正文到评测 run。

清洗复用数据服务的 `archive.lock`、`archive-records.sqlite`、待发布事务和原子替换；只修改受影响的模型/日期文件。已发布但尚未来得及启动评测时中断，下次从同一发布收据恢复。恢复旧发布期间发现同名包的新版本，会将本次扫描看到的更新单独处理。

## 输入、结果与运行状态

输入仍在 `2_daily_eval_input/aime_fast/<日期>.jsonl` 和 `aime_expert/<日期>.jsonl`。首次启动从已有规范输入读取精确坐标，后续增量使用新发布记录的坐标；模型、业务 ID 和真实 trace ID 共同限定评测范围。全量涵盖全部合格单轮回答，不抽样、不裁剪多轮、不重评已接受结果。

每天维护同一个目录和同一个run；后续补充旧日期的回答继续追加到对应日期，保留已成功结果。目录沿用现有MMDD结构：

```text
1_aime/eval_output/0_daily_eval/<MMDD>/results/score.jsonl
1_aime/eval_output/0_daily_eval/<MMDD>/results/attribution.jsonl
```

每条正式结果直接包含真实 `trace_id`、`business_date`、`source_archive`、`source_member`、`source_line`、`source_item`、`input_file`、`input_line`，以及源输入 `meta`。这些字段由程序绑定，不由 Agent 生成。导出契约见 [answer-review-attribution.schema.json](../schemas/workflow/answer-review-attribution.schema.json)。

中文验收使用 `npm run attribution:check-language -- --input <attribution.jsonl>`。`strength` 的 `label=null`、`definition=null` 记为“不适用”；`problem` 的两个字段仍要求非空中文，不把优点的合法空值算成失败。命令只读，不影响正在进行的64并发自动化。

例如新增10月24日的数据建立`1024`；后来补到10月19日的数据写回`1019`，不为这次执行另建UUID目录。历史只有归因的回答补建Score任务；可恢复的未完成任务沿原任务与额度继续，内容失败耗尽额度时保留可定位错误，等待显式重试。

流程状态保存在配置的既定 `runtime/state/` 子目录；`watch.json` 记录持续进程的 PID、并发、当前轮数、运行/等待/停止状态、下一次扫描时间和最近错误；`last-report.json` 是最近一轮摘要，`ingestions/<UUID>/report.json` 保存清洗明细。状态仅保存输入坐标、收据、进度和正式结果引用。日志复用 `runtime.log`、`evaluation.log`，不新增轮转日志。

单次模式退出码：`0` 表示完成或无新增数据；`2` 表示存在隔离记录、待稳定/损坏包或未成功评测；`130` 表示主动中断。持续模式将每轮结果和错误落盘，等待后继续下一轮。重复记录单独计数，不当作失败。无新增有效记录且没有待恢复评测时不启动空评测。
