# 自动化监控

Mode: Operate. Target: apps/host/dashboard/automations.html.

## Direction contract

THESIS: 日期进度、按完成时间分段的评测量、交付回执在一页直接核对。

OWN-WORLD: 沿用现有 Host 看板：浅灰背景、白色工作区、系统中文字体、蓝色交互、绿色成功与红色错误；表格和细分隔线。

STORY: 操作者在桌面日常办公环境查看进度，按数据日期与时间段筛选，定位失败和最后成功推送。

FIRST VIEWPORT: 顶部运行状态和更新时间，随后筛选器与日期阶段表；下方时段完成量和交付记录。刷新按钮在右上角。

FORM: 既有界面的延伸；三张直接呈现事实的表格，小屏在独立表格内滚动；自动刷新保留筛选与滚动位置。不新增调度控制。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

- 独立评审发现的 P2「筛选重绘覆盖断连状态」已修复；复核判定该项 resolved，disposition：ship，仅覆盖该修复项。日期、时间筛选及重连由回归测试验证，浏览器确认断连与重连显示。
- 桌面、窄屏及两者的断连截图位于 `.artifacts/automation-dashboard-review/`：`desktop.png`、`mobile.png`、`desktop-disconnected.png`、`mobile-disconnected.png`。截图使用模拟数据，未启动生产服务、真实评测或上传。
- 自动检测为 DEGRADED：HTML 解析器不可用，正则检查为零发现，不代表完整审计。
- typecheck、269 项测试和 13 项 SDK 测试通过。clean 验证中的 bootstrap、build、doctor 通过；现有 `docs/evaluation-lessons.md` 对被忽略产物的链接导致链接检查失败。
- 当前视觉与行为记录见 `apps/host/.impeccable/DESIGN.md`。无随页面交付的位图资产，截图仅为测试材料。
