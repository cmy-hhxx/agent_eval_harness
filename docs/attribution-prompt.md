# Attribution 提示词与任务分工

Attribution workflow 使用三个独立 profile，共用 `attribution/taxonomy.json` 的组件定义。模型只做技术审查和问题表达，身份、组件、证据坐标和最终结构由程序组装。

## Component

`attribution/component` 只审查一个 trace 中固定的工具或 skill 组件。材料包含完整 Q/A、执行导航和该 trace 的原始证据；提示要求按小现场查看调用前推理、参数、返回、下一轮实际输入和后续输出。

- 工具报错、空结果、零行、截断、缺返回和调用无结果必须作为问题候选。
- 首屏只展示有界材料；后续最多三次续读，先 grep 原文，再按精确字段读取。
- 输出 `label`、`definition`、`problem_phenomena`、`reason`、证据引用和可选计算文字。
- 不填写 `problem_id`、`component`、`position`、`quote`；这些由程序从任务和证据解析。

## Trace

`attribution/trace` 接收完整 Q/A 与组件已形成的 Problem，只输出 `summary`、`is_correct`、`correct_reason`。不新增、删除或改写组件问题；`is_correct` 使用 1/0/null。

## Session

`attribution/session` 只接收 QAQAQA 和各 trace 的评测输出。它关注跨问答的目标延续、上下文一致性、前后结论冲突和整体交付逻辑，输出 `session_summary` 与同 Problem 结构的 `session_problem`。

`session_problem` 必须引用已有 trace Problem 作为证据来源，不重新读取原始轨迹，也不能凭空新增不可追溯证据。

## 程序边界

- 组件目录优先读取 `trace.meta.tool_names_text` 与 `skill_names_text`，为空时从实际调用派生。
- 组件名称按 taxonomy 映射，未知工具保留真实名称。
- 证据 `position` 和 `component` 由原始坐标、消息类型、路径和固定组件生成，例如 `tool_call: finquery 取数服务` 或 `reasoning: 终稿生成轮`。
- `quote` 必须来自真实原文且不超过 400 字。
- component 和 trace 结果是内部任务，只进入运行状态与收据；最终只有 `attribution-session` 写 `attribution.jsonl`。

## 文件

- 固定提示：`packages/prompts/resources/attribution/{component,trace,session}/`
- 组件 taxonomy：`packages/prompts/resources/attribution/taxonomy.json`
- 提交与结果 Schema：`schemas/attribution/`
- 测试：`packages/workflows/src/attribution/`
