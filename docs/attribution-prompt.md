# 归因提示词与规则归属

Attribution 使用固定五步流程：确定公开任务和调查范围、核实疑点、沿真实边界定位责任、形成一致判定、收敛并提交。所有模型可见文案由 [packages/prompts](../packages/prompts/README.md) 提供；业务实现不内嵌规则文本。

## 实际装配

| 部分 | 来源与作用 |
|---|---|
| 固定 system | `attribution/default/system.md` 与 `instructions.md`；包含五步流程、唯一责任决策表、证据强度、点评和停止条件，不再次叠加共享 commentary/evidence |
| 本次适用规则 | `attributionConditionalRules` 按已有材料选择 `attribution/conditional/`，由 Attribution 的 `renderPrompt` 放在任务材料之前；不改变固定 system 或运行协议 |
| 任务材料 | 保留任务焦点、原始证据导航、真实执行转换与去重来源导航、适用规则和预算；材料本身不是指令或判决 |
| 工具说明 | 通用工具使用集中说明；直接提交的 Attribution 使用本阶段 `execute_code.md`，仅用于有界提取和计算，不要求不存在的草稿编辑工具 |
| 提交契约 | `attributionSubmissionSchema` 按请求缩窄根 Schema，实际交给 Worker/SDK 的提交工具；必填项、类型、额外字段和枚举由 Schema 严格约束 |
| 业务验收 | 证据坐标、阅读覆盖、责任主体、边界、问题保留与完成状态仍由业务校验拒收；提示词不替代验收 |

其他 Agent 继续使用各自规则与共享点评/证据说明；归因重构不改变它们的流程。

## 条件规则

| 已有材料条件 | 下发规则 |
|---|---|
| `ground_truth.available` | 标准答案语义核对及正确性字段 |
| 有标准且 `numeric_references` 非空 | 直接点值、量纲、舍入与问题内必要计算 |
| `answer.table_check_results` 任一项有疑点 `rows` | 相关问题的独立来源与行号规则 |
| `answer.final_images.image_count > 0` | 全部图片实际查看及观察填写 |
| `answer.capture_gaps` 非空 | 视觉采集缺口与用户真实交付的区别 |

无标准答案仍核查一般事实、计算和交付。无表格疑点仍核查普通表格事实，只不发送表格疑点细则。无可查看图像时不凭采集占位判渲染失败。条件资源不包含新验收要求，也不修改输入材料。

## 决策与程序边界

归责时区分参数生成、执行返回、整理传递、生成新增、渲染交付、恢复和真正缺失的处理记录。它要求先看真实请求和前后边界，不将最后接收者替代未知整理者，不将 shell 等执行载体自动当成内部业务实现。关联责任需独立作用证据，不按分布或数量分配。

每条问题使用 `problem_id/text/reason/evidence_status/evidence/responsibility_boundary/component/attribution_reason`，有真实缺口时增加 `uncertainties`，确有独立传播或放大时增加 `related_responsibilities`，依赖计算时增加 `calculations`。问题编号、主体名称和证据坐标由程序填写；模型只选稳定编号并写判断。`evidence_status` 为“已确认”或“待核实”，与责任是否已知分开。证据原文去重，`purposes` 标注“问题”“归因”或两者。关联责任只保留一层主体—理由—证据关系。仅有输入输出差异不证明隐藏机制；已知参数生成调用不能因无隐藏推理而写未知。

围绕具体疑点读取证据，完成后提交并在同一会话核对遗漏，不维护重复检查表。动态必读的受保护额度、页数和字符上限、内容修复次数、有界停止及失败原因由 Host/Worker 实现；模型不能通过改称“未采集”、删问题或重复提交绕过它们。

## 验证

资源测试验证实际装配与条件选择，提交测试验证字段契约和业务约束。提示长度仅作测量，不设压缩比例硬门槛。行为变化用固定样本对照：比较证据是否支持责任定位、误报/漏报、首次内容提交通过率、修复与任务重试次数及耗时；不能把更细的展示名称当作主体分布改善。

正式顶层只有 meta、summary、Problem、has_standard_answer、is_correct、correct_reason；模型不填写程序身份或无标准时的空正确性字段。不要求优点、逐项评分表、核心完成表或维度分类。摘要必须概括已登记判断，不能掩盖缺失问题；不完整任务由既有state记录失败，技术接收与有效评审分别统计。
