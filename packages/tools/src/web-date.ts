import type { WebDateAssessment } from "@eval/contracts";

const months = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);

function calendarDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Accept explicit full dates; reporting periods and relative search labels stay unknown. */
export function parseAbsoluteWebDate(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(value);
  if (iso) {
    const date = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (!date || (iso[4] !== undefined && (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59 || !Number.isFinite(Date.parse(value))))) return undefined;
    return date;
  }
  const chinese = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/.exec(value);
  if (chinese) return calendarDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));
  const numeric = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(value);
  if (numeric) return calendarDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  const english = /^(?:([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4}))$/.exec(value);
  if (english) {
    const month = months.get((english[1] ?? english[5]).toLowerCase());
    if (month) return calendarDate(Number(english[3] ?? english[6]), month, Number(english[2] ?? english[4]));
  }
  return undefined;
}

export function validateDateRange(dateFrom?: string, dateTo?: string): void {
  for (const [name, value] of [["dateFrom", dateFrom], ["dateTo", dateTo]] as const) {
    if (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || parseAbsoluteWebDate(value) !== value))
      throw new Error(`${name} 必须为有效日历日期 YYYY-MM-DD`);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("dateFrom 不能晚于 dateTo");
}

export function shiftWebDate(date: string, days: number): string {
  validateDateRange(date);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const shifted = value.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shifted)) throw new Error("搜索日期边界超出 YYYY-MM-DD 范围");
  return shifted;
}

export function assessWebDate(raw: string | undefined, basis: "search_metadata" | "page_metadata", dateFrom?: string, dateTo?: string): WebDateAssessment {
  if (!dateFrom && !dateTo) return { status: "not_requested", basis: "none" };
  const date = parseAbsoluteWebDate(raw);
  if (!date) return { status: "unknown", basis: "none" };
  return {
    status: (dateFrom && date < dateFrom) || (dateTo && date > dateTo) ? "outside_range" : "within_range",
    basis,
    date,
  };
}
