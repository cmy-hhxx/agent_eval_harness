展示真实数据的统计图，成功后自动显示在回答开头，无需正文引用。同轮相同来源、图形与指标的修订只显示最新成功图。

直接画某一运行、档位的模型战绩，runId 使用 list_data 返回的真实标识：
```json
{"title":"Fast 各模型战绩","statistics":{"runId":"eval-20261013","comparisonTier":"Fast"}}
```
程序直接读取正式计数，填入模型名称、胜场、负场、双方均好/均差、单位、日期和来源，不填写 categories、series、unit、scope、source、references。仅支持 heatmap（默认）或 bubble_matrix。每列为一个模型的出场计数，不能跨模型相加当作总场数；不代表历史累计。title、annotations、caveat 及正文结论仍由你根据数据分析。

按问题选择图形。两组战绩可用 heatmap：categories 为 Fast、Expert，四个 series 为 A组胜、B组胜、双方都好、双方都差，unit="场"。单例对战使用 show_comparison。
- 数值与频数：heatmap 比较数值，bubble_matrix 展示频数矩阵。
- 时间与阶段：line 的 categories 用递增日期，slope 比两个阶段。
- 关系：scatter 的 xValues 是横轴观测，xLabel / xUnit 说明含义；bubble 再用 sizeValues / sizeLabel / sizeUnit 表示第三个量的面积。
- 原始分布：histogram、boxplot、violin、ecdf、ridgeline；程序计算分箱、分位数与密度。
- 组成与层级：pie 是单组环形图，concentric 是2–4组对照；waffle 一格一个样本；分类须互斥可加总。sunburst、treemap 的 series 是父类、categories 是叶类，values 是数量。
- 多维与周期：radar、radial_heatmap、rose 的指标保持同单位与可比范围。radial_progress 表示至少两个独立指标的进度；它与 radar 的 maxValue 是实际共同上限。
- 贡献与流向：waterfall 首项为起点，后续为真实增减，程序追加合计。sankey 的 categories 列节点、series.name 为起点、values 是到各节点的守恒无环流量；chord 是同样排列的对称共现矩阵，主对角线为0。
- 区间：interval 的 lowerValues / upperValues 包围实际中心值，使用已有上下界。

其他指标直接填写 categories、series、unit；type 省略时用 heatmap，显式指定其他图形仍需符合其数据条件。categories 与 series.values 逐项对应，null 表示未知，0 是实测零值。数值、分母和区间均来自材料，不编造主观分数或统计显著性。title 概括主题，annotations 标注数据点，caveat 补充解读局限并显示在图下。references 全为 statistics 时可省略 scope，程序生成数据日期与分档场数；其他图用 scope 说明口径。本地 references 核验后可省略 source；外部图必须填写来源名称与日期。

本地评测的 references 按来源选择：
- 正式战绩：{"statistics":{"runId":"实际运行ID","comparisonTier":"Fast"}}，核验该档完整统计。
- 具体材料：{"reference":目录返回的reference}。
- 普通运行统计：{"runId":"实际运行ID"}。
- 本会话专业结果：{"operationId":"实际任务ID"}。
外部资料省略 references，在 source 标明来源名称和日期。单次运行的 references 不能代表历史累计。
