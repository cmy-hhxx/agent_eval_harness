# 评测提示词

[模块地图](../../docs/modules/README.md) · [数据契约](../../docs/contract.md) · [评测质量](../../docs/quality.md)

所有内置 Agent 的模型可见规则、材料文案和工具描述只在本模块维护。其他文档链接到这里，不复制提示词。

## 资源与装配

| 位置 | 内容 |
|---|---|
| `resources/<stage>/default/` | Criteria、Attribution、Comparison、Rewrite、Clustering 规则 |
| `resources/comparison/verification/` | 独立首查与揭示后核验 |
| `resources/attribution/standard-*.md` | 显式开启标准答案复核时的规则 |
| `resources/workflow/` | Workflow 材料说明与改写语义约束 |
| `resources/tools/` | 评测工具描述 |
| `resources/shared/` | 材料边界、读者表达、焦点、预算和恢复 |
| `resources/eris/` | Eris 系统、预测、核对及工具规则 |
| [src/index.ts](src/index.ts) | 加载、渲染与公开入口 |

固定规则在系统提示词中发送一次；任务消息只放焦点、材料、预算和恢复信息。可信请求与模型展示投影分开，展示精简不改变业务校验或证据。

## 提示词写法

- 写清要读什么、判断什么、返回什么；使用真实字段和工具名。
- 同一规则只写一次：阶段负责判分含义，工具说明负责用法，Schema 负责形状。
- 只要求模型处理当前可见材料；身份绑定、排名派生和落盘由程序完成。
- 区分未知、失败与不适用，以及共同要求与本方私规；限制用具体条件表述。
- 恢复反馈指向实际可修字段与真实草稿，不编造证据、目录或剩余额度。

## 修改与验证

修改后构建并重启，运行中的 Worker 不热读文件。已接受结果保留，未完成任务使用新启动文本；判词变更及验证要求见[开发指南](../../docs/development.md#验证)。

测试检查资源来源、工具覆盖、实际装配、材料隔离与预算，不逐句锁定文风。语义变化用[真实模型复核](../../docs/quality.md#真实模型复核)验证；测试 fixture 不进入模型上下文。

Eris 通过 `erisPrompt(toolNames)` 和 [createEris](../../agent/src/core/profile.ts)装配；能力与维护入口见 [Eris](../../agent/README.md#修改-eris)。
