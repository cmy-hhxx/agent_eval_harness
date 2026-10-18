# 评测汇报

[返回首页](../README.md)

[report.html](report.html) 是可直接复制、离线打开的单文件交付物。样式、脚本、图片、案例和研究快照均已内嵌；来源链接仅在主动点击时联网。

本模块保存**历史展示与实验材料**，不作为当前生产契约。当前规则看[数据契约](../docs/contract.md)，报告中的旧提示词和判词保留当时来源，不随代码升级改写。

## 内容与来源

| 内容 | 唯一来源 |
|---|---|
| 行业研究（资料日 2026-10-13） | [研究源稿](agent-evaluation-research-2026.md) |
| 方案流程、固定提交链接与仓库查询数据 | [flows.js](src/pages/research/flows.js) |
| 案例选择 | [case-selection.json](src/data/case-selection.json) |
| 案例及来源坐标 | [cases.js](src/data/cases.js) |
| 短摘要 | [case-summaries.js](src/data/case-summaries.js) |
| 历史提示词快照 | [prompts.js](src/data/prompts.js) |
| 比较实验与分析 | [experiments.js](src/data/experiments.js)、[experiment-analysis.json](src/data/experiment-analysis.json) |

案例每题选一场同档正式对比，题型由真实标准答案决定。选样不代表总体分布；Stars 只表示查询时关注度。历史提示词、源归因和实验比较阶段各保留自己的评测器标识，不混称同一版全链路结果。

回答保留完整最终文本；图片和外部可视化只留文本，不执行源 HTML。证据摘录保留原文件、行号、JSON 指针及截断信息。案例换位只交换展示与匿名映射，不调用模型或改变真实赢家。

## 页面与交互

首页按方案展示行业流程，仓库表可排序并返回对应流程。现有方案与实验按 Fast / Expert、主观 / 客观组合筛选，实验另有汇总视图；切换保留另一筛选条件。

对照表符号表示相对优势、不适用或待核，不表示绝对正确，也不按数量投票。原文、完整归因、匿名身份与实验分歧可展开；长内容须能查看全文。

字号与颜色由 [tokens.css](src/shared/tokens.css)维护。键盘可操作，窄屏保持读数，减少动态效果与打印时禁用非必要动画。无导出按钮、主题切换或页脚。SVG 文字选区的实际绘制须在真实浏览器检查，JSDOM 不能代替。

## 真实对照实验

实验固定所选案例的 Criteria、Attribution 与原始来源，只重跑 Comparison 的同序首判、同序复判和换位复判。它检验比较阶段重复性，不证明全链路准确率或人工一致率。

一致率同时核对结果类型和恢复后的真实赢家，只以双方已决的配对为分母；缺失、失败、待核单列。重复采样也会分歧，不能把换位变化全部归因于位置偏差。

脚本只在显式调用时操作实验：

```bash
npm run build:app
node evaluation-report/scripts/experiments.mjs prepare
node evaluation-report/scripts/experiments.mjs run
node evaluation-report/scripts/experiments.mjs snapshot
node evaluation-report/scripts/build.mjs
```

prepare 固定协议并拒绝覆盖已有目录；run **调用模型**，同 UUID 续跑保留结果与预算；snapshot 只读已有结果。模型、预算、样本、映射及运行目录由脚本与协议记录，汇总数字从快照读取，不在 README 再抄一份。

## 维护与构建

编辑 src/，不手改 report.html。template.html 是资源清单与装配顺序的唯一来源；build 仅读静态源码，不读业务源数据、不调用模型或联网。

```bash
node evaluation-report/scripts/build.mjs
node --test evaluation-report/tests/*.test.mjs
```

--output 可指定单文件位置。构建拒绝重复资源、越出 src 的路径与残留外部资源；数据快照只去格式化空白，不改值。

更新案例：

```bash
node evaluation-report/scripts/snapshot.mjs --selection evaluation-report/src/data/case-selection.json
```

同步核对短摘要、选择清单与原始来源。快照坐标保留生成时的位置；本地来源审计按任务、对战和 trace ID 定位，逐项核对内容并拒绝缺失或重复身份。来源文件缺失时明确跳过来源测试；普通展示与构建不依赖本机数据。实验结果只有执行对应实验后才更新。

研究源稿先用已安装的 four-knowns 导出器生成 HTML，再导入：

```bash
node evaluation-report/scripts/research.mjs --html /临时目录/研究导出.html
node evaluation-report/scripts/build.mjs
```

常规构建不依赖该导出器或 Python。更新外部研究须核查来源与资料日；修正文档不重新调查或改写历史实验。Phosphor 图标许可见 [LICENSE](licenses/PHOSPHOR-LICENSE.txt)，并内嵌交付物。
