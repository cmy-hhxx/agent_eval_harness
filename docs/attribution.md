# Session 归因

Attribution 是独立 workflow，入口为 `workflow: "attribution"`。输入扫描以一行为一个 session；一个 session 保留全部 trace，任何 trace 没有完整最终回答时整条 session 过滤。Score、Rewrite、Instruction Review 和 Clustering 都不属于这条 workflow。

## 任务结构

```text
session input
→ attribution-component（每个 trace 的每个 tool/skill 组件）
→ attribution-trace（合并该 trace 的组件问题并判定正确性）
→ attribution-session（跨 QA 汇总）
→ results/attribution.jsonl（仅 session 任务导出一行）
```

组件优先来自 `trace.meta.tool_names_text` 与 `skill_names_text`；字段为空时从真实工具调用派生。同名工具在多个 trace 中分别审查。内部任务只保留在 `state.json` 与收据中，不写独立结果文件。

调度按输入 `input_id` 分成 session 前台窗口，默认同时准入 8 个未结束 session。窗口内的 component、trace、session 任务继续推进；窗口外 session 的 component 不进入执行槽位。session 完成、失败或 blocked 后释放窗口，后续 session 才获准进入。ready 的 trace 和 session 任务优先于其他 session 的 component backlog。准入状态完全从任务的持久化状态推导，续跑不依赖内存游标，也不允许 component backlog 占满全部任务槽位而饿死下游汇总。

运行进度同时保留 component、trace、session 任务计数，并单独报告 `total_sessions`、`active_sessions`、`completed_sessions`、`waiting_sessions`、`failed_sessions`、`blocked_sessions`。业务完成度以 `completed_sessions` 为准，不能用内部 component 的 accepted 数代替。

每个 `attribution-session` 收据接受后立即追加到 `results/attribution.jsonl`，不等待同一 run 的其他 session；续跑读取既有行并跳过已导出的 session。

## 小现场

组件审查按“原问上下文 → 调用前推理 → 工具参数 → 工具返回 → 下一轮实际输入 → 下一轮推理/输出”阅读。首屏材料有输出上限，超大返回只给结构、状态和可定位片段；后续最多三次续读，优先使用 `search_trace` 做字面 grep，再按精确路径读取。

零行、空返回、工具报错、返回截断、缺返回和调用无结果都属于必须审查的技术问题。证据必须引用真实原文；图片使用 `view_image` 并记录观察。模型不选择全局责任编号，组件由任务固定。

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

`quote` 最多 400 字，必须是精确连续原文，不能拼接或由程序截断。`evidence.component` 明确区分 `reasoning:`、`tool_call:`、`answer:` 等证据位置及具体组件。`calculations` 只保留文字点评，不再嵌套操作数和复算元数据。

Component 提交在 Schema 与证据坐标校验之外，还会拒绝占位、空泛或重复叙述：`tmp`/`test`/`todo`/`占位` 等占位值、纯重复字符、`problem_phenomena` 与 `reason` 原句重复、不同 evidence 复制同一 reason、全部字段重复同一文本，以及内容完全相同的重复 Problem。校验不会改写或截断 quote，正式证据仍按原坐标解析；重叠但原因、影响范围或修复动作不同的问题不应合并。

## Trace 与 Session 汇总

Trace 汇总读取完整 Q/A 和组件 Problem，输出 `summary`、`is_correct`、`correct_reason`，不改写组件问题。Session 汇总只读取 QAQAQA 与各 trace 评测输出，不读取完整原始轨迹；它输出 `session_summary` 与同 Problem 结构的 `session_problem`，证据引用已有 trace Problem。

## Comparison

Comparison 是另一个独立 workflow，按整场 session 比较，不逐 trace 判胜。材料始终是 `turns[]`；单轮和多轮走同一套材料、证据和比较逻辑，仅渲染时允许紧凑展示。Attribution 结果提供整场总结、turn 问题和 session 问题，用于识别最终交付与跨问答逻辑。

## 验证

开发运行 `npm run typecheck` 和 `npm test`；提交前运行 `npm run test:full`；涉及 Worker/SDK 时运行 `npm run test:integration`。真实样本必须覆盖多 trace、空工具返回、零行、工具报错、截断和最终回答缺失过滤。
