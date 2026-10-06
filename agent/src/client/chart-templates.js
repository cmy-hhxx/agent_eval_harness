const base = { scope: '示例数据', source: '模板示例', unit: '次' };
const template = (id, name, family, chart) => ({ id, name, family, chart: { ...base, ...chart } });
const issues = ['事实', '来源', '口径', '推导', '完整性', '格式'];
const profiles = [{ name: 'A组Fast', values: [8, 7, 4, 1, 2, 0] }, { name: 'B组Fast', values: [5, 2, 2, 1, 3, 0] }];
const observations = Array.from({ length: 16 }, (_, i) => `观测${i + 1}`);
const distributions = [{ name: 'A组Fast', values: [10, 11, 11, 12, 12, 12, 13, 13, 14, 14, 15, 17, 19, 20, 24, 31] },
  { name: 'B组Fast', values: [9, 10, 10, 11, 11, 12, 12, 12, 13, 13, 13, 14, 14, 16, 17, 20] }];
const phases = ['起始', '复核', '修订', '终验'];
const dates = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'];

/** Reusable tool payloads. Examples are deterministic and never treated as formal data. */
export const chartTemplates = [
  template('paired-gap', '差异点图', '比较', { type: 'dumbbell', title: '差距集中在事实与来源', categories: issues, series: profiles }),
  template('signed-gap', '双向差异', '比较', { type: 'dumbbell', title: '两组变化方向不同', unit: '%', categories: ['响应', '完成率', '覆盖率'], series: [{ name: 'A组', values: [-4, 5, 12] }, { name: 'B组', values: [3, 8, 10] }] }),
  template('slope', '坡度比较', '比较', { type: 'slope', title: '修订后差距缩小', unit: '%', categories: ['修订前', '修订后'], series: [{ name: 'A组', values: [54, 83] }, { name: 'B组', values: [72, 89] }, { name: '参照', values: [67, 76] }] }),
  template('interval', '区间图', '比较', { type: 'interval', title: '中心值接近，区间重叠', unit: '秒', scope: '三种方案 · 实测范围', categories: ['方案甲', '方案乙', '方案丙'], series: [{ name: '时延', values: [12, 14, 10], lowerValues: [8, 11, 7], upperValues: [17, 19, 15] }] }),
  template('signed-interval', '双向区间', '比较', { type: 'interval', title: '两项差异仍跨过零点', unit: '百分点', scope: '3项 · 95%置信区间', categories: ['完成率', '准确率', '覆盖率'], series: [{ name: '差值', values: [3, -2, 8], lowerValues: [-1, -5, 4], upperValues: [6, 2, 11] }] }),
  template('dot-ranking', '点位排名', '比较', { type: 'dot', title: '来源与事实占主要问题', categories: issues, series: [profiles[0]] }),
  template('matrix', '热力矩阵', '结构', { type: 'heatmap', title: '问题密集处一目了然', categories: issues, series: profiles }),
  template('radial', '环形热力', '结构', { type: 'radial_heatmap', title: '差异集中在相邻的两项', categories: issues, series: profiles }),
  template('radial-four', '多环热力', '结构', { type: 'radial_heatmap', title: '四个对象的问题结构不同', categories: issues, series: [...profiles, { name: 'C组Fast', values: [3, 5, 7, 2, 1, 4] }, { name: 'D组Fast', values: [2, 3, 4, 5, 8, 1] }] }),
  template('radial-signed', '发散环形热力', '结构', { type: 'radial_heatmap', title: '改变量在不同方向聚集', unit: '百分点', categories: issues, series: [{ name: 'A组', values: [-8, 2, 5, -3, 4, 1] }, { name: 'B组', values: [3, -2, 8, 1, -6, 4] }] }),
  template('bubble-matrix', '气泡矩阵', '结构', { type: 'bubble_matrix', title: '面积显示问题出现频次', categories: issues, series: profiles }),
  template('missing-matrix', '缺失矩阵', '结构', { type: 'heatmap', title: '缺失记录与零值分开', categories: issues, series: [profiles[0], { name: 'B组Fast', values: [5, null, 2, 1, null, 0] }] }),
  template('outcomes', '对局结果矩阵', '结构', { type: 'heatmap', title: '多数对局双方均好', scope: 'Fast · 21场', unit: '场', categories: ['A组胜', 'B组胜', '双方均好', '双方均差'], series: [{ name: 'Fast', values: [4, 3, 12, 2] }] }),
  template('composition', '完整组成', '结构', { type: 'pie', title: '已完成占当前主体', unit: '项', categories: ['完成', '待核', '待处理'], series: [{ name: '状态', values: [68, 20, 12] }] }),
  template('scatter', '成对关系', '关系', { type: 'scatter', title: '长度与得分并非同步上升', unit: '分', categories: observations.slice(0, 8), xLabel: '回答长度', xUnit: '字', xValues: [120, 200, 260, 330, 480, 520, 610, 800], series: [{ name: '实际观测', values: [64, 81, 72, 85, 69, 79, 74, 83] }] }),
  template('bubble', '三变量气泡', '关系', { type: 'bubble', title: '规模、时延与效果一起看', unit: '%', categories: ['甲', '乙', '丙', '丁', '戊', '己'], xValues: [4, 7, 9, 13, 16, 21], xLabel: '时延', xUnit: '秒', sizeValues: [10, 20, 15, 30, 45, 60], sizeLabel: '样本量', sizeUnit: '条', series: [{ name: '完成率', values: [68, 82, 78, 85, 88, 86] }] }),
  template('boxplot', '箱线与原始点', '分布', { type: 'boxplot', title: '中位相近，尾部差异明显', unit: '秒', scope: '每组16条原始观测', categories: observations, series: distributions }),
  template('violin', '小提琴与原始点', '分布', { type: 'violin', title: '相近中位数掩盖不同分布', unit: '秒', scope: '每组16条原始观测 · KDE', categories: observations, series: distributions }),
  template('histogram', '频数与观测短线', '分布', { type: 'histogram', title: '少量长尾拉高整体水平', unit: '秒', categories: observations, series: [distributions[0]] }),
  template('violin-three', '多组分布', '分布', { type: 'violin', title: '第三组呈现两个密集区', unit: '秒', scope: '每组16条原始观测 · KDE', categories: observations, series: [...distributions, { name: 'C组Fast', values: [5, 6, 6, 7, 7, 8, 9, 10, 21, 22, 23, 24, 24, 25, 26, 27] }] }),
  template('bump', '排名变化', '趋势', { type: 'bump', title: '阶段排名发生两次交换', unit: '名', categories: phases, series: [{ name: 'A组', values: [3, 2, 1, 2] }, { name: 'B组', values: [1, 3, 2, 1] }, { name: 'C组', values: [2, 1, 3, 3] }] }),
  template('trend', '时间趋势', '趋势', { type: 'line', title: '后半程增幅逐步收窄', unit: '%', scope: '同一固定题集 · 四个日期', categories: dates, series: [{ name: 'A组', values: [52, 64, 73, 78] }, { name: 'B组', values: [61, 70, 77, 80] }] }),
  template('trend-gaps', '不连续趋势', '趋势', { type: 'line', title: '缺失时点保持断开', unit: '%', categories: dates, series: [{ name: 'A组', values: [52, null, 73, 78] }, { name: 'B组', values: [61, 70, 77, 80] }] }),
  template('waterfall', '变动贡献', '趋势', { type: 'waterfall', title: '回收增量超过新增占用', unit: '万元', scope: '同一期间 · 可加总变动', categories: ['期初', '新增占用', '回收', '其他变动'], series: [{ name: '余额', values: [100, -35, 58, -8] }] }),
];
