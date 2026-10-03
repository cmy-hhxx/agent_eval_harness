export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title: string;
  scope: string;
  unit: string;
  source: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
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
