展示真实数据的统计图，成功后由界面自动放在本轮回答开头，正文不写图表引用。同轮相同统计来源、图形与指标的修订只显示最新成功图。

两组对战用一张 heatmap，unit="场"；categories 为 Fast、Expert，四个 series 是 A组胜、B组胜、双方都好、双方都差；保留分档场数，不混成总排名。单题用 show_comparison。

选择能清楚回答问题的图：
- 数值与差距：用 heatmap 逐项比较，频数矩阵用 bubble_matrix。
- 时间与阶段：line 的 categories 用递增日期，slope 比两个阶段。
- 关系：scatter 的 xValues 是横轴观测，xLabel / xUnit 说明含义；bubble 再用 sizeValues / sizeLabel / sizeUnit 表示第三个量的面积。
- 原始观测分布：histogram、boxplot、violin、ecdf、ridgeline；程序计算分箱、分位数与密度。
- 组成与层级：pie 是单组环形图，concentric 是2–4组环形对照；waffle 一格一个样本；分类须互斥可加总。sunburst、treemap 的 series 是父类、categories 是叶类，values 是数量。
- 多维与周期：radar、radial_heatmap、rose；指标保持同单位与可比范围。两个及以上独立指标的进度用 radial_progress；它与 radar 的 maxValue 是实际共同上限。
- 贡献与关系流：waterfall 首项为起点，后续为真实增减，程序追加合计。sankey 的 categories 列节点、series.name 为起点、values 是到各节点的守恒无环流量；chord 为同样排列的对称共现矩阵，主对角线为0。
- 已有上下界：interval 的 lowerValues / upperValues 包围实际中心值；不生成置信带。

categories 与 series.values 逐项对应，null 表示未知，0 是实测零值。保留真实分母；不编主观分数、转移量或显著性。字段限制见参数约束。

title 直接写对象与结论，不用“已接受正式对战结果”。unit 写单位，annotations 默认省略。references 全用 statistics 时省略 scope，程序生成数据日期与分档场数；其他 scope 只写必要口径。不传 caveat，不解释评测时间或未知日期。source 保留详情，样式由程序处理。

本地评测的 references 按来源选一种：
- 正式战绩：{"statistics":{"runId":"实际运行ID","comparisonTier":"Fast"}}，程序核验该档完整统计；statistics 放在 references 项内。
- 具体材料：{"reference":目录返回的reference}。
- 普通运行统计：{"runId":"实际运行ID"}。
- 本会话专业结果：{"operationId":"实际任务ID"}。
外部资料作图省略 references，在 source 标明来源名称和日期，回复不附第三方链接。

作图即已交代时间和样本范围。正文解释关键差异、依据和改进优先级，不重复罗列图中数字；分析深度按用户问题决定，不限制句数。累计发布快照用表格，不借用单次运行的 references 代表历史。
