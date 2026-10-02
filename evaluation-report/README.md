# 评测汇报

独立的离线前端模块。页面和构建器不导入业务代码，不访问模型、数据库或网络。

## 页面与维护

四个主题使用一级导航。每个主题的重点直接展示。机制图默认完整展开，悬停或键盘聚焦可突出关联，点击区域可放大，点击匿名映射可交换 A/B；不需要操作即可阅读完整流程。

| 主题 | 直接展示 |
|---|---|
| 流程 | 真实题目的原始回答、证据与正式判决贯穿两条材料泳道；共同标准、匿名换位和逐项对照直接呈现；条件复核及独立后处理列为通用流程 |
| 判决规则 | 核心可用性与实质差距的结果映射、真实案例的判决依据和控制边界 |
| 提示词 | 五个 Agent 的原文节选与约束；共用文案和工具资源。完整 23 份原文可下载为 TXT |
| 实验 | 单独标明版本的真实运行产出、语义复核状态、四类待验证实验和工程机制测试 |

| 文件 | 职责 |
|---|---|
| `index.html` | 主题结构与固定内容 |
| `src/tokens.css` | 黑、白、灰及一种强调色；字号、圆角与动效参数 |
| `src/styles.css` | 页面、表格、机制图的视觉样式、响应式与打印布局 |
| `src/data.js` | 真实案例与其原始出处；人工核对后的提示词、配置上限、聚合结果和来源快照 |
| `src/flow.js` | 命名 SVG 对象、两条材料泳道、连线、案例内容布局及匿名身份绑定 |
| `src/icons.js` | 内嵌 Phosphor 矢量符号及 MIT 许可；图中仅用小型交换符号，无外部加载 |
| `src/diagram-interaction.js` | 区域关联、局部缩放、键盘操作与焦点恢复 |
| `src/motion.js` | 可取消的原生转场；遵循减少动态效果及打印偏好 |
| `src/app.js` | 一级导航、静态数据渲染与提示词原文下载 |
| `build.mjs` | 仅合并本目录的 2 份 CSS 和 6 份 JS |
| `report.html` | 构建产物，不直接编辑 |

双击 `index.html` 可维护预览，无需服务器。只保留浅色主题，不显示英文副标题、页脚入口或总结性导语。宽屏机制图按从左到右的主线呈现，窄屏自动折为两行并重排连线，保留较大的文字；所有内容仍在同一个主题页。区域缩放同时适配两套坐标，跨断点会恢复总览。其他主题在窄屏自然纵向排列，正文不藏在展开操作后。

## 构建与验证

```bash
node evaluation-report/build.mjs
node evaluation-report/build.mjs --output /tmp/evaluation-briefing.html
node --test evaluation-report/build.test.mjs
node --test evaluation-report/interaction.test.mjs
```

构建、快照和交互测试只依赖已入库的汇报文件；另一个来源核对用例在本地原始输入与运行结果齐备时逐条校验，缺失时明确跳过，不影响干净 checkout。原始记录中的 `version` 使用来源名称（如 `A Expert`），与 Workflow 的内部 ID（如 `a_expert`）分别保留。

`report.html` 可单独复制到其他电脑离线展示，包含全部主题与静态数据快照。页面不提供 HTML 导出按钮，也不显示流程页右上角的范围说明；交付文件由构建器生成。提示词原文 TXT 包含全部 23 份资源的名称、路径和原始文本。浏览器打印只输出当前主题，默认 A4 横向。

图内点击区域与材料连线分开定义。放大后可点击同一区域、按 Escape 或使用“返回总览”复原；方向键和 Home / End 在区域间移动，Enter / Space 执行动作。A/B 交换同步改变材料身份、矩阵表头与赢家代号，获胜的原始回答保持不变；证据与比较结论不随代号变化。此操作仅演示匿名映射，不运行裁判、不产生新的盲测结果，也不修改评测数据。重新打开 HTML 时恢复完整图和默认 A/B；打印恢复全图。动效遵循系统减少动态效果偏好。

## 数字与来源

页面中的数字按来源分别解释：

1. **流程规模与配置限制**：报告原有 r65 配置快照；一套共同标准、两条独立归因、每组一场两两对比；判据最多 24 条，单回答发现合计最多 8 条，独立归因复核最多 1 轮。问题库每模型活跃类最多 80，单任务新增最多 8（实际预算可能更小），达到 60 类提示整理。它们不是评测准确率，也不标识下述真实案例的评测器版本。
2. **实验页运行产出**：`eval-20261002-r64-quality` 的聚合快照，上海时间 2026-10-02 17:30:22 核对，运行终止于 17:21:14。3 题、8 回答、4 计划对局，1 正式对局，涉及 1 题。不能据此推断总体胜率或 r65 的效果，也不包含流程页案例所属运行。
3. **工程机制验证**：2026-10-02 针对性测试 38/38，通过范围为盲测映射 4、提示词与 Criteria 12、判决和独立复核 13、统计与金标协议 9。它们不替代真实裁判换位、消融或人工一致率实测。

### 流程页真实案例

案例 `客观题2500条补充_带标准答案_with_gt_客观题_01868` 来自 2026-09-25 批次，题目为“从2019年到2020年，中国银河证券股份有限公司转融通融入资金的平均利率增长了多少百分点？”，原始标准答案为 `-0.6个百分点`。正式结果位于 `eval-20261002-r68-quality`，本条 Criteria、两条 Attribution 和 Comparison 的 `evaluatorVersion` 均为 **r69**，裁判为 MiniMax-M3，判决于上海时间 2026-10-02 22:04:40 被接收。run 名称中的 r68、报告配置与提示词的 r65 快照、实验页的 r64 聚合结果分别保留各自含义，不相互替代。

回答①是 A组Expert，主结论为自选“利息支出÷期末余额”测算口径下的 `+1.25 个百分点`；回答②是 B组Expert，按年末利率区间中值近似给出 `−0.60 个百分点`。正式结果以本题标准口径判回答②胜，原始匿名映射为 `A=B组Expert、B=A组Expert`。两份输入都包含 2019 年末 3.25%、2020 年末 2.50%–2.80% 的来源材料；回答①也列出了期末利率下降，不能描述为未找到原始数值或减法算错。

页面复算 `(2.50% + 2.80%) ÷ 2 − 3.25% = −0.60 个百分点` 时保留“区间中值近似”限定。这不是公司直接披露的全年加权平均利率。页面摘录可回溯的核心数值判断，不宣称本条 r69 结果已通过完整语义审查；其非决定性文案仍存在条件性风险提示处理、对回答①已有内容描述不准等问题。对同输入的 r66 本地诊断不能作为 r69 全量通过的证明。

本例没有已接受的归类或改写产物，该 run 对这两项均未启用。页面中的复核、问题归类与评语润色均作为通用流程呈现，不虚构本例触发了复核、生成了问题类或产生了润色前后文本。单条已接受判决不构成总体准确率或独立人工一致率证据。

`src/data.js` 保存统计分母、版本、时点与源文件路径。流程页展示上述 r69 单条案例，实验页保留独立的 r64 聚合快照；它们未被合并为受控对照，也未混入题集、参数和版本不同的 r62/r63 历史运行。数据源与运行结果不会在页面打开或构建时自动读取。

### 真实结果的边界

- 正式 JSONL 表示模型判词已被接收，不代表语义复核通过。
- r64 唯一完成题的共同 Criteria 存在擅设 10% 容差、无依据的质量/体积单位等价、红线条件方向歧义。定向诊断整体未通过；不能转换为总体错误率。
- 定向诊断不是独立专家金标。缺失、失败、取消、阻塞和未完成均不计为都好或都差。
- 现有报告仍记载离线契约校验“尚未校验”。本页交叉核对计数不等于运行完整 `eval validate`。
- 本快照未收录受控的真实裁判换位、评测提示词消融、独立人工一致率或重复稳定性结果，页面直接标明未实测。

### 原始出处

- `configs/host.json`；`packages/agents/src/criteria/validate.ts`；`schemas/attribution/submission.schema.json`
- `packages/workflows/src/comparison/{input,blind,review,verdicts}.ts`
- `packages/prompts/resources/` 中的评测资源：10 份阶段提示词、4 份共享片段、9 份工具说明。未计入 Eris 的其他资源。
- `data/runs/comparison/eval-20261002-r64-quality/{state.json,stats.json,report.md,results/}`
- 流程案例原始输入：`data/sources/model-answers/{a_expert,b_expert}/2026-09-25.jsonl`，各第 320 行；题目与标准分别位于 `meta.question`、`meta.std_answer`
- 流程案例正式结果：`data/runs/comparison/eval-20261002-r68-quality/results/criteria.jsonl` 第 3 行；`attribution.jsonl` 第 8 行（回答①）、第 7 行（回答②）；`comparison.jsonl` 第 3 行
- 案例 Comparison ID：`cmp_7dd6aab8-0e9f-436c-9d11-dd95b591ae27`；后处理启用状态见同 run 的 `state.json`
- `.artifacts/diagnostics/quality-audit.json`
- `docs/contract.md`、`docs/quality.md`、`scripts/benchmark-analysis.mjs`

提示词保留此前核对的 r65 对应文件快照，原文节选必须是对应源文本中的连续片段；它们不作为流程页 r69 案例的实际完整提示词记录。变更快照时重新核对日期、版本、分母和复核状态；保留用户已有补充记录，不修改生产统计 Schema、原始输入或正式结果。

## 设计与方法参考

- [OpenAI Research](https://openai.com/research/)：字体层级与清晰导航。
- [Taste Skill](https://github.com/Leonxlnx/taste-skill)：删去装饰性文案，统一颜色与形状。
- [Phosphor Icons](https://github.com/phosphor-icons/core)：仅用于小型匿名交换符号；许可保存在 `PHOSPHOR-LICENSE.txt`，并嵌入最终 HTML。
- [Red Blob Games：Diagram Design](https://www.redblobgames.com/making-of/diagram-design/)、[Explorable Explanations](https://worrydream.com/ExplorableExplanations/)：默认内容应表达含义，关键材料与动作就近显示。
- [Emil Kowalski 的动效建议](https://emilkowal.ski/ui/7-practical-animation-tips)、[Motion 性能指南](https://motion.dev/docs/performance)：短时、可打断，仅对状态变化提供反馈。
- [MT-Bench / Chatbot Arena](https://arxiv.org/abs/2306.05685)、[Large Language Models are not Fair Evaluators](https://aclanthology.org/2024.acl-long.511/)：裁判效果需要独立的方法验证。

## AstraDraw 参考与机制图语义

本图参考用户提供的 AstraDraw 项目，按其 `SKILL.md` 与 `references/art-direction.md` 中“先确定对象变化，再选表现方式”的原则绘制。参考项目仅作视觉依据，未导入代码、截图、字体或其他资源；最终 HTML 不依赖该项目。

| 已查看的参考 | 借用范围 | 未借用 |
|---|---|---|
| `output/paper-method/method.png` | 共享输入主干、证据对象、操作与材料的不同外形 | 神经网络、共享权重、概率格、原图素材 |
| `output/framework/conditional-flow-previews/conditional-flow.png` | 上下分区；数据实线与条件虚线分开 | 训练过程、损失函数、连续时间和向量场 |
| `output/role-guided-search/overview.png` | 双通道、索引对应、矩阵与对象前后变化 | 强化学习、演化循环、相似度分数 |

图中具体映射：

- 题目查询银河证券转融通融入资金的平均利率变化，两份原始回答各占一条材料泳道。标准摘要来自已接受的 Criteria，保留原题的单位、范围和标准答案边界。
- 核验票据展示本例的计算口径、核心数值与已接受证据结论；匿名材料保留数值和回答来源索引，换位只改变 A/B 代号。
- 对照矩阵两列是匿名候选，展示原始回答与正式结果中的可回溯内容。原始匿名映射下 A 胜，页面换位后 B 胜，获胜来源始终是回答②（B组Expert）。
- “都好 / 都差”表示其他可能的正式判决。强调色复核线路表示通用条件分支：未决时最多独立复核一轮，再比较仍未决则“不交付”。它不是本例实际发生的执行记录。
- 复核读取原始材料并沿用固定标准；为避免长线覆盖主图，不重复绘制原文到复核的两条输入线。
- 底部归类与评语润色是互不串行的通用机制，本例均未启用；不展示虚构的问题类、归类结果或润色前后对照。配置数量是上限，不是本例产生的数量。
- 通用润色机制只接收已接受文本槽位，保留“只改措辞 · 判决不变”的边界，不表示语义质量自动正确。
- 黑色实线表示材料传递，灰色主干表示共同标准引用，圆点表示标准与回答汇入同一核验入口，强调色连线表示条件复核。图中不绘制无内容的文档短横线、点集或装饰性大图标。

SVG 使用命名分组保存主要机制。真实案例与来源、图形布局、视觉样式和交互分别在 `data.js`、`flow.js`、`styles.css` 与 `diagram-interaction.js` 中维护，构建时再合并为单文件。图内只保留中文对象名、必要 A/B 标识、案例证据和数量边界，不使用段落说明卡片。
