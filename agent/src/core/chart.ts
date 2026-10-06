export interface ChartSpec {
  type: "bar" | "line" | "pie" | "dumbbell" | "heatmap" | "scatter" | "waterfall" | "histogram";
  title: string;
  scope: string;
  unit: string;
  source: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  xValues?: (number | null)[];
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
      || (chart.type === "scatter" && chart.xValues?.[annotation.categoryIndex] == null))
      throw new Error("重点标注必须指向实际存在的已知数据点");
  }
  if (chart.type === "scatter") {
    if (chart.xValues?.length !== chart.categories.length || !chart.xLabel?.trim() || !chart.xUnit?.trim()
      || chart.xValues.some(value => value !== null && !Number.isFinite(value)))
      throw new Error("散点图需要与样本对应的横轴数值、指标名和单位");
    const pairs = chart.series.reduce((sum, series) => sum + series.values.filter((value, index) => value !== null && chart.xValues![index] !== null).length, 0);
    if (pairs < 3) throw new Error("散点图至少需要3个完整观测，不能从缺失值补造坐标");
  }
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
