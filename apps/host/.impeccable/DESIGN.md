---
name: Host 自动化监控
description: 现有 Host 看板中自动化监控页的实现记录
colors:
  text: "#171a20"
  muted: "#5f6876"
  canvas: "#f5f6f8"
  surface: "#ffffff"
  soft: "#f3f5f7"
  line: "#e2e6ea"
  accent: "#205ec8"
  accent-soft: "#eaf1fd"
  success: "#0b6b41"
  warning: "#8a5108"
  danger: "#b42318"
typography: {body: {fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: "14px", lineHeight: 1.55}}
rounded: {control: "6px", table: "8px"}
---

## Overview

本记录仅适用于 `apps/host/dashboard/automations.html`，沿用 `dashboard.css`，页面差异由 `automations.css` 定义。浅色、紧凑、以数据和状态为中心。

## Colors

灰色画布承托白色表格，细灰线分隔行与区块。蓝色用于交互、运行状态和完成量条；绿色表示成功，棕色表示待重试或待核实，红色表示错误。状态同时显示文字。

## Typography

沿用系统中文字体。页面标题 18px，区块标题 16px，表格正文 13px，表头和辅助状态 12px；数字使用等宽数字字形。

## Layout

内容最大宽度 1560px，桌面内边距为 28px 32px 56px。顶部是状态、刷新与更新时间，随后是区块导航、筛选器及日期进度、时段完成量、交付记录三张表。760px 以下内边距为 20px 16px 40px，筛选器逐行排列，表格各自横向滚动。

## Elevation & Depth

页面使用背景、边框和行悬停底色区分层级，表格与控件不使用阴影。

## Shapes

表格容器为 8px 圆角、1px 边框，控件为 6px 圆角；状态文字前有 6px 圆点，完成量以 6px 高的水平条辅助比较。

## Components

刷新按钮与筛选器桌面最小高度 40px，窄屏为 44px；键盘焦点使用蓝色轮廓。日期筛选影响三张表，时间筛选提供近 24 小时、近 7 天和全部时间；完成量按北京时间整点分桶，并显示实际起点。每次状态请求结束后 10 秒再刷新，保留仍存在的日期选择；断连保留最后数据并显示错误横幅，筛选不会清除断连状态，重连后恢复。页面只读，不提供调度控制。

## Do's and Don'ts

沿用现有字体、颜色和表格关系；只呈现数据、状态与错误，不增加说明式小字。页面不使用位图资产；验收截图仅为测试材料。
