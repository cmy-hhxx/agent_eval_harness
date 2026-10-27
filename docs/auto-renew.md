# 日常数据自动更新

`bash auto_renew.sh` 只接问财与 AIME 日常，交付瘦身后的 JSONL，不运行评测。外部业务清洗由清洗项目负责，本脚本只读其进程、文件状态和锁，不启动、停止或重启清洗程序。lost_user 和其他专项不在范围内。

## 运行

代码更新到已部署的服务器 checkout 后，在项目根目录执行：

```bash
bash auto_renew.sh --check
bash auto_renew.sh
```

需要 SSH 断开后继续运行，先进入 `tmux new -s auto-renew`。脚本前台运行，Ctrl+C/SIGTERM 停止派发，等待当前操作收尾；再次执行同一命令恢复。不会注册自启或后台 daemon。使用项目现有 Node 24、Python 和数据服务 py7zr 依赖，优先由 mise 提供工具链；数据包依赖从既有 `runtime/python-packages` 加载。需要已完成项目 bootstrap/build，不会自动安装软件或修改清洗项目。

`--check` 只读检查依赖、目录、进程和已有清洗文件，不解包、不瘦身、不写断点。进程无法按日常路径识别时显示 `daily_cleaner_not_identified`，不把 lost_user 清洗进程当成日常进程。硬编码路径且未通过参数暴露的外部调度器可能无法识别，最终以逐文件完成状态、输入回执和文件锁为准。

`--once` 运行一轮后退出；新包首次观察时不会立刻处理，至少过一个稳定窗口再运行一次。正常持续模式默认每 30 秒扫描、每包独立稳定 30 秒，不被其他正在上传的包阻塞。单实例锁阻止重复启动。

默认读取 `configs/auto-renew.json`，支持 `--config /absolute/path/auto-renew.json`。部署时可将配置复制到 runtime/config 后修改。目录改名须显式改配置，不猜测替代路径；来源必须且只能是 `wencai` 和 `aime`。

## 目录和流程

以下路径相对 `/mnt/fin_bench/eval_data`：

| 来源 | 收包 | 解包规范输入 | 外部清洗输出 | 最终瘦身交付 |
|---|---|---|---|---|
| 问财 | `0_wencai/1_7z_data/A_AA_comparision_data` | `0_wencai/2_daily_eval_input` | `0_wencai/6_daily_eval_input_clean` | `0_wencai/6_daily_eval_input_clean_slim` |
| AIME | `1_aime/1_7z_data/online_data` | `1_aime/2_daily_eval_input` | `1_aime/3_daily_eval_input_clean` | `1_aime/4_daily_eval_input_clean_slim` |

1. 对稳定且未被进程写入的顶层 `.7z`，复用数据服务当前的解包、记录适配、分模型/业务日期、去重与事务发布。它生成外部业务清洗需要的规范输入，不调用外部清洗逻辑。与工作台共用 `runtime/state/data-service/<来源>/archive.lock`，忙时稍后再试。
2. 发布回执与包的名称、大小、mtime 匹配后，将包移入 `<收包目录>/3_processed_archives/<YYYYMMDD>/`。日期来自包名末尾 `_YYYYMMDD_HHMMSS.7z`。无日期、坏包、内容变化、同名归档冲突均保留原包并记录；不覆盖、不改名猜测、不删除原始数据。归档使用同文件系统的排他硬链接后移除收包入口；中断在两个步骤之间可恢复。
3. 独立扫描已有清洗文件，首次启动也补齐存量。只有 `status.json` 中 `completed`、四个读取/处理游标一致、处理中和各类 backlog 计数全为零才可继续。`completed_with_backlog`、`processing`、`blocked`、状态缺失等均等待。
4. 核对当前规范输入的 ready 回执、行数、文件元信息及清洗更新时间，防止新输入误用旧 completed 状态。清洗模型目录必须有现行 `.status.lock` 和 `status.json`；检查采用非阻塞共享锁，锁忙就等待下一轮，不阻塞现有清洗任务。
5. 复用 `aime-slim.mjs` 逐条去重重复 prompt/工具定义，并反向展开校验正文一致；输出行数须等于清洗完成的输入行数，缺行或多行均不交付。临时文件通过发布前的再次核对后，才原子替换目标 JSONL。只短暂持有发布检查锁，瘦身计算不占用清洗锁。

问财保持 `a_fast/b_fast/a_expert/b_expert`，AIME 保持 `aime_fast/aime_expert`；各模型下仍为 `<YYYY-MM-DD>.jsonl`。只做结构瘦身，不额外交付 gzip/zstd 压缩包。首次处理会核验并重做没有本脚本回执的现存瘦身文件。

当前只读核查未发现日常清洗进程，问财清洗目录为空。因此启动后可能停在等待清洗阶段；这是未满足交付条件，不会伪报整条链路成功。

## 记录和恢复

默认 runtime 为 `/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime`：

- 统一记录：`log/runtime.log`，筛选 `component=auto-renew`。包含包名、归档位置、输入输出路径、条数、体积、清洗等待原因、错误和启停事件；不新增私有日志。
- 恢复状态：`state/auto-renew/state.json`，保存上传稳定观察、交付文件元信息与行数、交付时间、当前等待/错误状态，不保存正文或内容哈希。
- 解包恢复：复用 `state/data-service/<来源>` 的事务和回执；已发布但尚未归档的包直接补归档，不重复追加输入。
- 瘦身恢复：已交付且输入与输出均未变化的文件跳过。临时文件被打断后重做该文件；发布后、写回执前被打断也只重做该文件，不向目标追加重复行。

等待新一轮清洗或发生错误时保留上一份成功交付，`state.json` 的 `pending` 和日志标记尚未更新的文件；不能把上一份交付当成新增输入已经完成。缺少整个清洗目录等来源错误也会写日志，不影响另一来源继续处理。日志无法写入时停止；断点损坏会明确报错，不静默丢弃重建。

持续模式对失败包/文件下一轮重试。`--once` 遇到处理错误返回非零；单纯等待上传、清洗或锁不算处理失败。退出后不会停止外部清洗或工作台。
