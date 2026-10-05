import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, JournalLine } from "./types";
import { subKey } from "./types";
import {
  buildLedger, carryForwardWithSubs, subClosingBalances, subTrialRow, buildMonthly, buildTrialBalance, carryForward, checkVoucher, closingBalances,
  linesToRows, openingDifference, rowsToLines, summarizeBalanceSheet, summarizeIncome, toAccountMap, type FlatLine,
} from "./accounting";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;

let entryId = 0;
const lines: FlatLine[] = [];
const entry = (date: string, pairs: [string, number, "debit" | "credit", number?][]) => {
  entryId++;
  pairs.forEach(([name, amount, side, sub], i) =>
    lines.push({ entry_id: entryId, date, description: "", row_no: i + 1, side, account_id: id(name), sub_account_id: sub ?? null, amount, memo: "" }),
  );
};
const simple = (date: string, dr: string, cr: string, amount: number) =>
  entry(date, [[dr, amount, "debit"], [cr, amount, "credit"]]);

const opening = { [id("現金")]: 100_000, [id("普通預金")]: 500_000, [id("元入金")]: 600_000 };

simple("2026-01-10", "売掛金", "売上高", 300_000);
simple("2026-02-05", "普通預金", "売掛金", 300_000);
simple("2026-02-27", "地代家賃", "普通預金", 50_000);
simple("2026-03-10", "事業主貸", "普通預金", 100_000);
simple("2026-03-15", "消耗品費", "事業主借", 20_000);
entry("2026-04-20", [["通信費", 8_000, "debit"], ["事業主貸", 2_000, "debit"], ["普通預金", 10_000, "credit"]]);
simple("2026-05-01", "仕入高", "現金", 80_000);
simple("2026-12-31", "棚卸資産", "期末商品棚卸高", 30_000);

describe("所得と貸借", () => {
  const bal = closingBalances(accounts, opening, lines);
  test("所得計算（売上原価は期末棚卸を差し引く）", () => {
    const s = summarizeIncome(accounts, bal);
    expect(s.revenue).toBe(300_000);
    expect(s.cogs).toBe(50_000);
    expect(s.expenses).toBe(78_000);
    expect(s.income).toBe(172_000);
  });
  test("貸借が一致する", () => {
    const bs = summarizeBalanceSheet(accounts, bal);
    expect(bs.assets).toBe(792_000);
    expect(bs.difference).toBe(0);
  });
  test("期首残高の貸借一致", () => {
    expect(openingDifference(accounts, opening).difference).toBe(0);
  });
  test("繰越で元入金が再計算され、事業主貸・借がリセットされる", () => {
    const next = carryForward(accounts, bal);
    expect(next[id("元入金")]).toBe(690_000);
    expect(next[id("事業主貸")]).toBeUndefined();
    expect(next[id("事業主借")]).toBeUndefined();
    expect(next[id("普通預金")]).toBe(640_000);
    expect(openingDifference(accounts, next).difference).toBe(0);
  });
});

describe("試算表・元帳", () => {
  test("3月の試算表で前月繰越が正しい", () => {
    const tb = buildTrialBalance(accounts, opening, lines, "2026-01-01", "2026-03-01", "2026-03-31");
    const bank = tb.find((r) => r.account.name === "普通預金")!;
    expect(bank.carried).toBe(750_000);
    expect(bank.credit).toBe(100_000);
    expect(bank.balance).toBe(650_000);
    const sales = tb.find((r) => r.account.name === "売上高")!;
    expect(sales.carried).toBe(300_000);
  });
  test("元帳の相手科目と諸口", () => {
    const map = toAccountMap(accounts);
    const rows = buildLedger(map.get(id("普通預金"))!, 500_000, lines, map);
    expect(rows.map((r) => r.counter)).toEqual(["売掛金", "地代家賃", "事業主貸", "諸口"]);
    expect(rows.at(-1)!.balance).toBe(640_000);
  });
  test("月次推移", () => {
    const m = buildMonthly(accounts, lines, 2026);
    expect(m[0].revenue).toBe(300_000);
    expect(m[1].costs).toBe(50_000);
    expect(m.reduce((s, r) => s + r.income, 0)).toBe(172_000);
  });
});

describe("振替伝票", () => {
  test("貸借不一致を検出", () => {
    const r = checkVoucher([{ debitAccountId: 1, debitSubId: null, debitAmount: 100, creditAccountId: 2, creditSubId: null, creditAmount: 90, memo: "" }]);
    expect(r.errors.length).toBe(1);
  });
  test("行 ⇔ 明細の往復", () => {
    const rows = [
      { debitAccountId: 5, debitSubId: null, debitAmount: 8000, creditAccountId: 3, creditSubId: 7, creditAmount: 10000, memo: "通信費" },
      { debitAccountId: 20, debitSubId: null, debitAmount: 2000, creditAccountId: null, creditSubId: null, creditAmount: null, memo: "" },
    ];
    expect(checkVoucher(rows).errors).toEqual([]);
    const ls: JournalLine[] = rowsToLines(rows);
    expect(ls.length).toBe(3);
    expect(linesToRows(ls)).toEqual(rows.map((r, i) => (i === 1 ? { ...r, memo: "" } : r)));
  });
});

describe("補助科目", () => {
  // 普通預金を A銀行(補助1)・B銀行(補助2) に分ける
  const bank = id("普通預金");
  const subLines: FlatLine[] = [];
  let n = 100;
  const add = (date: string, dr: [number, number | null], cr: [number, number | null], amount: number) => {
    n++;
    subLines.push({ entry_id: n, date, description: "", row_no: 1, side: "debit", account_id: dr[0], sub_account_id: dr[1], amount, memo: "" });
    subLines.push({ entry_id: n, date, description: "", row_no: 1, side: "credit", account_id: cr[0], sub_account_id: cr[1], amount, memo: "" });
  };
  const subOpen = { [subKey(bank, 1)]: 300_000, [subKey(bank, 2)]: 200_000, [subKey(id("元入金"), null)]: 500_000 };
  const accOpen = { [bank]: 500_000, [id("元入金")]: 500_000 };
  add("2026-02-01", [bank, 1], [id("売上高"), null], 100_000);
  add("2026-03-01", [bank, 2], [bank, 1], 50_000); // A → B 振替
  add("2026-04-01", [id("通信費"), null], [bank, 2], 10_000);

  test("補助ごとの残高", () => {
    const sb = subClosingBalances(accounts, subOpen, subLines);
    expect(sb.get(subKey(bank, 1))).toBe(350_000);
    expect(sb.get(subKey(bank, 2))).toBe(240_000);
  });
  test("補助ごとの元帳と試算表", () => {
    const map = toAccountMap(accounts);
    const rows = buildLedger(map.get(bank)!, 200_000, subLines, map, 2);
    expect(rows.map((r) => r.balance)).toEqual([250_000, 240_000]);
    const tr = subTrialRow(map.get(bank)!, 1, subOpen, subLines, "2026-01-01", "2026-01-01", "2026-12-31");
    expect(tr.balance).toBe(350_000);
  });
  test("補助つきで繰り越しても科目合計は一致", () => {
    const bal = closingBalances(accounts, accOpen, subLines);
    const next = carryForwardWithSubs(accounts, bal, subClosingBalances(accounts, subOpen, subLines));
    expect(next[subKey(bank, 1)]).toBe(350_000);
    expect(next[subKey(bank, 2)]).toBe(240_000);
    expect(next[subKey(bank, null)]).toBeUndefined();
    expect(next[subKey(id("元入金"), null)]).toBe(590_000);
  });
});

import { splitByRate, yearEndRows } from "./homeUse";
describe("家事按分", () => {
  test("端数は事業分を切り捨て", () => {
    expect(splitByRate(10_001, 40)).toEqual({ business: 4000, private: 6001 });
    expect(splitByRate(10_000, 100)).toEqual({ business: 10_000, private: 0 });
  });
  test("年末一括：年間計上額から家事分を計算し、既存の振替は除く", () => {
    const util = id("水道光熱費");
    const ls: FlatLine[] = [
      { entry_id: 1, date: "2026-01-31", description: "", row_no: 1, side: "debit", account_id: util, sub_account_id: null, amount: 12_000, memo: "" },
      { entry_id: 2, date: "2026-02-28", description: "", row_no: 1, side: "debit", account_id: util, sub_account_id: null, amount: 8_000, memo: "" },
      { entry_id: 9, date: "2026-12-31", description: "", row_no: 1, side: "credit", account_id: util, sub_account_id: null, amount: 12_000, memo: "" },
    ];
    const rates = [{ account_id: util, from_year: 2026, rate: 40, method: "yearend" as const, basis: "" }];
    const [row] = yearEndRows(accounts, ls, rates, 9);
    expect(row.total).toBe(20_000);
    expect(row.business).toBe(8_000);
    expect(row.private).toBe(12_000);
  });
});
