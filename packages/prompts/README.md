# 评测提示词

[模块地图](../../docs/modules/README.md) · [数据契约](../../docs/contract.md) · [评测质量](../../docs/quality.md)

所有内置 Agent 的模型可见规则、材料文案和工具描述只在本模块维护。其他文档链接到这里，不复制提示词。

## 资源与装配

| 位置 | 内容 |
|---|---|
| `resources/score/skill/` | 原skill评分规则、分档、校准与固定目录 |
| `resources/attribution/taxonomy.json` | 责任技术域、功能组件、出错环节与八步业务调查的唯一目录 |
| `resources/attribution/problem-output.md` | Component、Session 共用的问题表达、字段分工与严重程度口径 |
| `resources/instruction-review/default/` | 后置独立内部指令核验 |
| `resources/<stage>/default/` | Criteria、Attribution、Comparison、Rewrite、Clustering 规则 |
| `resources/comparison/verification/` | 独立首查与揭示后核验 |
| `resources/attribution/standard-*.md` | 显式开启标准答案复核时的规则 |
| `resources/attribution/conditional/` | 按本次材料发送的标准答案、数值、表格疑点与视觉规则 |
| `resources/workflow/` | Workflow 材料说明与改写语义约束 |
| `resources/tools/` | 评测工具描述 |
| `resources/shared/` | 材料边界、读者表达、焦点、预算和恢复 |
| `resources/eris/` | Eris 系统、预测、核对及工具规则 |
| [src/index.ts](src/index.ts) | 加载、渲染与公开入口 |

固定规则在系统提示词中发送一次。Attribution 将需要的点评和证据原则合并进五步流程，不再次叠加共享文案；组件目录、责任链结构和字段填写细节不重复进入固定提示词。任务消息只追加本次适用的条件规则、焦点、材料、预算和恢复信息。可信请求与模型展示投影分开，展示精简不改变业务校验或证据。装配与规则归属见[归因提示词](../../docs/attribution-prompt.md)。

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
