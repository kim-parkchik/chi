import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, FiscalClosing } from "./types";
import { subKey } from "./types";
import type { FlatLine } from "./accounting";
import { closingOf, expectedNextOpening, openingMismatches, yearsToAutoClose } from "./closing";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;

describe("年度の締め", () => {
  const closings: FiscalClosing[] = [
    { fiscal_year: 2025, period_start: "2025-01-01", period_end: "2025-12-31", closed_at: "" },
  ];
  test("日付から締めを引く（期間の両端を含む）", () => {
    expect(closingOf(closings, "2025-01-01")?.fiscal_year).toBe(2025);
    expect(closingOf(closings, "2025-12-31")?.fiscal_year).toBe(2025);
    expect(closingOf(closings, "2026-01-01")).toBeUndefined();
    expect(closingOf(closings, "2024-12-31")).toBeUndefined();
  });

  test("自動で締めるのは、翌年度の期首残高があってデータのある年度だけ", () => {
    // 2024：データあり・2025の期首あり → 締める
    // 2025：データあり・2026の期首あり、ただし締め済み → 対象外
    // 2026：翌年の期首なし → 対象外
    // 2023：データなし（2024 の期首を手入力しただけ）→ 対象外
    expect(yearsToAutoClose([2024, 2025, 2026], [2024, 2025, 2026], [2025])).toEqual([2024]);
  });
});

describe("繰越額とのずれ", () => {
  const cash = id("現金");
  const sales = id("売上高");
  const capital = id("元入金");
  const opening = { [cash]: 100_000, [capital]: 100_000 };
  const subOpening = { [subKey(cash, null)]: 100_000, [subKey(capital, null)]: 100_000 };
  const lines: FlatLine[] = [
    { entry_id: 1, date: "2025-03-01", description: "", row_no: 1, side: "debit", account_id: cash, sub_account_id: null, amount: 50_000, memo: "" },
    { entry_id: 1, date: "2025-03-01", description: "", row_no: 1, side: "credit", account_id: sales, sub_account_id: null, amount: 50_000, memo: "" },
  ];

  test("繰越した直後はずれなし", () => {
    const next = expectedNextOpening(accounts, opening, subOpening, lines);
    expect(openingMismatches(next, { ...next })).toEqual([]);
  });

  test("前年を直すと、ずれた科目と金額がわかる", () => {
    const saved = expectedNextOpening(accounts, opening, subOpening, lines);
    // 前年に売上 10,000 を追加入力した
    const fixed = [...lines,
      { ...lines[0], entry_id: 2, amount: 10_000 },
      { ...lines[1], entry_id: 2, amount: 10_000 },
    ];
    const diff = openingMismatches(expectedNextOpening(accounts, opening, subOpening, fixed), saved);
    expect(diff).toEqual([
      { key: subKey(cash, null), expected: 160_000, actual: 150_000 },
      { key: subKey(capital, null), expected: 160_000, actual: 150_000 },
    ].sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true })));
  });

  test("0 と「なし」は同じ扱い", () => {
    expect(openingMismatches({ "1:0": 0 }, {})).toEqual([]);
  });
});

import { historyContent } from "./integrity";
describe("記録の連鎖：あとから足した列", () => {
  test("値が無ければ、足す前と同じ中身になる（過去の記録のハッシュが変わらない）", () => {
    const row = { id: 1, kind: "x", detail: "d", recorded_at: "t" };
    expect(historyContent({ ...row, user_id: null }, ["id", "kind", "detail", "recorded_at", "user_id?"])).toBe(
      historyContent(row, ["id", "kind", "detail", "recorded_at"]),
    );
    expect(historyContent({ ...row, user_id: 3 }, ["id", "kind", "detail", "recorded_at", "user_id?"])).toContain('["user_id",3]');
  });
});
