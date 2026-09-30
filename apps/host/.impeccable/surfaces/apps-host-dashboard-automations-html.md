# 自动化监控

Mode: Operate. Target: apps/host/dashboard/automations.html.

## Direction contract

THESIS: 在四个页签中分别核对日期进度、时段评测量、MongoDB 与日志交付，分页限制单次呈现的记录量。

OWN-WORLD: 沿用现有 Host 看板：浅灰背景、白色工作区、系统中文字体、蓝色交互、绿色成功与红色错误；表格和细分隔线。

STORY: 操作者在桌面日常办公环境查看进度，按数据日期与时间段筛选，定位失败和最后成功推送。

FIRST VIEWPORT: 顶部运行状态和更新时间，随后是评测器、实时并发、评测待重试、最近重试和累计缓存命中率五项数据；四通道概览显示取数、评测、MongoDB 和日志状态。再往下是四个页签、适用筛选器与数据表。错误日志入口和刷新按钮在右上角。

FORM: 既有界面的延伸；五张表各自每页 10 条，一次只显示一个区块。筛选提供日期、时间及一键重置，小屏在独立表格内滚动；自动刷新保留筛选和当前页。不新增调度控制。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

- 桌面与 390px 窄屏只读预览已检查：MongoDB 56 条同步记录每页 10 条，翻页及轮询保留当前页；窄屏页面宽度等于视口，表格独立横向滚动。
- 运行数据桌面五列、四通道概览四列，窄屏均两列，无整页横向溢出。状态每 5 秒刷新，重试倒计时每秒更新；概览不受表格筛选影响，断连显示快照，停止显示启动后重试。并发只统计活进程，题目按日期和 case 去重；槽位利用率和缓存命中率分别呈现。
- 五张表的分页边界、筛选重置、数据缩减、页签切换、键盘操作和断连保留由回归测试验证。归因、对比及完整改写保留；聚类任务、聚类改写及其暂停不再阻塞自动化完成。
- 数量按四个模型分别核对，实际快照中的 9 月 29 日远端 737／本地 522 显示待更新及差额 215，未显示本地已就绪。缓存为真实 usage 的加权比例，无 usage 时显示暂无用量。
- 当前截图位于 `.artifacts/automation-repair/`：`flow-cache-desktop.png`、`flow-cache-mobile.png`。预览只读生产状态，未启动评测或上传。
- 自动检测为 DEGRADED：HTML 解析器不可用，正则检查为零发现，不代表完整审计。
- 本轮 typecheck、隔离目录中 333 项测试和 15 项 SDK 集成测试全部通过，覆盖下载、重试释放槽位、原始错误传递、缓存统计与看板状态。测试使用本地假网关，未启动生产评测。
- 当前视觉与行为记录见 `apps/host/.impeccable/DESIGN.md`。无随页面交付的位图资产，截图仅为测试材料。
