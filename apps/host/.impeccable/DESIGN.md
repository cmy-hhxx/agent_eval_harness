---
name: Host 自动化监控
description: Host 自动化监控与错误页的界面规格
---

# 自动化监控设计

[产品规范](../../../PRODUCT.md) · [操作与数据语义](../../../docs/automations.md)

适用于 [automations.html](../dashboard/automations.html) 和 [automation-errors.html](../dashboard/automation-errors.html)。共用样式取 [dashboard.css](../dashboard/dashboard.css)，页面差异取 [automations.css](../dashboard/automations.css)；不在文档复制颜色和尺寸 token。

## 视觉与交互

浅色、紧凑，以数据和状态为中心。白色表面、细线分隔、不加阴影；青绿用于交互，成功、等待、失败同时显示状态文字。数字对齐，正文和控制在窄屏仍可读。

页面不横向溢出，页签与宽表独立滚动。页签支持方向键、Home/End 和 URL 锚点；控件有可见焦点，状态可由辅助技术识别。不添加说明式小字。

## 监控页

1. 顶部：运行状态、更新时间、错误日志入口、刷新。
2. 概览：评测器、实时并发、待重试、下次重试、缓存率及四通道状态，不受表格筛选影响。
3. 页签：日期进度、时段完成量、Mongo、日志，每次显示一个区块及适用筛选。
4. 表格：每页10条，显示范围、总量和分页；汇总覆盖全部筛选结果。

刷新与切换页签保留分页，筛选改变回第一页，数据减少时收敛到末页。断连保留快照并停止倒计时预测，停机显示启动后重试。

正式对战数与阶段任务数分列；取数按四模型核对，数量不符显示差额。暂无 Token 与0%命中分开；Mongo 核验时间不冒充上传时间。业务完成条件直接采用自动化投影。

## 错误页

顶部提供返回、刷新、总数、更新时间、数据日期与时间范围。原始错误按落盘顺序倒排，每页10条，原生 details 展开完整脱敏 JSON。

自动刷新保留筛选、分页和展开状态；断连保留最后一页。页面不分类、聚合或改写错误，不提供启动、重试与上传入口。

## 验证

行为测试：[automation-dashboard.test.ts](../../../tests/integration/host/automation-dashboard.test.ts)、[automation-errors.test.ts](../../../tests/integration/host/automation-errors.test.ts)。视觉检查使用当前页面与数据，核对窄屏、键盘、状态与断连，不把旧截图和历史条数当作契约。
