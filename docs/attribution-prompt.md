# 归因提示词与规则归属

Attribution 使用固定五步：核对实际交付、核实具体疑点、从真实调用选择责任边界、形成一致结果、写文件并提交。模型只做语义判断，程序负责身份、结构、证据坐标和责任链投影。

## 实际装配

| 部分 | 来源与作用 |
|---|---|
| 固定 system | `attribution/default/system.md` 与 `instructions.md`；声明角色、五步工作顺序、缺陷与责任判据、标准答案语义和停止条件 |
| 本次适用规则 | `attributionConditionalRules` 按已有材料选择 `attribution/conditional/`，由 Attribution 的 `renderPrompt` 放在任务材料之前 |
| 任务材料 | 保留任务焦点、原始证据导航、真实执行转换、去重来源导航和本次可用的责任边界；材料本身不是指令或判决 |
| 工具说明 | 说明读取、计算和文件编辑参数；不重复固定决策规则 |
| 提交契约 | `attributionSubmissionSchema` 按请求缩窄根 Schema，必填项、类型、额外字段和枚举由 Schema 严格约束 |
| 正式结果 | 程序解析证据、组件、问题编号和身份，并从模型选择的 boundary 与相关证据派生 `responsibility_chain` |

## 模型与程序边界

模型提交 `summary`、`Problem`，有标准答案时再提交 `is_correct` 和 `correct_reason`。每条 Problem 由模型决定：

- 缺陷文本、证据理由及其是否成立；
- 主责任 boundary，以及有独立作用证据时的一个或多个关联责任 boundary；
- 归因理由、真实缺口和必要计算；
- 问题证据、归因证据及其用途。

程序生成 `meta`、`has_standard_answer`、问题编号、组件名称、证据坐标和值，以及正式 `responsibility_chain`。模型不填写组件名称或责任链结构。责任链按所选 boundary 及其命中问题证据的实际上游转换生成；正常传递只作为上下文，不成为责任主体。

`responsibility_boundary` 只接受工具返回的 `boundary:<transition_index>`，不接受节点编号或裸数字。正式结果不输出该内部字段。责任无法由证据确定时，保留问题草稿并结束为未完成，不能改归终稿、删除缺陷或编造主体。

## 条件规则

| 已有材料条件 | 下发规则 |
|---|---|
| `ground_truth.available` | 标准答案一致性及正确性字段 |
| 有标准且 `numeric_references` 非空 | 直接点值、量纲、舍入与问题内必要计算 |
| `answer.table_check_results` 任一项有疑点 `rows` | 相关问题的独立来源与行号规则 |
| `answer.final_images.image_count > 0` | 全部图片实际查看及观察填写 |
| `answer.capture_gaps` 非空 | 视觉采集缺口与用户真实交付的区别 |

无标准答案仍核查一般事实、计算和交付。无表格疑点仍核查普通表格事实，只不发送表格疑点细则。无可查看图像时不凭采集占位判渲染失败。

## 验证

资源测试验证固定规则、条件选择与工具覆盖；提交测试验证实际 Schema、责任边界选择和程序派生责任链。提示长度只作测量，不设压缩比例硬门槛。行为变化用固定真实样本对照：缺陷误报与漏报、责任边界一致性、首次内容提交通过率、修复与任务重试次数及耗时。结构合法或提示词更短都不能单独作为通过依据。

最终顶层只有 `meta`、`summary`、`Problem`、`has_standard_answer`、`is_correct`、`correct_reason`。已接受结果的正式字段和语义不因内部提交简化而减少。
