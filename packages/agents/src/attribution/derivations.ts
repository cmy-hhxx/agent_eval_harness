import { ValidationError, type ValidationIssue } from "@eval/contracts";
import { calculateExpression } from "@eval/tools";

export interface DerivationOperandSubmission {
  value: string;
  evidence_index: number;
  unit: string;
  period: string;
  role: string;
}
export interface DerivationOperandResolved extends Omit<DerivationOperandSubmission, "evidence_index"> {
  evidence_id: string;
}
export interface DerivationRange {
  lower: string;
  upper: string;
  include_lower: boolean;
  include_upper: boolean;
}
interface DerivationFields {
  label: string;
  operation: "比值" | "相对变化" | "复利增长" | "年化" | "四则运算";
  result: string | DerivationRange;
  /** Display multiplier, not an error tolerance. Percent results use 100. */
  scale: "1" | "100";
  decimal_places: number;
  result_unit: string;
  result_period: string;
  assumptions: string[];
  denominator_role?: string;
  formula?: string;
  factor?: string;
  observation_period?: string;
  target_period?: string;
  result_basis?: "按当前速度年化";
}
export interface DerivationSubmission extends DerivationFields {
  operands: Record<string, DerivationOperandSubmission>;
}
export interface ResolvedDerivation extends DerivationFields {
  operands: Record<string, DerivationOperandResolved>;
}
type Source = { evidence_id: string; quote: string };
const numberValue = (value: string) => value.replaceAll(",", "");
const fraction = (expression: string, inputs: Record<string, string>) => calculateExpression(expression, inputs).exact_fraction;
const sign = (value: { numerator: string }) => BigInt(value.numerator) < 0n ? -1 : BigInt(value.numerator) > 0n ? 1 : 0;

/** Compare the submitted decimal with one half-even rounding of the exact rational. */
function matchesRounded(expression: string, inputs: Record<string, string>, submitted: string, places: number): boolean {
  const exact = fraction(expression, inputs), numerator = BigInt(exact.numerator), denominator = BigInt(exact.denominator);
  const scaled = (numerator < 0n ? -numerator : numerator) * 10n ** BigInt(places);
  let rounded = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n > denominator || remainder * 2n === denominator && rounded % 2n !== 0n) rounded++;
  if (numerator < 0n) rounded = -rounded;
  const proposed = fraction("value", { value: submitted });
  return BigInt(proposed.numerator) * 10n ** BigInt(places) === rounded * BigInt(proposed.denominator);
}

/** Recompute submitted numbers and units; source contents and economic interpretation are not acceptance gates. */
export function validateDerivations(rows: readonly ResolvedDerivation[], path = "/calculations"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reject = (at: string, code: string, message: string, actual?: unknown) => {
    issues.push({ category: "decision", code, path: at, message, ...(actual === undefined ? {} : { actual }) });
  };
  rows.forEach((row, index) => {
    const at = `${path}/${index}`, before = issues.length;
    const invalid = (suffix: string, message: string, actual?: unknown) => reject(`${at}${suffix}`, "derivation_invalid", message, actual);
    const operands = row.operands, names = Object.keys(operands), values: Record<string, string> = {};
    if (!Number.isInteger(row.decimal_places) || row.decimal_places < 0 || row.decimal_places > 12 || !["1", "100"].includes(row.scale))
      invalid("/decimal_places", "decimal_places须为0—12；scale仅为1或100的显示倍率。");
    for (const field of ["label", "result_unit", "result_period"] as const)
      if (!row[field]?.trim()) invalid(`/${field}`, "计算必须声明用途、结果单位和期间。");
    for (const [name, operand] of Object.entries(operands)) {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name) || name === "display_scale") invalid(`/operands/${name}`, "操作数名须为合法变量名，display_scale为程序保留名。");
      if (![operand.unit, operand.period, operand.role].every(item => typeof item === "string" && item.trim()))
        invalid(`/operands/${name}`, "每个操作数须声明单位、期间和业务角色。");
      try { values[name] = numberValue(operand.value); calculateExpression(name, { [name]: values[name] }); }
      catch { invalid(`/operands/${name}/value`, "原数token须为有限十进制数值，可含规范千分位。", operand.value); }
    }
    if (issues.length !== before) return;
    const requireNames = (...expected: string[]) => {
      if (names.length !== expected.length || expected.some(name => !Object.hasOwn(operands, name)))
        invalid("/operands", `该运算须且仅须操作数：${expected.join("、")}。`, names);
    };
    const sameUnits = (a: string, b: string) => {
      if (operands[a] && operands[b] && operands[a].unit !== operands[b].unit) invalid("/operands", "被比较的操作数单位不一致；须先以有证据的换算单独计算。");
    };
    const denominator = (name: string) => {
      if (operands[name] && row.denominator_role !== operands[name].role)
        invalid("/denominator_role", "denominator_role必须与实际分母操作数的role一致，不能互换成本和市值口径。");
    };
    const allowed = row.operation === "四则运算" ? ["formula"] : row.operation === "比值" || row.operation === "相对变化" ? ["denominator_role"] : row.operation === "年化" ? ["factor", "observation_period", "target_period", "result_basis"] : [];
    for (const field of ["formula", "denominator_role", "factor", "observation_period", "target_period", "result_basis"] as const)
      if (row[field] !== undefined && !allowed.includes(field)) invalid(`/${field}`, "该字段不适用于本运算，须按实际运算重新提交。");
    if (["比值", "相对变化"].includes(row.operation) && (row.scale === "100") !== (row.result_unit === "%"))
      invalid("/scale", "比值或变化率的百分数显示必须同时声明scale=100和result_unit=%，避免倍率与单位不一致。");
    let expression = "", upperExpression: string | undefined;
    try {
      if (row.operation === "比值") {
        if (typeof row.result === "object") {
          requireNames("numerator", "denominator_lower", "denominator_upper");
          denominator("denominator_lower"); denominator("denominator_upper"); sameUnits("denominator_lower", "denominator_upper");
          if (operands.denominator_lower?.period !== operands.denominator_upper?.period) invalid("/operands", "区间两端的期间必须一致。");
          if (issues.length === before && (sign(fraction("numerator", values)) < 0 || sign(fraction("denominator_lower", values)) <= 0 || sign(fraction("denominator_upper-denominator_lower", values)) < 0))
            invalid("/operands", "区间比值要求非负分子、正分母和有序的分母上下界。");
          expression = "numerator/denominator_upper"; upperExpression = "numerator/denominator_lower";
        } else { requireNames("numerator", "denominator"); denominator("denominator"); expression = "numerator/denominator"; }
      } else if (row.operation === "相对变化") {
        requireNames("base", "observed"); sameUnits("base", "observed"); denominator("base");
        expression = "(observed-base)/base";
      } else if (row.operation === "复利增长") {
        const hasBase = Object.hasOwn(operands, "base");
        requireNames(...hasBase ? ["base", "rate", "periods"] : ["rate", "periods"]);
        const count = Number(values.periods);
        if (!Number.isInteger(count) || count < 1 || count > 20 || !["比值", "%"].includes(operands.rate?.unit) || operands.periods?.unit !== "期")
          invalid("/operands", "累计复利使用比值或%单位的每期利率及1—20整数期数；不把该运算当作CAGR反推。");
        if (hasBase ? operands.base.unit !== row.result_unit : row.result_unit !== "比值")
          invalid("/result_unit", "有base时累计复利结果与base同单位；无base时计算增长倍数，result_unit须为比值。");
        if (issues.length === before) {
          values.growth_factor = calculateExpression(operands.rate.unit === "%" ? "1+rate/100" : "1+rate", values).result;
          expression = hasBase ? `base${"*growth_factor".repeat(count)}` : Array(count).fill("growth_factor").join("*");
        }
      } else if (row.operation === "年化") {
        requireNames("value");
        if (!row.observation_period?.trim() || !row.target_period?.trim() || operands.value?.period !== row.observation_period || row.result_period !== row.target_period)
          invalid("/observation_period", "年化须明确观察期间和目标期间，并与操作数、结果的期间分别一致。");
        if (row.result_basis !== "按当前速度年化" || !row.assumptions?.some(item => item.trim()))
          invalid("/result_basis", "按观察期外推仅为run_rate，必须保留外推假设，不能冒充全年指引。");
        if (operands.value?.unit !== row.result_unit) invalid("/result_unit", "年化结果须保留原值单位。");
        if (!row.factor || sign(fraction("factor", { factor: row.factor })) <= 0) invalid("/factor", "年化factor须为正十进制倍率，并由assumptions说明依据。");
        values.factor = row.factor ?? ""; expression = "value*factor";
      } else if (row.operation === "四则运算") {
        if (!row.formula?.trim() || !names.length) invalid("/formula", "四则运算须声明formula及有来源操作数。");
        expression = row.formula ?? "";
        const tokens: string[] = expression.match(/[A-Za-z_][A-Za-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gu) ?? [];
        const variables = tokens.filter(token => /^[A-Za-z_]/u.test(token));
        if (names.some(name => !variables.includes(name))) invalid("/operands", "操作数必须实际参与formula，不能用无关证据占位。");
        for (const token of tokens.filter(token => !/^[A-Za-z_]/u.test(token))) {
          const literal = fraction(token, {}), numerator = BigInt(literal.numerator), denominator = BigInt(literal.denominator);
          const identity = numerator === 0n || numerator === 1n && denominator === 1n;
          const unitScale = denominator === 1n && /^10*$/u.test(numerator.toString()) || numerator === 1n && /^10*$/u.test(denominator.toString());
          if (!identity && !unitScale) invalid("/formula", "公式常数仅允许0、1及十进制单位倍率；其他数值必须来自绑定证据的操作数。", token);
          else if (!identity && !row.assumptions.some(item => item.trim())) invalid("/assumptions", "单位倍率须在assumptions中说明原单位、目标单位与换算依据，不能当作源事实或被评模型动作证据。");
        }
      } else invalid("/operation", "不支持的派生运算。");
      if (issues.length !== before) return;
      values.display_scale = row.scale;
      const scaled = `(${expression})*display_scale`;
      if (typeof row.result === "string") {
        if (!matchesRounded(scaled, values, row.result, row.decimal_places)) reject(`${at}/result`, "derivation_result_mismatch", "结果与源数复算及声明精度不符；修改计算或结论后重新提交，不自动改写。", row.result);
      } else {
        if (!upperExpression || typeof row.result.include_lower !== "boolean" || typeof row.result.include_upper !== "boolean") invalid("/result", "上下界结果仅用于区间比值，且必须声明两端是否包含。");
        else if (sign(fraction("upper-lower", { upper: row.result.upper, lower: row.result.lower })) < 0 ||
          !matchesRounded(scaled, values, row.result.lower, row.decimal_places) ||
          !matchesRounded(`(${upperExpression})*display_scale`, values, row.result.upper, row.decimal_places))
          reject(`${at}/result`, "derivation_result_mismatch", "结果上下界与源数区间复算不符；正分母范围的较大端对应比值下界。", row.result);
      }
    } catch (error) { invalid("/result", `计算无法执行：${error instanceof Error ? error.message : String(error)}`); }
  });
  return issues;
}

/** Bind identity mechanically, then reject invalid derivations without rewriting any verdict. */
export function resolveDerivations(rows: readonly DerivationSubmission[], resolveEvidence: (index: number, path: string) => Source, path = "/calculations"): ResolvedDerivation[] {
  const resolved = rows.map((row, index) => ({ ...row, operands: Object.fromEntries(Object.entries(row.operands).map(([name, operand]) => {
    const { evidence_index, ...fields } = operand;
    const evidence = resolveEvidence(evidence_index, `${path}/${index}/operands/${name}/evidence_index`);
    return [name, { ...fields, evidence_id: evidence.evidence_id }];
  })) }));
  const issues = validateDerivations(resolved, path);
  if (issues.length) throw new ValidationError(issues);
  return resolved;
}
