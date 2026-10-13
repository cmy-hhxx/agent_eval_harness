展示真实数据的统计图，成功后自动显示在回答开头，无需正文引用。同轮相同来源、图形与指标的修订只显示最新成功图。

按问题选择图形。两组战绩可用 heatmap：categories 为 Fast、Expert，四个 series 为 A组胜、B组胜、双方都好、双方都差，unit="场"。单例对战使用 show_comparison。
- 数值与频数：heatmap 比较数值，bubble_matrix 展示频数矩阵。
- 时间与阶段：line 的 categories 用递增日期，slope 比两个阶段。
- 关系：scatter 的 xValues 是横轴观测，xLabel / xUnit 说明含义；bubble 再用 sizeValues / sizeLabel / sizeUnit 表示第三个量的面积。
- 原始分布：histogram、boxplot、violin、ecdf、ridgeline；程序计算分箱、分位数与密度。
- 组成与层级：pie 是单组环形图，concentric 是2–4组对照；waffle 一格一个样本；分类须互斥可加总。sunburst、treemap 的 series 是父类、categories 是叶类，values 是数量。
- 多维与周期：radar、radial_heatmap、rose 的指标保持同单位与可比范围。radial_progress 表示至少两个独立指标的进度；它与 radar 的 maxValue 是实际共同上限。
- 贡献与流向：waterfall 首项为起点，后续为真实增减，程序追加合计。sankey 的 categories 列节点、series.name 为起点、values 是到各节点的守恒无环流量；chord 是同样排列的对称共现矩阵，主对角线为0。
- 区间：interval 的 lowerValues / upperValues 包围实际中心值，使用已有上下界。

categories 与 series.values 逐项对应，null 表示未知，0 是实测零值。数值、分母和区间均来自材料，不编造主观分数或统计显著性。title 概括主题，unit 写单位，annotations 按需标注。references 全为 statistics 时可省略 scope，程序生成数据日期与分档场数；其他图用 scope 说明口径，source 记录来源。

本地评测的 references 按来源选择：
- 正式战绩：{"statistics":{"runId":"实际运行ID","comparisonTier":"Fast"}}，核验该档完整统计。
- 具体材料：{"reference":目录返回的reference}。
- 普通运行统计：{"runId":"实际运行ID"}。
- 本会话专业结果：{"operationId":"实际任务ID"}。
外部资料省略 references，在 source 标明来源名称和日期。累计发布快照目前用表格呈现，单次运行的 references 不能代表历史累计。
