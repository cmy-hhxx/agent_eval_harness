---
name: Host 自动化监控
description: Host 自动化监控与错误页的界面规格
colors:
  text: "#192a35"
  muted: "#596c79"
  canvas: "#f3f6f7"
  surface: "#ffffff"
  soft: "#f2f6f7"
  line: "#dfe7eb"
  accent: "#087f83"
  accent-soft: "#e6f3f2"
  success: "#0b6b41"
  warning: "#8a5108"
  danger: "#b42318"
typography: {body: {fontFamily: '"Avenir Next", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: "14px", lineHeight: 1.55}}
rounded: {control: "8px", table: "8px"}
---

## Overview

本规格适用于 [`automations.html`](../dashboard/automations.html) 与 [`automation-errors.html`](../dashboard/automation-errors.html)，沿用 `dashboard.css`，页面差异由 `automations.css` 定义。浅色、紧凑、以数据和状态为中心。操作与数据语义以[自动化指南](../../../docs/automations.md)为准，产品级约束见 [PRODUCT.md](../../../PRODUCT.md)。

## Colors

灰色画布承托白色表格，细灰线分隔行与区块。青绿色用于交互、运行状态和完成量条；绿色表示成功，棕色表示待重试或待核实，红色表示错误。状态同时显示文字。颜色与控件形状取自工作台共用的 `dashboard.css`。

## Typography

英文字体优先 Avenir Next，中文沿用系统字体。页面标题 18px，区块标题 16px，表格正文 13px，表头和辅助状态 12px；数字使用等宽数字字形，代码与紧凑数值使用 SF Mono / 系统等宽字体。

## Layout

内容最大宽度 1560px，桌面内边距为 28px 32px 56px。顶部是状态、刷新与更新时间，随后是日期进度、时段完成量、MongoDB 交付、日志交付四个页签及当前视图适用的筛选器。每次只显示一个区块；五张表各自每页 10 条。760px 以下内边距为 20px 16px 40px，筛选器逐行排列，页签和表格各自横向滚动。

## Elevation & Depth

页面使用背景、边框和行悬停底色区分层级，表格与控件不使用阴影。

## Shapes

表格容器与控件均为 8px 圆角、1px 边框；状态文字前有 6px 圆点，完成量以 6px 高的水平条辅助比较。

## Components

刷新、筛选和分页按钮桌面最小高度 40px，窄屏为 44px；键盘焦点使用青绿色轮廓。页签支持方向键、Home 和 End，以及 URL 锚点直达。日期进度只显示数据日期筛选，日志交付只显示记录时间筛选，其他视图同时显示二者；时间范围为近 24 小时、近 7 天和全部时间。一键重置仅重置当前视图适用的筛选。

各表显示记录范围、总条数、当前页及前后翻页按钮；汇总值覆盖所有筛选结果。切换页签或每 5 秒自动刷新均保留分页，筛选改变时回到第一页。完成量按北京时间整点分桶，对比必须完成归因及对比改写；聚类和聚类改写后置，不计入自动化进度。已确认完成的历史日期按原评测范围统计。断连保留最后数据并显示错误横幅，筛选不会清除断连状态，重连后恢复。页面只读，不提供调度控制。

顶部以无卡片的五列定义列表呈现评测器、实时并发、评测待重试、最近重试和累计缓存命中率；1000px 以下排成两列。并发同时给出去重题目数与阶段分布，倒计时每秒更新，断连时标明快照并停止预测，停止时显示启动后重试。概览不受表格筛选影响。日期表末列显示逐日缓存命中率；暂无用量与 0% 区分。取数状态按四模型分别核对数量，数量不符时显示差额与等待原因；下载进行中不重复显示上次失败。

## Do's and Don'ts

槽位利用率与空闲槽位同时呈现；运行概览下方用四列紧凑定义列表显示取数、评测、MongoDB 和日志通道，窄屏两列。错误日志使用独立 `/errors` 页：按记录顺序从新到旧逐条呈现原始错误，每页 10 条，不预分类或聚合；使用原生 details 展开完整 JSON。日期与时间范围是仅有的筛选；轮询保留展开与分页，断连保留最后内容。

沿用现有字体、颜色和表格关系；只呈现数据、状态与错误，不增加说明式小字。页面不使用位图资产。各页具体信息层级见[监控页](surfaces/apps-host-dashboard-automations-html.md)和[错误页](surfaces/apps-host-dashboard-automation-errors-html.md)；功能回归分别在 [`automation-dashboard.test.ts`](../../../tests/integration/host/automation-dashboard.test.ts) 和 [`automation-errors.test.ts`](../../../tests/integration/host/automation-errors.test.ts)。
