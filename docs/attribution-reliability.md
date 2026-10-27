# 归因可靠性与固定样本验证

质量约束：保持原始证据、归因组件、业务校验和内容修复额度。系统故障不得要求模型改写已有判词，也不得消耗内容修复额度。有效吞吐按完整 session 的归因产出计算，不能用组件完成数或跳过输入提高指标。

## 执行顺序与验收

1. 问财 Comparison 与独立 Attribution 的新建、多 trace、同 run 续跑走真实 Host 提交；有效证据可提交，非法证据仍拒绝。
2. 区分内容拒绝与系统故障。瞬时交付失败使用同一请求重试；确定性 Host 故障保留草稿并暂停阶段；已有内容错误的累计预算不重置。
3. 恢复热日志和 progress 投影：只允许补充缺失的导出引用，拒绝判词或状态冲突；热库丢失时不复用事件序号；本次配置在重放后生效，旧 receipt 保留原版本。
4. 本次按使用者明确要求，仅运行改动相关的快速回归与 typecheck，通过即部署；不跑全量测试，也不将定向通过表述为全量回归通过。
5. 用下列固定样本验证交付与耗时，复核问题、证据和结论。逐项减少重复材料传递、文件写入和无效模型往返；记录每轮实际改动，在相同样本与配置上比较。多项改动合并的轮次不能分离各项改动的独立收益。
6. 当前压测固定 AIME 全日期 200 条样本，两个渠道各 100 个运行任务槽位，分别 high/low；三轮各计时 10 分钟。未完成 session 与失败单列，不能用组件数量替代正式结论数量。

## 固定小样本

配置中的业务 ID 和原始源路径构成固定范围，不复制输入。问财选两个问题的 A/B Fast 回答，使用 Comparison；AIME 选四条 Fast/Expert 回答，使用独立 Attribution。两者固定同一模型、8 并发、high 归因推理和 3 次修复。小样本用于发现链路和交互成本问题，不能证明大规模吞吐或质量非劣。

在服务器隔离 checkout 中加载既有 INI，执行：

```bash
export EVAL_CONFIG_FILE=/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/config/config.ini
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/wencai-attribution-reliability.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/wencai-attribution-reliability.json --run-id wencai-reliability-baseline --test-eval --debug
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/aime-attribution-reliability.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/aime-attribution-reliability.json --run-id aime-reliability-baseline --test-eval --debug
```

每轮记录 Git commit、完整生效配置、输入业务 ID、run ID、成功 session 数、失败类型、端到端耗时、各阶段 p50/p95、模型请求/输出 token、工具调用、内容修复次数、Host 校验与落盘时间。未结束 attempt 单列，不能计为成功或作为零耗时。串行执行两种来源，避免争用配额影响比较。提示词或材料优化使用新的 run ID，不在已完成的 baseline 上续跑来比较性能；同 run 续跑只用于验证中断恢复和配置生效。

质量复核检查每个问题是否有原文依据、责任组件是否准确、证据坐标是否有效，以及是否漏掉关键问题。JSON 和 Schema 通过只是结构检查，不能替代质量复核。性能改动须同时比较完整 session 的结果与失败率；不截断有效证据或跳过长 session；low 仅作为使用者指定的独立实验，在质量非劣未经验证前不能替换生产默认。

## AIME 全日期 200 条、100 并发

`configs/benchmarks/aime-slim-200-concurrency-100.json` 固定了 2026-10-19 至 2026-10-26 的 200 条 session（Fast、Expert 各 100）。按每个模式的日期数量分配，再在各日期内按 JSONL 行长度分层选择，保留长尾。源文件仍在 `4_daily_eval_slim`，没有复制正文。抽样时全量为 5,493 条；后续新增不进入本次固定测试。

首次预检发现 8 条输入异常，已在同日期、同模式中按最接近的行长度补入有效样本；异常不计成功，未放松输入校验。以下行号从 1 开始，数据源修复前，全量耗时估算不代表这些输入能被成功评测。

| 模式 | 日期 | 原行号 | 异常 |
| --- | --- | --- | --- |
| Fast | 2026-10-22 | 27、159 | 外层 trace/message 数量与正文不一致 |
| Fast | 2026-10-23 | 110、2408 | 外层 trace/message 数量与正文不一致 |
| Fast | 2026-10-24 | 221 | 外层 trace/message 数量与正文不一致 |
| Expert | 2026-10-23 | 72 | 外层 trace/message 数量与正文不一致 |
| Expert | 2026-10-23 | 355 | trace 2 用户问题为空 |
| Expert | 2026-10-26 | 5 | 外层 trace/message 数量与正文不一致 |

使用 100 并发、100 session 窗口和原有 high 推理及修复预算，运行时不启用逐 token debug 归档。记录实际峰值并发、完整 session 成功率、总耗时、分模式吞吐、限流、超时和内容拒绝。估算全量时按 Fast/Expert 实际数量加权，不能把这批均衡抽样直接等比例放大；输入文件变化时重新核对样本坐标。

限时压测仍使用这 200 条记录，但在每个日期/模式内固定打散，再交错各组；Attribution 按显式 `inputs.records` 顺序规划，避免文件扫描顺序让 10 分钟窗口只覆盖 Fast。每轮两个渠道分别 high/low，各 100 并发；实际达到 100 个运行任务后计时 600 秒，然后停止并保留收据和未完成草稿。只统计窗口内接受的完整 session，冷启动单列，截止时取消的任务计未完成而非模型失败；每轮使用新 run ID，不借用前一轮结果。

```bash
node dist/apps/host/src/cli.js preflight --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json
node dist/apps/host/src/cli.js run --config configs/host.json --config configs/benchmarks/aime-slim-200-concurrency-100.json --run-id aime-slim-200-c100 --test-eval
```

低推理对照使用相同的 200 条记录、100 并发和内容校验，叠加 `configs/benchmarks/aime-slim-low-channel-2.json`，将全部归因阶段设为 `low`，通过 `evaluation-gateway-2` 调用同一 `deepseek-v4.1-flash`，独立 run ID 为 `aime-slim-200-c100-low`。先用 `model-probe --stage attribution-component --execute` 核实渠道与工具调用。两个 run 可同时执行，但共享服务器资源；渠道和推理强度同时变化，测得差异不能只归因于推理强度。

目标是冷启动之后每分钟完成约 30 条完整 session。以正式 session 收据的接受时间计算连续窗口吞吐，另报启动、并发爬升和收尾时间；不能把 component 或 trace 当作 session。100 个槽位要达到此目标，每条 session 的所有任务及重试合计平均只能占用约 200 秒槽位时间。对照须按业务 ID 比较问题、责任组件和原文证据；结构通过率、问题数量或更少的输出 token 均不能单独证明质量不下降。

第二轮首轮输入预载本组件前两个责任边界中的最多 8 段原文，每段最多 400 字符；仅注册实际展示的坐标，逐段与原始输入核对，完整调用目录和后续读取仍保留。材料明确标记为局部，不能据此跳过剩余相关调用。

第三轮修正责任链小现场：按实际 chain_indices 收集汇合链条，返回全部相关请求、工具返回、下一轮输入与输出，责任选项按真实 transition_index 关联。request 使用实际执行参数，调用前上下文保留为 request_context，避免模型再次导航补齐缺失材料。
责任链读取同时登记实际已展示范围；预算耗尽的未展示片段只返回读取入口，不能注册成可引用证据，截断后的编号仅覆盖已展示字符。
第三轮同时针对首轮样本暴露的误报增加约束：未发起调用或空计划不自动构成工具故障，遗漏必要调用须绑定原任务的实际交付义务；保留对真实报错、零行和空返回的检查。high 与 low 的质量仍需按原始证据复核，不能凭结构成功率判定非劣。

## 质量复核：否定断言与自身证据矛盾

2026-10-27 复核 `aime-opt-r1-low`（r401）发现：case `thread_6632c2f9647646feb5454a3053fb1ba2`、trace 0、终稿生成轮，在“过期行情当作当日价，来源日期未核验”问题的原因中声称回答“未标注数据截止时点”。但回答第二句明确给出 `بتاريخ 24 أكتوبر 2026`（日期为 2026-10-24）；归因的现象描述也承认“第二句才注明报价日期”，所附引文同样包含该日期。来源为服务器 `1_aime/eval_output/test_eval/aime-opt-r1-low/results/attribution.jsonl`。

已确认的是“否定断言与自身现象描述、证据不一致”。不能据此归因为局部阅读遗漏，因为模型已明确引用并描述该日期。可能机制是把“未标注日期”与“来源日期冲突未核验”混为一谈；具体机制尚未验证。日期已标注也不自动证明时效可靠，后者须独立举证。

修复要求：否定断言须核对相关目标文本的完整范围；区分信息缺失、信息冲突与未核验；提交前核对现象、原因和引文的一致性。证据包含被声称缺失的信息时，修正或删除该断言，不因局部未见而推断全文不存在。
责任链按完整工具响应体预算裁切展示条目，省略计数与完整目录入口显式保留；只有最终展示页注册证据和已读范围，避免通用大响应预览隐藏已登记材料。

组件提示词要求提交前核对否定断言与自身现象、引文的一致性，并区分缺失、冲突与未核验；相关样本仍需在同批真实压测中复核，提示词修正本身不构成质量验收。

第二轮 high 发生一次 submission_file_invalid：模型反复提交未创建的 evaluation-draft.json，fileErrors 耗尽而 contentSubmissions 仍为 0。第三轮组件归因直接使用结构化 submit_evaluation，去掉强制写文件与 edit_json；结果 Schema、原文证据校验与内容修复预算保持不变。

## 三轮实测结论（2026-10-27）

三轮已结束，按使用者要求停止继续优化。最终实现为 r407，提交 `86d4e9cf5c5cffd1df1c5f408832a3e5cf617ee8`，分支 `codex/attribution-reliability`。服务器隔离 checkout 已使用该提交运行第三轮；没有切换生产默认推理强度。

以下均为达到实际 100 个运行任务后的 600 秒窗口内，正式接受的完整 session 结论。high 使用 evaluation-gateway，low 使用 evaluation-gateway-2；模型均为 deepseek-v4.1-flash。两个渠道同时运行，每路各 100 并发，共享服务器资源。

| 轮次 / 版本 / 提交 | high 完整 session | low 完整 session | high / low 每分钟 | 停止前失败任务 high / low |
| --- | ---: | ---: | --- | --- |
| 1 / r401 / 71b9884f | 14 | 19 | 1.4 / 1.9 | 0 / 0 |
| 2 / r402 / aeed0267 | 12 | 18 | 1.2 / 1.8 | 1 / 0 |
| 3 / r407 / 86d4e9cf | 10 | 19 | 1.0 / 1.9 | 0 / 0 |

**30 session/分钟的目标未达到，也没有证据表明三轮改动提高了完整 session 吞吐。** 200 条输入展开为 1,973 个任务：1,494 个组件、279 个 trace、200 个 session。100 并发是任务槽位数，不能解释为同时完成 100 条 session。第三轮平均观测活跃任务为 high 98.98、low 97.63；已结束成功 attempt 的计时中，模型耗时分别占 98.29%、97.16%。单个已完成组件的模型耗时中位数仍为 high Fast 277.89 秒 / Expert 254.78 秒、low Fast 217.51 秒 / Expert 198.94 秒。瘦身消除了输入重复，但没有消除逐组件模型推理和后续汇总的成本。

三轮共同完成的组件配对中，high 97 个任务的工具调用合计 1,249 → 1,057 → 914，模型耗时合计 26,438 → 27,338 → 25,770 秒；low 145 个任务的工具调用 1,872 → 1,640 → 1,342，模型耗时 35,920 → 33,638 → 31,382 秒。交互次数下降没有转化为完整 session 产量提升。这里仅比较三轮均完成的任务，存在未完成长尾的选择偏差；不能据此宣称整体提速或质量非劣。

第一轮两路各有 1 条 session 在计时窗口之前完成，因此最终 JSONL 行数分别为 15 / 20；第二轮为 12 / 18，第三轮为 10 / 19。六份 JSONL 均逐行解析成功，行数与最终 session 收据数一致，按 session_id 和 agent_mode 检查无重复。第三轮仍有 high 190、low 181 条 session 未完成，不能把“停止前无失败”表述为 200 条成功率 100%。定时停止的取消任务保留恢复状态，未计入模型失败。

窗口开始前时间为第一轮 313.49 / 259 秒、第二轮 240.07 / 248.82 秒、第三轮 255.79 / 249.06 秒。第一轮控制器曾因锁文件尚无 URL 退出，修复后 high 使用控制器首次观察到 100 的时间，low 使用已有 100 活跃任务快照；这两个数字不是最早达到 100 的精确冷启动时间。按 state.startedAt / receipt.acceptedAt 重建首次 100 并发的近似窗口，第一轮为 14 / 18 条。其余两轮由控制器直接观测。截止后停止与落盘有延迟，统计仍严格按 acceptedAt < window_end，不计延迟期间产出。600 秒短窗口与两个渠道的差异，均不足以给全部 5,493 条提供可靠完工承诺。

第二轮 high 的唯一失败为 `thread_254da5258a70400e84882b65cce46d6f` 终稿组件反复提交不存在的草稿文件，内容提交次数为 0。第三轮改为原生结构化提交；low 已完成该 session，第三轮两路没有出现该失败。第二、三轮各曾有一次构建缺少 runtime/deepseek.js 的启动失败，尚未产生模型请求、输出根目录或测量窗口；改用 build:app 并验证 CLI 启动后重启为 r2b / r3b。这些启动记录保留，不混入有效窗口的模型失败统计。

### 最后一轮质量复核

- `thread_c4ab4b58f4ac4c319514251b960f9caf`：两路完整结果均未再给“Buy 1000€ bitcoin”强加实时行情查询义务。
- `thread_b7577f0304b54825a85a262c898f9ba4`：两路完整结果仍识别德语译文残留英文和冠词/名词语法问题。
- `thread_5034b9574a4247a8b36f6cb1aa41f39f`：low 完整结果仍识别 finquery 零行、网页正文缺失及空结果原因与证据矛盾，没有通过删除真实问题来提高通过率。
- 日期样本 `thread_6632c2f9647646feb5454a3053fb1ba2`：low 的 web_search 组件及 trace 收据明确指出 publish_time 为 2022-10-24、正文为 Oct 24, 2026 的冲突，同时承认终稿已注明 2026-10-24；终稿组件返回无问题。high 的终稿组件承认已标日期，描述“今日”措辞与上一日报价的矛盾，没有再声称未提供日期。两路该 session 均未在截止前完成，以上仅为组件 / trace 复核，不能当作完整 session 验收。high 与 low 对责任组件和其他问题仍有分歧，尚不能宣布质量非劣或把 high 当作标准答案。

最终组件、trace、session 提示词均包含现象、原因、引文一致性和“缺失 / 冲突 / 未核验”的区分要求。相关定向回归与 typecheck 已通过，包括实际 Pi → Host 原生提交先拒绝非法证据、再接受合法证据的集成用例；该用例验证 2 次内容提交、0 次文件错误且不创建草稿文件。责任链展示预算、实际引文登记、汇合链条和提示词也有定向覆盖。按使用者要求未运行全量测试，不声明全量回归通过；最后一次问财真实端到端验证未在这三轮 AIME 压测中补跑。

原始测量和结果保留于服务器 `/mnt/fin_bench/eval_data/1_aime/eval_output/test_eval/` 下的 `aime-opt-r1-high/low`、`aime-opt-r2b-high/low`、`aime-opt-r3b-high/low`。每个 run 的 `benchmark-window.json` 记录代码、版本和窗口，`benchmark-summary.json` 记录汇总，`results/attribution.jsonl` 为正式结论；正文未复制进 checkout。
