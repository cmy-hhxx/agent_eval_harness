const MAX_COEFFICIENT_DIGITS = 1000;
const MAX_EXPONENT = 1000;
const DIVISION_DIGITS = 34;
const EXACT_PRECISION = "exact decimal arithmetic";
const ROUNDED_PRECISION = "34 significant digits; round half to even; rounded once after exact rational evaluation";

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

const magnitude = (value: bigint) => value < 0n ? -value : value;
const powerOfTen = (exponent: number) => 10n ** BigInt(exponent);

function gcd(a: bigint, b: bigint): bigint {
  a = magnitude(a);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduced(numerator: bigint, denominator: bigint): Rational {
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function decimal(value: string): Rational {
  if (typeof value !== "string" || value.length > MAX_COEFFICIENT_DIGITS + 24)
    throw new Error("每个操作数的十进制系数最多 1000 位，科学计数法指数须在 -1000 到 1000 之间");
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!match) throw new Error("操作数须为十进制数值字符串，不含空白、单位或千位分隔符");
  const digits = match[2].replace(".", "");
  const exponent = Number(match[3] ?? 0);
  if (digits.length > MAX_COEFFICIENT_DIGITS || !Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT)
    throw new Error("每个操作数的十进制系数最多 1000 位，科学计数法指数须在 -1000 到 1000 之间");
  const coefficient = BigInt((match[1] === "-" ? "-" : "") + digits);
  const decimalPlaces = match[2].includes(".") ? match[2].length - match[2].indexOf(".") - 1 : 0;
  const scale = exponent - decimalPlaces;
  return scale >= 0
    ? { numerator: coefficient * powerOfTen(scale), denominator: 1n }
    : reduced(coefficient, powerOfTen(-scale));
}

function add(a: Rational, b: Rational, sign: bigint): Rational {
  const common = gcd(a.denominator, b.denominator);
  const aMultiplier = b.denominator / common;
  const bMultiplier = a.denominator / common;
  return reduced(a.numerator * aMultiplier + sign * b.numerator * bMultiplier, a.denominator * aMultiplier);
}

function multiply(a: Rational, b: Rational): Rational {
  const aCancellation = gcd(a.numerator, b.denominator);
  const bCancellation = gcd(b.numerator, a.denominator);
  return {
    numerator: (a.numerator / aCancellation) * (b.numerator / bCancellation),
    denominator: (a.denominator / bCancellation) * (b.denominator / aCancellation),
  };
}

/** Count prime factors in logarithmically many divisions, including very small finite decimals. */
function removeFactor(value: bigint, factor: bigint): { rest: bigint; count: number } {
  const powers: { value: bigint; count: number }[] = [];
  let power = factor, count = 1, total = 0;
  while (value % power === 0n) {
    value /= power;
    total += count;
    powers.push({ value: power, count });
    power *= power;
    count *= 2;
  }
  for (const item of powers.reverse()) {
    if (value % item.value === 0n) {
      value /= item.value;
      total += item.count;
    }
  }
  return { rest: value, count: total };
}

function formatDecimal(coefficient: bigint, exponent: number): string {
  if (coefficient === 0n) return "0";
  const sign = coefficient < 0n ? "-" : "";
  let digits = magnitude(coefficient).toString();
  const trimmed = digits.replace(/0+$/u, "");
  exponent += digits.length - trimmed.length;
  digits = trimmed;
  const point = digits.length + exponent;
  if (point > 21 || point <= -6) {
    const scientificExponent = point - 1;
    return sign + digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") +
      "e" + (scientificExponent >= 0 ? "+" : "") + scientificExponent;
  }
  if (exponent >= 0) return sign + digits + "0".repeat(exponent);
  if (point > 0) return sign + digits.slice(0, point) + "." + digits.slice(point);
  return sign + "0." + "0".repeat(-point) + digits;
}

function result(value: Rational): { result: string; precision: string } {
  if (value.numerator === 0n) return { result: "0", precision: EXACT_PRECISION };
  const twos = removeFactor(value.denominator, 2n);
  const fives = removeFactor(twos.rest, 5n);
  if (fives.rest === 1n) {
    const places = Math.max(twos.count, fives.count);
    const coefficient = value.numerator * 2n ** BigInt(places - twos.count) * 5n ** BigInt(places - fives.count);
    return { result: formatDecimal(coefficient, -places), precision: EXACT_PRECISION };
  }

  const numerator = magnitude(value.numerator), denominator = value.denominator;
  const lengthDifference = numerator.toString().length - denominator.toString().length;
  const abovePower = lengthDifference >= 0
    ? numerator >= denominator * powerOfTen(lengthDifference)
    : numerator * powerOfTen(-lengthDifference) >= denominator;
  const decimalExponent = lengthDifference - (abovePower ? 0 : 1);
  const scale = DIVISION_DIGITS - 1 - decimalExponent;
  const scaledNumerator = scale >= 0 ? numerator * powerOfTen(scale) : numerator;
  const scaledDenominator = scale >= 0 ? denominator : denominator * powerOfTen(-scale);
  let coefficient = scaledNumerator / scaledDenominator;
  const doubledRemainder = (scaledNumerator % scaledDenominator) * 2n;
  if (doubledRemainder > scaledDenominator || (doubledRemainder === scaledDenominator && coefficient % 2n !== 0n))
    coefficient++;
  if (value.numerator < 0n) coefficient = -coefficient;
  return { result: formatDecimal(coefficient, -scale), precision: ROUNDED_PRECISION };
}

/** Evaluate left to right exactly; round only a final non-terminating decimal quotient. */
export function calculate(operation: string, operands: string[]): {
  operation: string;
  operands: string[];
  result: string;
  precision: string;
} {
  if (!Array.isArray(operands) || operands.length < 2 || operands.length > 20)
    throw new Error("需要 2—20 个十进制数值字符串");
  if (!["add", "subtract", "multiply", "divide"].includes(operation)) throw new Error("不支持的运算");
  const values = operands.map(decimal);
  const evaluated = values.slice(1).reduce((a, b) => {
    if (operation === "add") return add(a, b, 1n);
    if (operation === "subtract") return add(a, b, -1n);
    if (operation === "multiply") return multiply(a, b);
    if (b.numerator === 0n) throw new Error("除数不能为零");
    return multiply(a, { numerator: b.numerator < 0n ? -b.denominator : b.denominator, denominator: magnitude(b.numerator) });
  }, values[0]);
  return { operation, operands, ...result(evaluated) };
}

/** Restricted arithmetic for evidence-backed review; exact rationals, with one final rounding. */
export function calculateExpression(expression: string, inputs: Record<string, string>) {
  if (expression.length > 1000) throw new Error("表达式最多1000字符");
  const tokens = expression.match(/[A-Za-z_][A-Za-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/-]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "") || tokens.length > 100) throw new Error("只支持变量、数字、四则运算和括号，最多100节点");
  let cursor = 0;
  const atom = (): Rational => {
    const token = tokens[cursor++];
    if (token === "(") { const value = sum(); if (tokens[cursor++] !== ")") throw new Error("括号不匹配"); return value; }
    if (token === "-") return multiply(decimal("-1"), atom());
    if (token === "+") return atom();
    if (!token) throw new Error("表达式不完整");
    return decimal(Object.hasOwn(inputs, token) ? inputs[token] : token);
  };
  const product = (): Rational => {
    let value = atom();
    while (["*", "/"].includes(tokens[cursor])) {
      const operation = tokens[cursor++], right = atom();
      if (operation === "/" && right.numerator === 0n) throw new Error("除数不能为零");
      value = multiply(value, operation === "*" ? right : { numerator: right.numerator < 0n ? -right.denominator : right.denominator, denominator: magnitude(right.numerator) });
    }
    return value;
  };
  const sum = (): Rational => {
    let value = product();
    while (["+", "-"].includes(tokens[cursor])) { const operation = tokens[cursor++]; value = add(value, product(), operation === "+" ? 1n : -1n); }
    return value;
  };
  const value = sum();
  if (cursor !== tokens.length) throw new Error("表达式存在剩余内容");
  return { ...result(value), exact_fraction: { numerator: value.numerator.toString(), denominator: value.denominator.toString() } };
}
