# 评测提示词

[模块地图](../../docs/modules/README.md) · [数据契约](../../docs/contract.md) · [评测质量](../../docs/quality.md)

所有内置 Agent 的模型可见规则、材料文案和工具描述只在本模块维护。其他文档链接到这里，不复制提示词。

## 资源与装配

| 位置 | 内容 |
|---|---|
| `resources/score/skill/` | 原skill评分规则、分档、校准与固定目录 |
| `resources/attribution/problem-output.md` | Trace、Session 共用的问题表达、字段分工与严重程度口径 |
| `resources/attribution/component-choice.md` | 具体动作定责、工具契约边界及相邻组件的选择规则 |
| `resources/instruction-review/default/` | 后置独立内部指令核验 |
| `resources/compact/` | 独立字段任务、value 类型示例、局部选号及代码回填引用约定 |
| `resources/compact/submit_evaluation.md` | 字段专用提交说明，明确空值也调用工具，不混入候选项规则 |
| `resources/<stage>/default/` | Criteria、Comparison、Rewrite、Clustering 默认规则 |
| `resources/comparison/verification/` | 独立首查与揭示后核验 |
| `resources/attribution/standard-*.md` | 显式开启标准答案复核时的规则 |
| `resources/attribution/conditional/` | 按本次材料发送的标准答案、数值、表格疑点与视觉规则 |
| `resources/workflow/` | Workflow 材料说明与改写语义约束 |
| `resources/tools/` | 评测工具描述 |
| `resources/shared/` | 材料边界、读者表达、焦点、预算和恢复 |
| `resources/eris/` | Eris 系统、预测、核对及工具规则 |
| [src/index.ts](src/index.ts) | 加载、渲染与公开入口 |

固定规则在系统提示词中发送一次。Attribution 分别说明本轮审查与跨轮审查要读的材料、判断方法及输出；Compact 是唯一组件目录；每个组件用独立任务检查自己的问题和相关 tool_errors，程序绑定名称；Trace 只总结合并结果，单轮 Session 由程序组装，多轮用一次轻量审查。部分组件失败不阻断 Trace，Trace 失败阻断 Session，短核查记录不进入正式输出。Compact 只提取当前字段，明确 value 类型和提交示例，仅允许固定浅层字段，所有 idx 由程序生成。任务消息只追加本次适用的条件规则、焦点、材料、预算和恢复信息。可信请求与模型展示投影分开，展示精简不改变业务校验或证据。装配与规则归属见[归因提示词](../../docs/attribution-prompt.md)。

Agent Profile 向 `agentPrompt` 显式传入 `fileSubmission`、`draftWriteInCallLimit` 与可选 `profile`；本模块据此渲染工具和预算，不根据阶段名称决定运行策略。

## 提示词写法

- 写清要读什么、判断什么、返回什么；使用真实字段和工具名。
- 同一规则只写一次：阶段负责判分含义，工具说明负责用法，Schema 负责形状。
- 只要求模型处理当前可见材料；身份绑定、排名派生和落盘由程序完成。
- 区分未知、失败与不适用，以及共同要求与本方私规；限制用具体条件表述。
- 恢复反馈指向实际可修字段与真实草稿，不编造证据、目录或剩余额度。

## 修改与验证

修改后构建并重启，运行中的 Worker 不热读文件。已接受结果保留，未完成任务使用新启动文本；判词变更及验证要求见[开发指南](../../docs/development.md#验证)。

测试检查资源来源、工具覆盖、实际装配、材料隔离与预算，不逐句锁定文风。材料与提示词变更使用固定样本做[真实模型实验](../../docs/quality.md#真实模型实验)，不增加归因效果复核环节；测试 fixture 不进入模型上下文。

Eris 通过 `erisPrompt(toolNames)` 和 [createEris](../../agent/src/core/profile.ts)装配；能力与维护入口见 [Eris](../../agent/README.md#修改-eris)。

Score的dimensions负责六轴联合取证、复算与评分，default负责独立总分，正常2次会话；evidence只做必要的统一补查，axis-t/e/l/a/u/d用于单轴定向重评，dimensions按score_axes覆盖多轴子集。机械字段由Score组装，最终总分不接收六轴数值分数。补查只输出事实引用与缺口，正文按需通过score_material读取；score_calculate用EV引用复算并自动登记结果，score_external使用Score专用代理传输。各会话复用累计来源、复算与核验预算；补查只重评新增事实影响的轴，影响无法隔离时才全量重评。
