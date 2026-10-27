# Session 归因

Attribution 是独立 workflow，入口为 `workflow: "attribution"`。输入扫描以一行为一个 session；一个 session 保留全部 trace，任何 trace 没有完整最终回答时整条 session 过滤。Score、Rewrite、Instruction Review 和 Clustering 都不属于这条 workflow。

AIME 的 `4_daily_eval_slim` JSONL 可以直接作为输入。每个 trace 的 `message_pool` 和 `tool_sets` 在输入边界按索引恢复：保持消息顺序、对象字段顺序和原始证据路径，不改写正文，不另存展开后的输入文件。重复消息共享内存中的对象，内部规范投影也复用共享结构；缺失、越界或非整数引用报错，不把坏引用当成空材料。未使用共享池的 trace 保持原样。

## 任务结构

```text
session input
→ attribution-component（每个 trace 的每个 tool/skill 组件）
→ attribution-trace（合并该 trace 的组件问题并判定正确性）
→ attribution-session（跨 QA 汇总）
→ results/attribution.jsonl（仅 session 任务导出一行）
```

组件统一从 `traceComponentIdentities` 的真实消息执行目录派生：明确命名的 planner/tool 保留名称；`llm-call-*`、span、UUID 等执行 locator 不原样进入组件，而是归一为“中间推理处理”或“流程处理”；只有 `final_answer` 明确表示终稿交付，不能因匿名模型调用与其内容相同就推定该调用是“终稿生成轮”。每个 trace 都保证一个独立的“终稿生成轮”任务，同名语义组件按名称去重。同名工具在多个 trace 中分别审查。内部任务只保留在 `state.json` 与收据中，不写独立结果文件。

调度按输入 `input_id` 分成 session 前台窗口，`execution.sessionWindow` 默认同时准入 16 个未结束 session。窗口内的 component、trace、session 任务继续推进；窗口外 session 的 component 不进入执行槽位。session 完成、失败或 blocked 后释放窗口，后续 session 才获准进入。ready 的 trace 和 session 任务优先于其他 session 的 component backlog。准入状态完全从任务的持久化状态推导，执行、进度和续跑共用同一配置值，续跑不依赖内存游标，也不允许 component backlog 占满全部任务槽位而饿死下游汇总。

运行进度同时保留 component、trace、session 任务计数，并单独报告 `total_sessions`、`active_sessions`、`completed_sessions`、`waiting_sessions`、`failed_sessions`、`blocked_sessions`。业务完成度以 `completed_sessions` 为准，不能用内部 component 的 accepted 数代替。

每个 `attribution-session` 收据接受后立即追加到 `results/attribution.jsonl`，不等待同一 run 的其他 session；续跑读取既有行并跳过已导出的 session。

独立 Attribution 和 Comparison 内的归因在新建、续跑时共用同一原始输入与 trace 投影；组件提交仍按对应 trace 的原文核验证据。trace、session 汇总不向 Worker 暴露原始来源，但恢复时仍保留其所属输入身份。

## 小现场

首屏的 `component_entrypoints` 提供当前固定组件前八个已知调用的 `read_responsibility_chain` 入口，省去重复枚举全局执行目录；`component_entrypoints_total` 显示总数，剩余调用继续从完整导航读取。它只提供导航，不是结论或完整调用清单；入口为空仍须核查原文。完整执行导航、跨组件因果材料和原始证据继续可读，证据校验不因入口提示而放宽。

归因导航允许模型在同一轮请求多个独立证据片段，提示词要求每轮最多四个，并将提交与读取分开。Pi 仍逐个执行工具，按实际调用登记证据、扣除读取预算；预算耗尽后不再允许批量工具请求。合并读取不减少材料范围，也不放宽原文引用和提交校验。

固定样本、对照命令与吞吐验收口径见[归因可靠性验证](attribution-reliability.md)。

组件审查按“原问上下文 → 调用前推理 → 工具参数 → 工具返回 → 下一轮实际输入 → 下一轮推理/输出”阅读。首屏材料有输出上限，超大返回只给结构、状态和可定位片段；后续最多三次续读，优先使用 `search_trace` 做字面 grep，再按精确路径读取。

零行、空返回、工具报错、返回截断、缺返回和调用无结果都属于必须审查的技术问题。证据必须引用真实原文；图片使用 `view_image` 并记录观察。模型不选择全局责任编号，组件由任务固定。

内部规范隔离产生的展示占位符不能作为原始执行失败的依据。组件结果虽然只导出位置与引文，Host 仍从本次提交的证据编号恢复内部坐标，逐字核对原始输入后才接受收据；非法引用反馈定位到对应 `evidence[].index`，不会泄漏被隔离的原文。

## 正式契约

```json
{
  "session_meta": {},
  "turns": [
    {
      "meta": {},
      "summary": "",
      "problem": [],
      "is_correct": 1,
      "correct_reason": ""
    }
  ],
  "session_summary": "",
  "session_problem": []
}
```

`session_meta` 与每个 `turns[i].meta` 直接保留输入值。`is_correct` 使用 `1` 表示与标准一致、`0` 表示不一致、`null` 表示没有标准或无法据给定标准判断。turn 和 session 的 Problem 同形：

```json
{
  "problem_id": "p1",
  "component": "finquery 取数服务",
  "label": "零行结果未识别",
  "definition": "应返回数据的查询返回零行，后续仍据此形成事实结论。",
  "problem_phenomena": "第一问把零行取数结果当成有数据支持。",
  "reason": "工具请求查询 X，原始返回为零行，下一轮仍给出肯定结论。",
  "evidence": [
    {
      "position": "trace_index 0 / message_index 3 / path /output/0/text",
      "component": "tool_call: finquery 取数服务",
      "quote": "为您找到0条数据",
      "reason": "证明工具返回零行。"
    }
  ],
  "calculations": [
    { "text": "计算错误：将 5.89 亿元误写成 589 亿元，放大了 100 倍。" }
  ]
}
```

`quote` 推荐不超过 400 字；工具只暴露 ≤400 字的可提交编号，校验宽容到 800 字。引文必须是精确连续原文，不能拼接或由程序截断。`evidence.component` 明确区分 `reasoning:`、`tool_call:`、`answer:` 等证据位置及具体组件。`calculations` 只保留文字点评，不再嵌套操作数和复算元数据。

Component 提交在 Schema 与证据坐标校验之外，会硬拒绝占位/空泛内容、全部字段重复同一文本和内容完全相同的重复 Problem。语义相近或非关键重复只作为修复提示，不单独耗尽任务。证据工具只暴露可解析且不超过 400 字的推荐引用；校验接受到 800 字，超过时反馈 2–3 个真实原文片段的新编号，要求只替换 evidence。校验不会改写或截断 quote，正式证据仍按原坐标解析；重叠但原因、影响范围或修复动作不同的问题不应合并。

## Trace 与 Session 汇总

Trace 汇总读取完整 Q/A 和组件 Problem，输出 `summary`、`is_correct`、`correct_reason`，不改写组件问题。Session 汇总只读取 QAQAQA 与各 trace 评测输出，不读取完整原始轨迹；它输出 `session_summary` 与同 Problem 结构的 `session_problem`，证据引用已有 trace Problem。

## Comparison

Comparison 是另一个独立 workflow，按整场 session 比较，不逐 trace 判胜。材料始终是 `turns[]`；单轮和多轮走同一套材料、证据和比较逻辑，仅渲染时允许紧凑展示。Attribution 结果提供整场总结、turn 问题和 session 问题，用于识别最终交付与跨问答逻辑。

## 验证

开发运行 `npm run typecheck` 和 `npm test`；提交前运行 `npm run test:full`；涉及 Worker/SDK 时运行 `npm run test:integration`。真实样本必须覆盖多 trace、空工具返回、零行、工具报错、截断和最终回答缺失过滤。
