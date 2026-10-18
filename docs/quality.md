# 评测质量

[返回首页](../README.md) · [数据契约](contract.md) · [提示词](../packages/prompts/README.md)

本页定义如何验收结果。字段、工具动作和判分规则分别由 Schema、提示词与实现维护，不在这里复制。

## 流程与科学边界

主线及可选分支见[归因与判决](contract.md#归因与判决)。合法引用、完整读取、提交被接受或模拟网关测试通过，只说明机械约束满足，不证明事实、归责和取舍正确。同一模型的独立会话仍可能重复同一种误判。

人工审阅必须检查：

- **要求**：按原题、实际指令的对象、期间、条件和例外验收，不把背景或中间值变成额外交付义务。
- **公平性**：私有规范只约束本方，横向比较使用共同任务与可比事实。未公开过程保持未知。
- **证据**：原始来源、模型实际输入与最终成品分别核查；采集缺口不等于候选缺陷，另一方答案不等于独立反证。
- **判定**：标准一致性、核心可用性和责任定位分开；局部错误不自动使整份交付不可用。
- **统计**：未完成、失败、待核和覆盖单列，成功样本不代表全部输入。Token 与单次时延不等于费用或长期性能。

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

程序的 numeric matches、表格匹配和引用覆盖只是辅助观察。核查完整表头、单位、来源范围及已知反证；无可比来源保留未知。执行边界见[数值与实体核验](contract.md#数值与实体核验)，正反例见[数值测试](../packages/agents/src/attribution/numeric-quality.test.ts)和[表格测试](../packages/agents/src/attribution/table-quality.test.ts)。

## 真实模型复核

提示词、模型或关键预算变化时，用新 run 执行预声明实验：

1. 固定题集、模型、底座、评测器和预算；覆盖有无标准、多轮、数值、工具、图片、双方可用、双方失败及材料不足。
2. 人工先看原题与来源独立判断，再与裁判对照，记录分歧和仍未知项。
3. 两种 SDK 使用相同条件，检查底座一致性；显式交换 A/B 执行新评测，页面换位不算实验。
4. 在独立来源中只改一个关键事实，检查结论是否合理响应，不改固定回归来源。
5. 稳定性至少三次独立 run；分别报告结论分歧、失败、待核、未完成、耗时与用量。

执行成功率以全部计划任务为分母；首次提交通过率只描述有提交的任务，两者分开。保留失败与续跑记录，不用增加重试掩盖校验耗尽。稳定不等于正确，目的性样本不能推断总体质量；实验记录随本次产物保存，不追加到长期指南。

## 改写放量验收

[固定题集](../packages/agents/src/rewrite/fixtures/quality.json)区分机械反例与语义标准；带 error_code 的条目由[测试](../packages/agents/src/rewrite/quality.test.ts)执行，其余须人工审阅。

1. 用 pilot-cases 小批运行，另核对主体串位、数字混入、偏好反转、相反私规、都好/都差及未知范围；日期分层不代替语义覆盖。
2. 执行 validate --selected --require-rewrite verdicts；需要逐项文案时加 --require-rewrite items。
3. 用 rewrite-review 对照整场原文、原偏好与改写。主体错误、事实扩大或偏好反转出现即暂停放量，定向修复。
4. 通过后用 discover-inputs 释放范围，逐级提高并发，观察新增正式交付、失败与返工。
5. 完成后不带 selected 验收，明确日期与槽位范围；机械通过不能称为全量语义通过。

## 离线回归与小样本入口

先 build:app。collect 从 debug 的 content_loaded 事件收集被拒草稿，保存真实内容和来源引用；不转换过期格式、不覆盖既有回归集。

```bash
npm run benchmark -- collect --run data/runs/comparison/pi-debug --output .artifacts/regression/fixtures.json --limit 32
npm run benchmark -- replay --fixtures .artifacts/regression/fixtures.json --output .artifacts/regression/replay.json
npm run benchmark -- run --fixtures .artifacts/regression/fixtures.json --run-id sample-pi --limit 4
```

run 默认预览，--execute 才调用模型；支持 --engine prime 和 --swap，须用新 ID。collect 的 limit 是草稿数，run 的 limit 是对比组数。失败草稿集不能估计生产首次通过率。

```bash
npm run benchmark -- compare --run .artifacts/model-benchmarks/sample-pi \
  --run .artifacts/model-benchmarks/sample-pi-swapped --output .artifacts/regression/stability.json
```

compare 按业务题目与稳定模型对比结果、核心状态和依据，文本变化单列供人工核查。

## 矩阵、区间与人工金标

```bash
npm run benchmark -- summarize --run data/runs/comparison/RUN --bootstrap-rounds 2000
npm run benchmark -- gold-template --run data/runs/comparison/RUN --output .artifacts/expert.json
npm run benchmark -- calibrate --run data/runs/comparison/RUN --gold .artifacts/expert.json
```

胜、负、都好、都差按对局统计；核心完成与标准一致性按 batch/case/version 去重。缺失与冲突保持未知，待核不算平局。重复 run 选择明确拒绝；模型、评测器和来源差异保留 cohort。

区间按业务 case 成簇 bootstrap；样本不足或无变异时不生成伪确定区间。区间只反映样本变动，不覆盖裁判系统性误判。胜1、负0、并列0.5只是汇总口径，不等于人类偏好或 Arena 排名。

金标模板不是金标。专家须填写 reviewer、rationale 与判定并明确 reviewed=true，校准才统计；一致率仍不能代替来源审查。
