# 评测质量

[返回首页](../README.md) · [数据契约](contract.md) · [提示词](../packages/prompts/README.md)

本页定义如何验收结果。字段、工具动作和判分规则分别由 Schema、提示词与实现维护，不在这里复制。

## 三层验收

工程目标是常见场景判得可靠，遇到可能改变结论的关键冲突能识别并停下来。歧义题可以有多种合理解释；验收不要求每题都给出唯一胜者。

| 层次 | 判断依据 | 处理与通过条件 |
|---|---|---|
| 硬错误 | 身份串位、捏造证据、改写反转原意，或改变关键数字、主体、条件和确定性 | 必须阻断受影响结果的验收与放量。机械错误拒绝提交；已确认语义失真记 failed，不能因表达顺畅或固定前缀正确而通过。原始判词和失败记录保留。 |
| 关键冲突 | 标准不一致可能改变核心可用性、正式胜负，或使决定性依据失效 | 优先做有预算、有范围的定向复验。统一口径后按共同证据裁决；仍无法统一时定位冲突并进入 needs_review，停止排名。这种正确停止可以通过机制验收，裁决质量仍待核。 |
| 非决定性缺陷 | 去掉局部不严谨措辞或次要理由后，独立、充分的胜因仍成立，且不涉及硬错误 | 可以带缺陷通过，在审阅理由中指出缺陷及为何不影响结论；不用重复调用追求无瑕疵文案，也不把这项缺陷抬成决定性优势。 |

先检查硬错误，再检查剩余证据能否独立支持结论。问题条数、措辞激烈程度或单个 importance 标签不决定验收层次；不能用“只是表述问题”放过主体互换、否定丢失或证据伪造。无法判断影响时保留待核，不机械降级为轻微缺陷。

机制、裁决和覆盖分别报告：有效 needs_review 不算执行失败、平局或模型输赢；它仍没有产出正式裁决，不能补进已裁决或换位一致分母。判断是否正确停下，需要核对冲突确实影响结论；仅测试待核路由可用，不能宣称模型已能可靠识别冲突。复验受原预算和截止约束，不为单一歧义样本无限重试或继续堆提示词。

## 流程与科学边界

Criteria 共同检查项去重后合计5–12项，简单题通常5项，复杂题按独立要求增加；私有项不计入共同数量，三个数组连同私有项总计最多24项。任务完成、范围口径、事实准确、依据推理、表达可用性是对已有交付的核查角度，不新增回答段落、案例、步骤或穷举义务。各项检查不同内容，同一失误及后果只记一次问题，不因关联多个检查点放大严重程度。共同任务与质量来源须完整覆盖，可选项和禁令数组允许为空。本方规范仍由 Attribution 按实际触发行为独立核查。

Attribution 对证据充分的简单题在收尾一次写入结果文件；多轮调查才维护中间草稿。基本合规放在逐项结论，不为凑数量重复列为优点。质量缺陷关联到实际受影响的交付项，不要求另造通用质量项；没有真实关联时仍保留未绑定。性能验证必须同时审阅交付边界、证据和实质问题，不能只看条数或耗时下降。固定真实小样本覆盖简单题、复杂题与此前超时题，再决定是否恢复整批；模型档位、调用次数、超时及失败均须记录。

主线及可选分支见[归因与判决](contract.md#归因与判决)。合法引用、完整读取、提交被接受或模拟网关测试通过，只说明机械约束满足，不证明事实、归责和取舍正确。同一模型的独立会话仍可能重复同一种误判。

人工审阅必须检查：

- **要求**：按原题、实际指令的对象、期间、条件和例外验收，不把背景或中间值变成额外交付义务。
- **公平性**：私有规范只约束本方，横向比较使用共同任务与可比事实。未公开过程保持未知。
- **证据**：原始来源、模型实际输入与最终成品分别核查；采集缺口不等于候选缺陷，另一方答案不等于独立反证。
- **判定**：标准一致性、核心可用性和责任定位分开；局部错误不自动使整份交付不可用。
- **统计**：未完成、失败、待核和覆盖单列，成功样本不代表全部输入。Token 与单次时延不等于费用或长期性能。

Attribution 会拒绝实际证据全部落在已识别视觉采集占位块内的确定问题，包含只引用该块子串的情况。混有其他正文、执行或图像证据时仍需审查它们是否支持问题；门禁不证明成品正常，也不代替语义审阅。

标准答案复核仅在 standardAnswerReview 开启时适用。提请须有原始披露或完整数据复算的直接反证；独立复核还须确认双方所求结果一致。多个回答一致、更多小数位、工具复述或缺少来源均不能单独证明标准错误。标记不自动排除统计；消费方若另行排除，应对同题同标准统一处理并报告覆盖变化。

运行失败用同 run 恢复；语义错误先独立确认，修复后用新 run 限定受影响 case 与模型对重评。reviewQuestions 可记录待核问题，但不预置判词或强制改变已接受结果。

## 评语标准

读者应能从短评中看懂“实际交付 → 依据 → 差异 → 对使用的影响”。用日常语言，不展示内部字段、状态码和判据编号；必要业务代码与原文保留。

总评保留决定取舍的一至两项事实及必要反向证据，逐项点评写具体对象、行为与影响。未知说明缺少什么，不把调查未完成写成候选缺陷。不要按篇幅、工具次数、问题条数或引用数量投票。

改写须保留主体、数字、限定、确定性和已定取舍；“无已确认错误”不能扩大为“无错误”。判断不由润色修复。具体模型规则只维护在[共用表达要求](../packages/prompts/resources/shared/commentary.md)和[各阶段提示词](../packages/prompts/README.md)。

## 简短示例

以下仅示范表达，不作为可套用事实。

| 空泛写法 | 可核对的写法 |
|---|---|
| A 更完整 | 用户要五条记录；A 给齐五条，B 只给两条且未解释缺失。 |
| 双方各有优劣 | 双方都好：结果均可直接使用。更倾向 A，其附带说明少两处轻微笔误；B 多给的核算方法不改变结果。 |
| A 有代码，所以胜 | 双方都差：都未给实际回测结果。A 的可执行代码更接近所求交付，但仍未完成任务。 |

## 可校验的数值与实体对应

先统一对象、期间、单位和统计口径，再比较。对舍入争议，从可靠原始数据独立复算，并由同一未舍入值核对回答与标准；不要二次舍入或反推不存在的原值。

程序的 numeric matches、表格匹配和引用覆盖只是辅助观察。核查完整表头、单位、来源范围及已知反证；无可比来源保留未知。执行边界见[数值与实体核验](contract.md#数值与实体核验)，正反例见[数值目标测试](../packages/agents/src/attribution/numeric-targets.test.ts)和[计算测试](../packages/agents/src/attribution/numeric.test.ts)。

## 真实模型复核

提示词、模型或关键预算变化时，用新 run 执行预声明实验：

1. 固定题集、模型、底座、评测器和预算；覆盖有无标准、多轮、数值、工具、图片、双方可用、双方失败及材料不足。
2. 审阅者先看原题与来源独立判断，再与裁判对照，记录分歧和仍未知项；明确标注人工或代理审阅。
3. 两种 SDK 使用相同条件，检查底座一致性；显式交换 A/B 执行新评测，页面换位不算实验。
4. 在独立来源中只改一个关键事实，检查结论是否合理响应，不改固定回归来源。
5. 稳定性使用独立会话重复评测；重复次数和范围预先固定，区分单阶段与整链试次。分别报告结论分歧、失败、待核、未完成、耗时与用量；一个实验 run 可以保存多个独立试次。

计划任务接受覆盖以全部计划任务为分母，合法待核计为已接受，但不计为已裁决；首次提交通过率只描述有提交的任务，两者分开。因待核而未派发的改写保留 blocked 和零次尝试，不能写成模型执行失败。保留失败与续跑记录，不用增加重试掩盖校验耗尽。稳定不等于正确，目的性样本不能推断总体质量；实验记录随本次产物保存，不追加到长期指南。

## 改写放量验收

[固定题集](../packages/agents/src/rewrite/fixtures/quality.json)区分机械反例与语义标准；带 error_code 的条目由[测试](../packages/agents/src/rewrite/quality.test.ts)执行，其余须人工审阅。

1. 用 pilot-cases 小批运行，另核对主体串位、数字混入、偏好反转、相反私规、都好/都差及未知范围；日期分层不代替语义覆盖。
2. 执行 validate --selected --require-rewrite verdicts；需要逐项文案时加 --require-rewrite items。
3. 用 rewrite-review 对照整场原文、原偏好与改写。主体错误、事实扩大或偏好反转按硬错误阻断该改写验收，暂停放量并定向修复；仅有不影响原意的局部措辞问题可带缺陷通过。
4. 通过后用 discover-inputs 释放范围，逐级提高并发，观察新增正式交付、失败与返工。
5. 完成后不带 selected 验收，明确日期与槽位范围；机械通过不能称为全量语义通过。

## 后置稳定性实验

[validate-stability](usage.md#后置稳定性实验) 把重复、换位和改写分成独立试次。固定已接受归因的 Comparison 重复只检验裁决环节；整链重复才覆盖 Criteria 和 Attribution 的变化。五次稳定不能排除五次相同误判。

预声明样本、题目风险、选取方式、模型与执行条件、预算和截止时间。每题五次原位、五次换位使用独立会话并交错运行，结果按稳定模型身份还原。报告四类正式结论、核心状态、相对排名的变化及完整转移；待核、失败和未完成保留在分母。原位和换位同一模型的胜率按实际位置计算，平局不计胜。

统计独立单位是题目。区间按题目 bootstrap，随机种子固定；题目不足或没有观察到变异时明确给出原因，不输出伪确定区间。配对符号检验仅作探索性分析；类别判决没有连续质量分，t 检验不适用。混合模型、评测器或推理条件不合并推断；同 run 允许续跑换配置，条件记录保留实际端点、协议、模型、思考档位、上下文及输出上限、角色与缓存能力和执行策略，不保存密钥或凭据变量名。`p>0.05` 不能证明无偏，风险样本不代表生产总体。[ASA 的 p 值解释原则](https://www.amstat.org/asa/files/pdfs/P-ValueStatement.pdf)

改写语义审阅同时对照原槽位与新槽位，检查主体、数字、时间、条件、确定性、否定、相对倾向和责任是否改变；另评估是否用具体事实表达、是否省去套话。严重漂移按硬错误处理，发现一例即记录槽位、最小证据和未通过原因；可读性与保真分开验收。现有 semantic-review 记录即可表达结果：硬错误填 failed；语义保真但措辞仍有轻微缺陷填 passed，在 rationale 记录具体缺陷及不影响原意的依据。未审仍是未审，不根据理由关键词自动猜测层次，不新增状态。此审阅只评价改写保真，不认证源判词正确，也不跨 run 修改生产文案。代理审阅注明为代理审阅，不能冒充人工金标；未实际查看的图片不声明通过。语言简化的依据参考[清晰语言指南](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/)与[意义保留研究](https://aclanthology.org/2024.tacl-1.24/)，中文以本仓实际材料验收，不套用英语句长指标。

工程机制、样本质量和覆盖分别验收。结构合法、提示词更短、文本更顺、重复一致都不能单独成为公平通过的理由；实验不会用多数票覆盖主线判词。

## 离线回归与小样本入口

Criteria 交付边界、Attribution 等价核验与 Comparison 主理由的固定正反例见[语义审阅案例](quality-cases.md)。这些案例由人工或代理对照实际输出审阅，结构测试不保证语义反例被自动拒绝。

先 build:app。collect 从 debug 的 content_loaded 事件收集被拒草稿，保存真实内容和来源引用；不转换过期格式、不覆盖既有回归集。

```bash
npm run benchmark -- collect --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/pi-debug --output /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/regression/fixtures.json --limit 32
npm run benchmark -- replay --fixtures /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/regression/fixtures.json --output /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/regression/replay.json
npm run benchmark -- run --fixtures /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/regression/fixtures.json --run-id sample-pi --limit 4
```

run 默认预览，--execute 才调用模型；支持 --swap，须用新 ID。collect 的 limit 是草稿数，run 的 limit 是对比组数。失败草稿集不能估计生产首次通过率。

```bash
npm run benchmark -- compare --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/sample-pi \
  --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/sample-pi-swapped --output /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/regression/stability.json
```

compare 按业务题目与稳定模型对比结果、核心状态和依据，文本变化单列供人工核查。

## 矩阵、区间与人工金标

```bash
npm run benchmark -- summarize --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/RUN --bootstrap-rounds 2000
npm run benchmark -- gold-template --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/RUN --output /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/expert.json
npm run benchmark -- calibrate --run /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/RUN --gold /mnt/fin_bench/eval_data/0_wencai/eval_output/test_eval/expert.json
```

胜、负、都好、都差按对局统计；核心完成与标准一致性按 batch/case/version 去重。缺失与冲突保持未知，待核不算平局。重复 run 选择明确拒绝；模型、评测器和来源差异保留 cohort。

区间按业务 case 成簇 bootstrap；样本不足或无变异时不生成伪确定区间。区间只反映样本变动，不覆盖裁判系统性误判。胜1、负0、并列0.5只是汇总口径，不等于人类偏好或 Arena 排名。

金标模板不是金标。专家须填写 reviewer、rationale 与判定并明确 reviewed=true，校准才统计；一致率仍不能代替来源审查。
