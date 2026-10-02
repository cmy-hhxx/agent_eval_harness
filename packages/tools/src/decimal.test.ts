import test from "node:test";
import assert from "node:assert/strict";
import { calculate } from "./decimal.js";

test("decimal addition and subtraction preserve large cancellation and fractional values", () => {
  assert.deepEqual(calculate("subtract", ["10000000000000001", "10000000000000000"]), {
    operation: "subtract", operands: ["10000000000000001", "10000000000000000"],
    result: "1", precision: "exact decimal arithmetic",
  });
  assert.equal(calculate("add", ["0.1", "0.2"]).result, "0.3");
  assert.equal(calculate("subtract", ["1", "0.2", "0.3"]).result, "0.5");
  assert.equal(calculate("add", ["+001.20", "-.2", "1."]).result, "2");
  assert.equal(calculate("subtract", ["-0", "+0.000"]).result, "0");
});

test("decimal multiplication keeps signs, scientific notation and all significant digits", () => {
  assert.equal(calculate("multiply", ["-1.25", "-0.08", "1e+2"]).result, "10");
  assert.equal(calculate("multiply", ["1.234567890123456789", "10"]).result, "12.34567890123456789");
  assert.equal(calculate("multiply", ["3e-8", "2"]).result, "6e-8");
  assert.equal(calculate("multiply", ["2E20", "5"]).result, "1e+21");
  assert.equal(calculate("multiply", ["0", "1e-1000"]).result, "0");
});

test("division is exact for finite decimals and never rounds intermediate quotients", () => {
  assert.equal(calculate("divide", ["1", "8"]).result, "0.125");
  assert.equal(calculate("divide", ["1", "125"]).result, "0.008");
  assert.equal(calculate("divide", ["1", "40"]).result, "0.025");
  assert.equal(calculate("divide", ["-1", "-2", "-5"]).result, "-0.1");
  assert.deepEqual(calculate("divide", ["1", "3", "0.33333333333333333333333333333333333333333333333333"]), {
    operation: "divide", operands: ["1", "3", "0.33333333333333333333333333333333333333333333333333"],
    result: "1", precision: "34 significant digits; round half to even; rounded once after exact rational evaluation",
  });
  assert.equal(calculate("divide", ["1", "3", "1", "3"]).result, "0.1111111111111111111111111111111111");
  assert.equal(calculate("divide", ["1", "3", "0.1"]).result, "3.333333333333333333333333333333333");
  assert.equal(calculate("divide", ["1", "0.3", "10"]).result, "0.3333333333333333333333333333333333");
  assert.equal(calculate("divide", ["1", "3", "0.5"]).result, "0.6666666666666666666666666666666667");
  assert.equal(calculate("divide", ["1", "3", "0.3333333333333333333333333333333333"]).precision,
    "34 significant digits; round half to even; rounded once after exact rational evaluation");
  assert.equal(calculate("divide", ["1", "0.2", "0.5"]).precision, "exact decimal arithmetic");
});

test("a finite quotient retains more than 34 digits while recurring quotients declare rounding", () => {
  const exact = calculate("divide", ["1", "1e40"]);
  assert.equal(exact.result, "1e-40");
  assert.equal(exact.precision, "exact decimal arithmetic");
  const fiftyPlaces = calculate("divide", ["1", (2n ** 50n).toString()]);
  assert.equal(fiftyPlaces.result, "8.8817841970012523233890533447265625e-16");
  assert.equal(fiftyPlaces.precision, "exact decimal arithmetic");
  assert.equal(calculate("divide", ["-2", "3"]).result, "-0.6666666666666666666666666666666667");
  assert.equal(calculate("divide", ["1", "3e1000"]).result, "3.333333333333333333333333333333333e-1001");
  assert.equal(calculate("divide", ["29999999999999999999999999999999999", "30000000000000000000000000000000000"]).result, "1");
});

test("coefficient and exponent limits accept their boundaries and bound multi-operand work", () => {
  const thousandDigits = "9".repeat(1000);
  assert.equal(calculate("subtract", [thousandDigits, thousandDigits]).result, "0");
  assert.equal(calculate("multiply", ["1e1000", "1e-1000"]).result, "1");
  assert.equal(calculate("multiply", Array(20).fill("1e1000")).result, "1e+20000");
  assert.equal(calculate("multiply", Array(20).fill("1e-1000")).result, "1e-20000");
  assert.equal(calculate("divide", ["1e-1000", "2"]).result, "5e-1001");
  for (const value of ["1".repeat(1001), "1e1001", "1e-1001", "1e9999999999999999999999999"])
    assert.throws(() => calculate("add", [value, "1"]), /1000/);
});

test("invalid operations, operand counts, values and zero divisors are rejected", () => {
  assert.throws(() => calculate("power", ["1", "2"]), /不支持/);
  for (const operands of [[], ["1"], Array(21).fill("1")])
    assert.throws(() => calculate("add", operands), /2—20/);
  for (const value of ["", " ", " 1", "1 ", "1,000", "NaN", "Infinity", "0x10", "1e", "1.2.3", ".", "--1"])
    assert.throws(() => calculate("add", [value, "1"]), /十进制/);
  for (const zero of ["0", "-0", "+0.0", "0e1000"])
    assert.throws(() => calculate("divide", ["1", zero]), /零/);
});
