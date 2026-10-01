# 自动化错误日志页

[设计基线](../DESIGN.md) · [错误来源与脱敏](../../../../docs/automations.md#错误日志页面)

页面：`apps/host/dashboard/automation-errors.html`。只读展示本流水线及其登记 run 的 `log/runtime.log` 原始错误；不分类、不归并，也不提供启动或重试入口。

顶部提供返回监控与刷新，随后是日志总数、更新时间及数据日期/时间范围筛选。每页 10 条，按落盘顺序从新到旧排列；原生 `details` 展开完整脱敏 JSON，包括已有的任务、尝试、错误路径和堆栈，不补造历史上未记录的信息。

自动刷新保留筛选、分页和展开状态；断连保留最后一页并明确标出。窄屏表格独立横向滚动，页面本身不溢出；状态不只依靠颜色。测试入口为 [`automation-errors.test.ts`](../../../../tests/integration/host/automation-errors.test.ts)。
