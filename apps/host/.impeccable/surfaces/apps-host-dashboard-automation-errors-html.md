# 自动化错误日志

Mode: Operate. Target: apps/host/dashboard/automation-errors.html.

## Direction contract

THESIS: 直接查看每一条原始错误，保留排查所需细节，不预分类或归并。

OWN-WORLD: 延续自动化看板的浅灰画布、白色数据表、细分隔线和系统中文字体。

STORY: 操作者发现集中报错时按日期、时间定位记录，展开核对任务、尝试、原始原因和堆栈，再自行停止和修复评测。

FIRST VIEWPORT: 标题、返回监控与刷新按钮；日志总条数和更新时间；日期、时间范围筛选；按记录顺序从新到旧排列的原始错误表格。

FORM: 每页 10 条，原生 details 展开完整 JSON；自动刷新保留分页和展开，断连保留记录。窄屏表格独立横向滚动。只读页面，无重试或启动操作。

## Acceptance

- 桌面 1440px 与窄屏 390px 已检查；实际日志 184 条，每页 10 条，没有分类或分组入口。完整内容可展开，页面无整体横向溢出。
- 截图：`.artifacts/automation-repair/raw-errors-desktop.png`、`raw-errors-detail.png`、`raw-errors-mobile.png`。截图只读生产日志，不生成生产错误。
- 增量读取、完整行边界、分页、展开保留、断连保留、HTML 转义、原始诊断和脱敏通过回归测试；333 项项目测试、15 项 SDK 集成测试及 typecheck 通过。
- 自动检测为 DEGRADED：HTML 解析器不可用，正则检查零发现；不等于完整审计。视觉与交互另经人工检查。
- 记录仅呈现原有内容；历史缺失的诊断不伪造。无随页面交付的位图资产。
