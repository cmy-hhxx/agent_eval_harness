# 仓库规则

## 开始任务

1. 先读 [README](README.md)，再按任务进入对应文档；主线是 TypeScript Host 和 Pi Worker。
2. 修改行为时同步更新实现、当前调用方、测试和文档；只保留当前事实，不保留历史计划或重复说明。
3. 不编辑生成的 `dist/`，不删除本地输入、评测结果或缓存来“清理代码”。

## Git 提交与双仓库推送

- `origin` 是 117 主仓库：`ssh://git@117.50.195.94:2177/chenmingyang2/agent_eval_harness.git`。
- `gitcc` 是 GitCC 副仓库：`https://git-cc.myhexin.com:6443/aidata/eval_harnesss.git`。
- 所有新提交统一使用 `dsw-98885 <type>(<scope>): <描述>`，包括文档提交和仅推主仓库的提交。`98885` 是当前约定的任务 ID；只有用户明确更换时才使用其他 ID。
- 按用户指定的目标显式推送：117 / 主仓库使用 `git push origin <分支>`，GitCC / 副仓库使用 `git push gitcc <分支>`；只有明确要求同步两边时才分别推送。未指定目标时先确认。
- `main` 跟踪 `origin/main`；向副仓库推送时使用不带 `-u` 的命令，保持主仓库上游不变。
- 推送前完成验证，检查每个目标远程的全部待推提交信息；双边同步使用同一个提交，依次推送后逐个核对远端分支与本地 HEAD。某一边拒绝时报告两边实际状态。
- 改写已推送的提交须针对具体提交单独获得用户授权；获准后使用限定远端预期旧提交的 `--force-with-lease`。普通同步使用快进推送。
- 操作步骤与验收见[开发指南](docs/development.md#git-提交与推送)。

## 当前契约优先

- **统计上传日志结构已冻结**：以 [`schemas/workflow/statistics-log.schema.json`](schemas/workflow/statistics-log.schema.json) 为固定契约，包括所有 `wins` 同级的 `both_good / both_bad` 对战计数。后续仅更新统计值、标签内容和日期条目；禁止自行增删、重命名字段或改变类型、层级。落盘与上传（包括续传）必须校验，不能静默转换。只有用户明确要求修改这份外部契约时才能变更；普通看板、统计或自动化改动不构成授权。
- 项目快速迭代，未明确固定版本前不设置项目、状态、Schema、Profile 或内部协议版本号。`evaluatorVersion` 是唯一例外：它是显式声明、人工维护的评测器标识，用于结果溯源，不是 Schema 或内部协议版本，不引入兼容分支。任何影响判词的变更（提示词、业务校验、材料组装、证据解析、判决与导出逻辑、聚类硬约束）都必须同步更新它。
- **禁止兼容旧代码或旧契约**：直接更新当前调用方并删除旧入口、别名、迁移层、双写和静默降级；不要为旧格式保留测试。
- 同 run ID 续跑、A / B 输入适配、Pi SDK 适配是当前功能，不得误删；续跑不因代码、模型或参数变化而拒绝。
- 禁止项目自有且没有必要的哈希、摘要、校验和、源码树指纹或复制正文的跨 run 结果缓存。按已有最终输出跳过完成的业务样本，不以来源收据作为续跑门禁；索引只保存业务身份、持久化 UUID、来源坐标和溯源，不复制输入或判词正文。保留必要的结构、引用、重复行、缺行和文件读写竞态检查。`evidence_id` 是可解析的证据坐标，不是哈希。第三方依赖内部机制及锁文件 `integrity` 字段不受此限制。

## 模块边界

- 所有内置 Agent 的提示词、共用材料文案和工具描述集中在 [`packages/prompts`](packages/prompts/README.md)；业务校验和单元测试在 `packages/agents/src/<agent>`；Schema 集中在根目录 `schemas/<stage>/`，由 Agent 公开入口组装。Agent 之间禁止互相导入。
- Attribution Agent 只输出每条回答的归因结果和问题描述（component/label/definition），不读问题库、不建类；Clustering Agent 拥有问题库，负责归类、新建类和合并类。Comparison 只确认既有 finding，不改写归因结论。改写 Agent 只接收待润色的文本槽位，不接触证据，也不能改动判决；槽位映射、回填与 commentary 属于 `packages/workflows/src/comparison`。组合、A/B、盲测、状态编解码和报告也属于该 Workflow。
- `apps/host` 负责 CLI、配置和组装；`packages/host` 只接收定义，禁止导入具体业务。文件、锁和日志属于 `packages/data`；Worker、HTTP/SSE、会话和双 SDK 属于 `packages/runtime`；通用工具只在 `packages/tools`。
- Eris 只读分析已有评测结果，不执行专业评测或修改判词；界面规则见 [PRODUCT.md](PRODUCT.md)。
- 跨包代码只使用公开导出；根目录 `schemas/` 是由构建复制的 JSON 资源，不是代码依赖。Contracts 禁止文件、网络和 SDK 实现。边界与验证入口见 [模块地图](docs/modules/README.md)。
- Python 只用于代码工具；不要恢复独立 Python 评测器。

## 数据与运行

- 评测服务与 Eris 运行在服务器；本地只做代码开发、构建、模拟测试及 Git 提交推送。真实模型评测、数据读取与正式产物写入均在服务器完成。
- 服务器代码统一部署在系统盘 `/opt/eval_harness/` 的独立子目录：主线 `main/`、Eris `eris-code/`，其他分支或用途另建子目录；代码从 Git 拉取，不在共享盘保留 checkout。共享外部运行目录为 `/mnt/fin_bench/sync_datasets/code/1_eval_harnes/runtime/`，其中不放 checkout。不再使用 `user_workspace` 部署，不保留旧路径软链接。废弃任务的进程、checkout、一次性脚本、实验配置与状态、历史输入副本、旧运行日志和迁移备份直接清理，不留档；保留当前配置、密钥、账号、聊天、问题库与统计记录，数据源原始输入和正式评测结果不得随部署清理删除。
- 服务器数据根目录为 `/mnt/fin_bench/eval_data/`，来源为 `0_wencai`、`1_aime`、`2_ifind`。数据排查、分析与材料准备优先读取各来源的 `2_eval_input/`、`3_eval_output/`，以及 `4_user_kyc_data/{source}/`；默认不查看或遍历 `0_archive/`、`1_7z_data/`，只有用户明确要求处理归档或压缩包时才进入。目录约定见[部署指南](docs/deployment.md#服务器数据目录)。
- 业务数据根目录、来源清单和输入/输出/KYC 目录只在外部配置中声明，禁止写死在 TypeScript、JavaScript 或脚本中。Host 使用显式输入路径、`output.path` 与 `output.testPath`；Eris 使用配置的业务 ID 与产物目录映射，不从目录名推导来源或测试范围。配置样例可展示服务器约定，运行时不得回退到内置路径。
- 评测输出由用户显式填写，不强制固定服务器根目录。启动前检查路径可用、输入输出不重叠，并轻量比对业务目录名；名字不对应时明确提示，不擅自迁移或改写路径。测试使用独立输出位置，默认建议配置的 test_eval，避免影响正在运行的任务和正式结果。配置、状态与日志继续使用各自配置目录。
- 默认交付按被评模型分目录、业务日期命名文件，日期使用原始输入已核实的完整 `batch_id` 日期，不使用评测启动日期，不截取时间字段或改变时区。归因文件为 `<模型>/<模型>_attribution-YYYY-MM-DD.jsonl`，摘要文件为 `<模型>/compact/<模型>_compact-YYYY-MM-DD.jsonl`；对局文件为 `comparison/<模型对>/<模型对>-YYYY-MM-DD.jsonl`；共享 Criteria 为 `criteria/criteria-YYYY-MM-DD.jsonl`，待核和独立核验等辅助正式产物也按种类、模型对与日期命名。run ID 只用于内部恢复与溯源；只有用户明确要求时才使用 `output.layout: "run"` 交付隔离 run 目录。问财与 AIME 均在用户指定的输出根内组织文件。
- 续跑以用户指定的输出目录为准：同模型（对比为同模型对）、同业务日期、同 case 已有最终结果就跳过，缺失的继续评测。只读取最终结果的业务定位字段，不要求旧 run、来源收据、原始回答一致、评测器版本或配置匹配，不增加哈希、指纹或复用门禁。Compact 等中间产物不代表 case 完成；不复制或补造旧判词。保留必要的文件读写错误与同时写入保护。

- 原始输入只保留在数据源，不在每个 run 重复保存。`state.json` 只保存恢复所需索引、进度和草稿；正式结果引用 JSONL，不重复保存正文。
- 问题库是跨 run 知识库，不是结果缓存：每个模型一份，类 ID 用持久化 UUID，出现样本与事件追加；合并会更新类状态和样本归属，保留 lineage；类数量由程序硬控（每模型上限 + 单次新增预算 + 合并整理），不复制正式结果正文。
- 默认保存恢复状态、正式结果与报告，不归档排查材料；排查材料只有显式 `--debug` 才写入 `_internal/`。产物清单见[使用指南](docs/usage.md#运行产物)，禁止交付压缩包。
- 运行与评测日志统一写入根 `log/runtime.log` 和 `log/evaluation.log`；Agent 不自行写日志、不新增日志文件或轮转文件。历史统计日志保留在原目录；日志 IO 均由 `packages/data` 维护。

## 验证与维护

- 验证按改动风险选择最小充分集合，遵循[开发指南](docs/development.md#验证)。不得机械叠加 `npm test`、目标测试与 `test:full`，也不得为证明已知耗时而重跑全测；评测后端验证不构建或运行 Eris 测试。
- 每次契约或目录变更、每轮迭代收尾和提交前检查测试代码：删除失效用例、旧字段、重复 fixture/helper 和旧兼容路径，让测试只覆盖当前行为。不要删除真实输入、结果或缓存来“清理测试”。
- 修改 vendor 必须更新 `vendor/upstream.json` 的 `local_changes` 并重新构建。Pi 只注册应用从 `config.ini` 网关配置的模型，不恢复内置第三方模型数据或目录刷新。
