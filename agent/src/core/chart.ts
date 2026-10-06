import { calculate } from "@eval/tools";

export interface ChartSpec {
  type: "dot" | "line" | "pie" | "dumbbell" | "heatmap" | "scatter" | "waterfall" | "histogram" | "radial_heatmap" | "bubble" | "bubble_matrix" | "slope" | "bump" | "interval" | "boxplot" | "violin" | "rose" | "concentric" | "radial_progress" | "radar" | "waffle" | "sunburst" | "treemap" | "sankey" | "chord" | "ecdf" | "ridgeline";
  title: string;
  scope: string;
  unit: string;
  source: string;
  categories: string[];
  series: { name: string; values: (number | null)[]; lowerValues?: (number | null)[]; upperValues?: (number | null)[] }[];
  maxValue?: number;
  xValues?: (number | null)[];
  sizeValues?: (number | null)[];
  sizeLabel?: string;
  sizeUnit?: string;
  xLabel?: string;
  xUnit?: string;
  annotations?: { categoryIndex: number; seriesIndex: number; note: string }[];
}

/** Line charts use calendar coordinates, never equal spacing for unrelated cases. */
function calendarTime(label: string): number {
  if (!/^[1-9]\d{3}(?:-\d{2}(?:-\d{2})?)?$/.test(label))
    throw new Error("折线图类别须为真实时间：YYYY、YYYY-MM 或 YYYY-MM-DD");
  const [year, month = "01", day = "01"] = label.split("-");
  const date = `${year}-${month}-${day}`;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date)
    throw new Error("折线图包含无效日期");
  return time;
}

export function validateChart(chart: ChartSpec): void {
  if (new Set(chart.categories).size !== chart.categories.length)
    throw new Error("图表类别不能重复");
  if (new Set(chart.series.map((series) => series.name)).size !== chart.series.length)
    throw new Error("图表系列名称不能重复");
  for (const series of chart.series) {
    if (series.values.length !== chart.categories.length)
      throw new Error("每个图表系列的数值须与类别逐项对应");
    if (series.values.some((value) => value !== null && !Number.isFinite(value)))
      throw new Error("图表数值必须有限，未知值用 null");
  }
  if (!chart.series.some((series) => series.values.some((value) => value !== null)))
    throw new Error("图表没有可绘制的已知数值");
  for (const annotation of chart.annotations ?? []) {
    if (!chart.categories[annotation.categoryIndex] || !chart.series[annotation.seriesIndex]
      || chart.series[annotation.seriesIndex].values[annotation.categoryIndex] === null
      || (["scatter", "bubble"].includes(chart.type) && chart.xValues?.[annotation.categoryIndex] == null)
      || (chart.type === "bubble" && chart.sizeValues?.[annotation.categoryIndex] == null))
      throw new Error("重点标注必须指向实际存在的已知数据点");
  }
  if (["scatter", "bubble"].includes(chart.type)) {
    if (chart.xValues?.length !== chart.categories.length || !chart.xLabel?.trim() || !chart.xUnit?.trim()
      || chart.xValues.some(value => value !== null && !Number.isFinite(value)))
      throw new Error("散点图需要与样本对应的横轴数值、指标名和单位");
    const pairs = chart.series.reduce((sum, series) => sum + series.values.filter((value, index) => value !== null && chart.xValues![index] !== null).length, 0);
    if (pairs < 3) throw new Error("散点图至少需要3个完整观测，不能从缺失值补造坐标");
  }
  if (chart.type === "bubble" && (chart.sizeValues?.length !== chart.categories.length
    || chart.series.reduce((sum, series) => sum + series.values.filter((v, i) => v !== null && chart.xValues![i] !== null && chart.sizeValues![i] !== null).length, 0) < 3))
    throw new Error("气泡图需要至少3个横轴、纵轴和大小均有记录的观测");
  if (chart.type === "slope" && (chart.categories.length !== 2 || !chart.series.some(s => s.values.every(v => v !== null))))
    throw new Error("坡度图需要两个可比阶段与至少一组完整配对");
  if (chart.type === "interval") for (const series of chart.series) {
    if (series.lowerValues?.length !== chart.categories.length || series.upperValues?.length !== chart.categories.length
      || series.values.some((v, i) => v === null ? series.lowerValues![i] !== null || series.upperValues![i] !== null
        : series.lowerValues![i] === null || series.upperValues![i] === null || series.lowerValues![i]! > v || series.upperValues![i]! < v))
      throw new Error("区间图需要对应的已知上下界且包含中心值，缺失项三个值均为 null");
  }
  if (["boxplot", "violin"].includes(chart.type) && chart.series.some(s => s.values.filter(v => v !== null).length < (chart.type === "violin" ? 8 : 5)))
    throw new Error("箱线图每组至少5条、小提琴图每组至少8条原始观测");
  const complete = ["rose", "concentric", "radial_progress", "radar", "waffle", "sunburst", "treemap", "sankey", "chord"].includes(chart.type);
  if (complete && chart.series.some(s => s.values.some(v => v === null || v < 0)))
    throw new Error("组成、层级和流量图需要完整非负数据，未知不能补零");
  if (complete && !["radar", "radial_progress"].includes(chart.type) && chart.series.some(s => !s.values.some(v => v! > 0)))
    throw new Error("每组组成或流量须有正值");
  if (["radar", "radial_progress"].includes(chart.type) && (!Number.isFinite(chart.maxValue) || chart.maxValue! <= 0 || chart.series.some(s => s.values.some(v => v! > chart.maxValue!))))
    throw new Error("雷达与比例环需要真实统一上限，数值不得超过 maxValue");
  if (chart.type === "waffle" && (chart.series[0].values.some(v => !Number.isInteger(v)) || chart.series[0].values.reduce<number>((sum,v) => sum + v!, 0) > 400))
    throw new Error("华夫图使用原始整数计数，合计最多400，一格对应一个单位");
  if (["ecdf", "ridgeline"].includes(chart.type) && chart.series.some(s => s.values.filter(v => v !== null).length < (chart.type === "ecdf" ? 2 : 8)))
    throw new Error("累积分布每组至少2条、山脊密度每组至少8条原始观测");
  if (["sankey", "chord"].includes(chart.type)) {
    const n = chart.categories.length, matrix = Array.from({ length: n }, () => Array<number>(n).fill(0));
    for (const series of chart.series) {
      const row = chart.categories.indexOf(series.name);
      if (row < 0) throw new Error("流量系列名必须对应 categories 中的节点名称");
      matrix[row] = series.values as number[];
      if (matrix[row][row] !== 0) throw new Error("流量与共现关系不包含自环");
    }
    if (chart.type === "chord") {
      if (chart.series.length !== n || matrix.some((row,i) => row.some((v,j) => v !== matrix[j][i])))
        throw new Error("弦图需要完整对称共现矩阵，不将有向流量冒充无向关联");
    } else {
      const active = new Set<number>(), visited = new Set<number>();
      const visit = (i: number) => {
        if (active.has(i)) throw new Error("桑基图必须是无环流向");
        if (visited.has(i)) return;
        active.add(i); matrix[i].forEach((v,j) => { if (v > 0) visit(j); }); active.delete(i); visited.add(i);
      };
      matrix.forEach((_,i) => visit(i));
      const sum = (values: number[]) => calculate("add", ["0", ...values.map(String)]).result;
      matrix.forEach((row,i) => {
        const incoming = sum(matrix.map(r => r[i])), outgoing = sum(row);
        if (incoming !== "0" && outgoing !== "0" && incoming !== outgoing) throw new Error("桑基图中间节点的流入与流出须守恒");
      });
    }
  }
  if (chart.type === "radial_heatmap" && (chart.series.length < 2 || chart.categories.length < 3
    || chart.categories.length > 12 || chart.categories.some(label => Array.from(label).length > 12)))
    throw new Error("环形热力图需要2–4组同口径系列、3–12个类别，类别名最多12字");
  if (chart.type === "dumbbell" && (chart.series.length !== 2 || chart.categories.length < 2))
    throw new Error("差异点图需要两组同口径系列和至少两个比较项目");
  if (["waterfall", "histogram"].includes(chart.type)) {
    if (chart.series.length !== 1 || chart.categories.length < 2 || chart.series[0].values.some(value => value === null))
      throw new Error("瀑布图和分布图需要一组至少两个完整实际数值");
    if (chart.type === "waterfall" && !Number.isFinite(chart.series[0].values.reduce<number>((sum, value) => sum + value!, 0)))
      throw new Error("瀑布图累计值必须有限");
  }
  if (chart.type === "line") {
    const times = chart.categories.map(calendarTime);
    if (times.some((time, index) => index > 0 && time <= times[index - 1]))
      throw new Error("折线图时间须严格递增");
  }
  if (chart.type === "pie") {
    const values = chart.series[0].values;
    if (chart.series.length !== 1 || chart.categories.length > 6 || values.some((value) => value === null || value < 0))
      throw new Error("饼图须为一组最多六项的完整非负组成，不能包含未知值");
    if (values.reduce<number>((total, value) => total + (value ?? 0), 0) <= 0)
      throw new Error("饼图组成的合计须大于零");
  }
}
