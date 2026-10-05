import { expect, test } from "bun:test";
import { parseAmount, parseDateInput, yen } from "./format";

test("日付の省略入力", () => {
  expect(parseDateInput("4/15", 2026, 1)).toBe("2026-04-15");
  expect(parseDateInput("0415", 2026, 1)).toBe("2026-04-15");
  expect(parseDateInput("1231", 2026, 1)).toBe("2026-12-31");
  expect(parseDateInput("415", 2026, 1)).toBe("2026-04-15");
  expect(parseDateInput("７", 2026, 3)).toBe("2026-03-07");
  expect(parseDateInput("2/30", 2026, 1)).toBeNull();
  expect(parseDateInput("2026-02-28", 2026, 1)).toBe("2026-02-28");
});

test("金額", () => {
  expect(parseAmount("１２,３４５円")).toBe(12345);
  expect(parseAmount("")).toBeNull();
  expect(parseAmount("abc")).toBeNull();
  expect(yen(-1200)).toBe("▲1,200");
});
