# Attribution 提示词与任务分工

Attribution workflow 使用三个独立 profile，共用 `attribution/taxonomy.json` 的组件定义。模型只做技术审查和问题表达，身份、组件、证据坐标和最终结构由程序组装。

## Component

`attribution/component` 只审查一个 trace 中固定的工具或 skill 组件。材料包含完整 Q/A、执行导航和该 trace 的原始证据；提示要求按小现场查看调用前推理、参数、返回、下一轮实际输入和后续输出。

- 工具报错、空结果、零行、截断、缺返回和调用无结果必须作为问题候选。
- 首屏只展示有界材料；后续通过搜索原文和精确字段读取补齐必要证据，不以固定续读次数截断取证。
- 输出 `label`、`definition`、`problem_phenomena`、`reason`、`severity`、`severity_reason`、证据引用和可选计算文字。
- 不填写 `problem_id`、`component`、`position`、`quote`；这些由程序从任务和证据解析。

## Trace

`attribution/trace` 接收完整 Q/A 与组件已形成的 Problem，只输出 `summary`、`is_correct`、`correct_reason`。不新增、删除或改写组件问题；`is_correct` 使用 1/0/null。

## Session

`attribution/session` 的模型材料只包含完整、有序的原始 QA 和原文证据编号，不包含各 trace 的 summary、Problem 或正确性结论。它只关注跨问答的目标延续、上下文一致性、前后结论冲突和整体交付逻辑，输出 `session_summary` 与同 Problem 结构的 `session_problem`；已有 Trace 结果由程序原样回填到 `turns[]`。

`session_problem` 内部 evidence 使用 `{index, reason}` 引用 QA 原文的证据编号，复用原文校验与坐标解析机制，正式结果保留原始 trace、消息与文本路径。局部问题仅留在 `turns[]`，跨 QA 矛盾须由不同 QA 原文共同支持，合理的条件更新不算矛盾。

## 程序边界

- Component 与 Session 共用[问题表达与严重程度规则](../packages/prompts/resources/attribution/problem-output.md)：现象须独立说明具体偏差，定义可复用，理由说明证据支持的判断，严重程度理由说明已确认影响。Trace 与 Session 总结分别由各自提示词约束，不增加润色调用。
- 组件目录统一读取真实消息身份：明确命名的 planner/tool 保留名称；匿名 locator 归一成语义角色，`llm-call-*` 默认“中间推理处理”，其他无法识别 locator 归入“流程处理”，`final_answer` 才是“终稿生成轮”。相同最终内容不能证明某个匿名模型调用生成了终稿。
- 组件名称按 taxonomy 映射，未知工具保留真实名称。
- 证据 `position` 和 `component` 由原始坐标、消息类型、路径和固定组件生成，例如 `tool_call: finquery 取数服务` 或 `reasoning: 终稿生成轮`。
- `quote` 必须来自真实原文；提示词推荐不超过 400 字，提交校验宽容到 800 字。
- 长证据由工具切成不超过 400 字的连续片段；`quote_too_long` 反馈只允许替换 evidence index，不重写归因正文。
- component 和 trace 结果是内部任务，只进入运行状态与收据；最终只有 `attribution-session` 写 `attribution.jsonl`。
- 每个 trace 都必须有独立的“终稿生成轮”责任任务；匿名模型调用即使后接同内容 `final_answer` 也仍保留通用模型角色。

## 文件

- 固定提示：`packages/prompts/resources/attribution/{component,trace,session}/`
- 组件 taxonomy：`packages/prompts/resources/attribution/taxonomy.json`
- 提交与结果 Schema：`schemas/attribution/`
- 测试：`packages/workflows/src/attribution/`
