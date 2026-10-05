/**
 * 会計ロジック（純粋関数のみ）
 * DBや画面に依存しないので bun test でそのまま検証できます。
 *
 * 金額の符号ルール:
 *   「残高」は常に科目の正常残高側（資産・費用なら借方、負債・資本・収益なら貸方）をプラスで表す。
 */
import type { Account, AccountCategory, JournalLine, OpeningBalances, Side, SubOpeningBalances, VoucherRow } from "./types";
import { subKey } from "./types";
import { CODE } from "../constants/accounts";

/** 帳簿計算用に、仕訳の日付・摘要を持った明細行 */
export interface FlatLine {
  entry_id: number;
  date: string;
  description: string;
  row_no: number;
  side: Side;
  account_id: number;
  sub_account_id: number | null;
  amount: number;
  memo: string;
  is_deleted?: number;
  revision?: number;
  /** 仕訳の取引先（任意） */
  counterparty_id?: number | null;
}

export type AccountMap = Map<number, Account>;

export const toAccountMap = (accounts: Account[]): AccountMap => new Map(accounts.map((a) => [a.id, a]));

/** 仕訳1行が科目残高に与える増減 */
export const signedAmount = (account: Account, side: Side, amount: number) =>
  side === account.normal_side ? amount : -amount;

// ────────────────────────────────────────────
// 集計
// ────────────────────────────────────────────

export interface Movement {
  debit: number;
  credit: number;
}

/** 期間内（from〜to、両端含む）の科目別 借方・貸方合計 */
export const sumMovements = (lines: FlatLine[], from?: string, to?: string): Map<number, Movement> => {
  const map = new Map<number, Movement>();
  for (const l of lines) {
    if (from && l.date < from) continue;
    if (to && l.date > to) continue;
    const m = map.get(l.account_id) ?? { debit: 0, credit: 0 };
    if (l.side === "debit") m.debit += l.amount;
    else m.credit += l.amount;
    map.set(l.account_id, m);
  }
  return map;
};

const netOf = (account: Account, m: Movement | undefined) =>
  !m ? 0 : account.normal_side === "debit" ? m.debit - m.credit : m.credit - m.debit;

const isBS = (c: AccountCategory) => c === "asset" || c === "liability" || c === "equity";

export interface TrialBalanceRow {
  account: Account;
  carried: number; // 前期（前月）繰越
  debit: number;
  credit: number;
  balance: number; // 期末（当月末）残高
}

/**
 * 残高試算表
 * @param periodFrom 集計期間の開始日（この日より前は「繰越」に入る）
 * @param periodTo   集計期間の終了日
 * @param yearStart  会計期間の開始日（貸借科目はここに期首残高が乗る）
 */
export const buildTrialBalance = (
  accounts: Account[],
  opening: OpeningBalances,
  lines: FlatLine[],
  yearStart: string,
  periodFrom: string,
  periodTo: string,
): TrialBalanceRow[] => {
  const before = sumMovements(lines, yearStart, prevDay(periodFrom));
  const during = sumMovements(lines, periodFrom, periodTo);
  return accounts.map((account) => {
    const base = isBS(account.category) ? opening[account.id] ?? 0 : 0;
    const carried = base + netOf(account, before.get(account.id));
    const m = during.get(account.id) ?? { debit: 0, credit: 0 };
    return {
      account,
      carried,
      debit: m.debit,
      credit: m.credit,
      balance: carried + netOf(account, m),
    };
  });
};

/** 期末残高（科目ID → 残高） */
export const closingBalances = (
  accounts: Account[],
  opening: OpeningBalances,
  lines: FlatLine[],
  to?: string,
): Map<number, number> => {
  const mv = sumMovements(lines, undefined, to);
  const map = new Map<number, number>();
  for (const a of accounts) {
    const base = isBS(a.category) ? opening[a.id] ?? 0 : 0;
    map.set(a.id, base + netOf(a, mv.get(a.id)));
  }
  return map;
};

// ────────────────────────────────────────────
// 損益
// ────────────────────────────────────────────

export interface IncomeSummary {
  revenue: number;      // 売上（収入）金額
  cogs: number;         // 売上原価
  grossProfit: number;  // 差引原価（売上総利益）
  expenses: number;     // 経費計
  beforeSpecial: number;// 差引金額
  special: number;      // 専従者給与
  income: number;       // 青色申告特別控除前の所得金額
}

/** 科目ID → 残高 から所得を計算 */
export const summarizeIncome = (accounts: Account[], balances: Map<number, number>): IncomeSummary => {
  let revenue = 0, cogs = 0, expenses = 0, special = 0;
  for (const a of accounts) {
    const b = balances.get(a.id) ?? 0;
    switch (a.category) {
      case "revenue": revenue += b; break;
      // 期末商品棚卸高（貸方科目）は原価から差し引く
      case "cogs": cogs += a.normal_side === "debit" ? b : -b; break;
      case "expense": expenses += b; break;
      case "special": special += b; break;
    }
  }
  const grossProfit = revenue - cogs;
  const beforeSpecial = grossProfit - expenses;
  return { revenue, cogs, grossProfit, expenses, beforeSpecial, special, income: beforeSpecial - special };
};

export interface BalanceSheetSummary {
  assets: number;
  liabilities: number;
  equity: number;
  income: number;
  /** 資産 −（負債 + 資本 + 所得）。0 なら貸借一致 */
  difference: number;
}

export const summarizeBalanceSheet = (accounts: Account[], balances: Map<number, number>): BalanceSheetSummary => {
  let assets = 0, liabilities = 0, equity = 0;
  for (const a of accounts) {
    const b = balances.get(a.id) ?? 0;
    if (a.category === "asset") assets += b;
    if (a.category === "liability") liabilities += b;
    if (a.category === "equity") equity += b;
  }
  const { income } = summarizeIncome(accounts, balances);
  return { assets, liabilities, equity, income, difference: assets - (liabilities + equity + income) };
};

/** 期首残高の貸借差額（資産 − 負債・資本）。0 なら一致 */
export const openingDifference = (accounts: Account[], opening: OpeningBalances) => {
  let debit = 0, credit = 0;
  for (const a of accounts) {
    if (!isBS(a.category)) continue;
    const v = opening[a.id] ?? 0;
    if (a.normal_side === "debit") debit += v;
    else credit += v;
  }
  return { debit, credit, difference: debit - credit };
};

// ────────────────────────────────────────────
// 繰越（個人事業主）
// ────────────────────────────────────────────

/**
 * 翌年の期首残高を作る。
 *  - 資産・負債はそのまま繰り越す
 *  - 事業主貸・事業主借は 0 にリセット
 *  - 元入金 = 元入金 + 所得 + 事業主借 − 事業主貸
 */
export const carryForward = (accounts: Account[], balances: Map<number, number>): OpeningBalances => {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const draw = byCode.get(CODE.OWNER_DRAW);
  const loan = byCode.get(CODE.OWNER_LOAN);
  const capital = byCode.get(CODE.CAPITAL);
  const { income } = summarizeIncome(accounts, balances);

  const next: OpeningBalances = {};
  for (const a of accounts) {
    if (!isBS(a.category)) continue;
    if (a === draw || a === loan) continue;
    const b = balances.get(a.id) ?? 0;
    if (b !== 0) next[a.id] = b;
  }
  if (capital) {
    const newCapital =
      (balances.get(capital.id) ?? 0) +
      income +
      (loan ? balances.get(loan.id) ?? 0 : 0) -
      (draw ? balances.get(draw.id) ?? 0 : 0);
    next[capital.id] = newCapital;
  }
  return next;
};

// ────────────────────────────────────────────
// 元帳・出納帳
// ────────────────────────────────────────────

/** 相手科目名（相手が1科目ならその名前、複数なら「諸口」） */
export const counterLabel = (entryLines: FlatLine[], line: FlatLine, accounts: AccountMap): string => {
  const ids = new Set(
    entryLines.filter((l) => l.side !== line.side && l.account_id !== line.account_id).map((l) => l.account_id),
  );
  if (ids.size === 0) return "";
  if (ids.size > 1) return "諸口";
  const [id] = [...ids];
  return accounts.get(id)?.name ?? "";
};

export interface LedgerRow {
  entry_id: number;
  date: string;
  /** この科目側の補助科目ID */
  subId: number | null;
  counter: string;
  counterAccountId: number | null;
  /** 相手側の補助科目（相手が1科目・1補助に定まるときだけ） */
  counterSubId: number | null;
  memo: string;
  debit: number;
  credit: number;
  balance: number;
  isCompound: boolean;
}

/** 指定科目の元帳（残高推移つき）。lines は会計期間内のものを渡す */
export const buildLedger = (
  account: Account,
  openingBalance: number,
  lines: FlatLine[],
  accounts: AccountMap,
  /** 補助科目で絞る：undefined = 全体、null = 補助なしのみ、数値 = その補助科目 */
  subFilter?: number | null,
): LedgerRow[] => {
  const byEntry = groupByEntry(lines);
  const mine = lines
    .filter((l) => l.account_id === account.id && matchSub(l, subFilter))
    .sort((x, y) => (x.date === y.date ? x.entry_id - y.entry_id || x.row_no - y.row_no : x.date < y.date ? -1 : 1));

  let balance = openingBalance;
  return mine.map((l) => {
    const entryLines = byEntry.get(l.entry_id) ?? [];
    balance += signedAmount(account, l.side, l.amount);
    const counter = counterLabel(entryLines, l, accounts);
    const counterIds = entryLines.filter((x) => x.side !== l.side && x.account_id !== account.id);
    return {
      entry_id: l.entry_id,
      date: l.date,
      subId: l.sub_account_id,
      counter,
      counterAccountId: counter !== "諸口" && counterIds.length > 0 ? counterIds[0].account_id : null,
      counterSubId:
        counter !== "諸口" && counterIds.length > 0 && new Set(counterIds.map((x) => x.sub_account_id ?? 0)).size === 1
          ? counterIds[0].sub_account_id ?? null
          : null,
      memo: l.memo || l.description,
      debit: l.side === "debit" ? l.amount : 0,
      credit: l.side === "credit" ? l.amount : 0,
      balance,
      isCompound: entryLines.length > 2,
    };
  });
};

const matchSub = (l: FlatLine, f: number | null | undefined) =>
  f === undefined ? true : f === null ? !l.sub_account_id : l.sub_account_id === f;

export const groupByEntry = (lines: FlatLine[]) => {
  const map = new Map<number, FlatLine[]>();
  for (const l of lines) {
    const arr = map.get(l.entry_id) ?? [];
    arr.push(l);
    map.set(l.entry_id, arr);
  }
  return map;
};

// ────────────────────────────────────────────
// 月次推移
// ────────────────────────────────────────────

export interface MonthlyRow {
  month: number;
  revenue: number;
  costs: number; // 売上原価 + 経費 + 専従者給与
  income: number;
}

export const buildMonthly = (accounts: Account[], lines: FlatLine[], year: number): MonthlyRow[] => {
  const rows: MonthlyRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const from = monthStart(year, m);
    const to = monthEnd(year, m);
    const mv = sumMovements(lines, from, to);
    const bal = new Map<number, number>();
    for (const a of accounts) bal.set(a.id, netOf(a, mv.get(a.id)));
    const s = summarizeIncome(accounts, bal);
    rows.push({ month: m, revenue: s.revenue, costs: s.cogs + s.expenses + s.special, income: s.income });
  }
  return rows;
};

// ────────────────────────────────────────────
// 振替伝票 ⇔ 仕訳明細
// ────────────────────────────────────────────

export const emptyRow = (): VoucherRow => ({
  debitAccountId: null,
  debitSubId: null,
  debitAmount: null,
  creditAccountId: null,
  creditSubId: null,
  creditAmount: null,
  memo: "",
});

const isBlankRow = (r: VoucherRow) =>
  !r.debitAccountId && !r.debitAmount && !r.creditAccountId && !r.creditAmount && !r.memo.trim();

export interface VoucherCheck {
  debitTotal: number;
  creditTotal: number;
  errors: string[];
}

export const checkVoucher = (rows: VoucherRow[]): VoucherCheck => {
  const errors: string[] = [];
  let debitTotal = 0, creditTotal = 0;
  rows.forEach((r, i) => {
    if (isBlankRow(r)) return;
    const n = i + 1;
    if (r.debitAmount && !r.debitAccountId) errors.push(`${n}行目：借方の科目を選んでください`);
    if (r.debitAccountId && !r.debitAmount) errors.push(`${n}行目：借方の金額を入れてください`);
    if (r.creditAmount && !r.creditAccountId) errors.push(`${n}行目：貸方の科目を選んでください`);
    if (r.creditAccountId && !r.creditAmount) errors.push(`${n}行目：貸方の金額を入れてください`);
    if ((r.debitAmount ?? 0) < 0 || (r.creditAmount ?? 0) < 0) errors.push(`${n}行目：金額はプラスで入力してください`);
    debitTotal += r.debitAmount ?? 0;
    creditTotal += r.creditAmount ?? 0;
  });
  if (debitTotal === 0 && creditTotal === 0) errors.push("金額が入力されていません");
  else if (debitTotal !== creditTotal)
    errors.push(`借方と貸方の合計が一致しません（差額 ${(debitTotal - creditTotal).toLocaleString()} 円）`);
  return { debitTotal, creditTotal, errors };
};

export const rowsToLines = (rows: VoucherRow[]): JournalLine[] => {
  const lines: JournalLine[] = [];
  let rowNo = 0;
  for (const r of rows) {
    if (isBlankRow(r)) continue;
    rowNo++;
    const memo = r.memo.trim();
    if (r.debitAccountId && r.debitAmount)
      lines.push({ row_no: rowNo, side: "debit", account_id: r.debitAccountId, sub_account_id: r.debitSubId, amount: r.debitAmount, memo });
    if (r.creditAccountId && r.creditAmount)
      lines.push({ row_no: rowNo, side: "credit", account_id: r.creditAccountId, sub_account_id: r.creditSubId, amount: r.creditAmount, memo });
  }
  return lines;
};

export const linesToRows = (lines: JournalLine[]): VoucherRow[] => {
  const byRow = new Map<number, VoucherRow>();
  for (const l of [...lines].sort((a, b) => a.row_no - b.row_no)) {
    const r = byRow.get(l.row_no) ?? emptyRow();
    if (l.side === "debit") {
      r.debitAccountId = l.account_id;
      r.debitSubId = l.sub_account_id ?? null;
      r.debitAmount = l.amount;
    } else {
      r.creditAccountId = l.account_id;
      r.creditSubId = l.sub_account_id ?? null;
      r.creditAmount = l.amount;
    }
    if (!r.memo && l.memo) r.memo = l.memo;
    byRow.set(l.row_no, r);
  }
  return [...byRow.values()];
};

// ────────────────────────────────────────────
// 補助科目
// ────────────────────────────────────────────

/** 補助科目単位の期末残高（貸借科目のみ）。キーは subKey(科目, 補助)、補助なしは 0 */
export const subClosingBalances = (
  accounts: Account[],
  subOpening: SubOpeningBalances,
  lines: FlatLine[],
): Map<string, number> => {
  const map = new Map<string, number>();
  const accById = toAccountMap(accounts);
  for (const [k, v] of Object.entries(subOpening)) map.set(k, v);
  for (const l of lines) {
    const a = accById.get(l.account_id);
    if (!a || !isBS(a.category)) continue;
    const k = subKey(l.account_id, l.sub_account_id);
    map.set(k, (map.get(k) ?? 0) + signedAmount(a, l.side, l.amount));
  }
  return map;
};

/**
 * 翌年の期首残高を補助科目単位で作る。
 * 科目合計は carryForward の結果に合わせ、補助ごとの内訳を引き継ぐ（差は「補助なし」に入れる）
 */
export const carryForwardWithSubs = (
  accounts: Account[],
  balances: Map<number, number>,
  subBalances: Map<string, number>,
): SubOpeningBalances => {
  const totals = carryForward(accounts, balances);
  const out: SubOpeningBalances = {};
  for (const [idStr, total] of Object.entries(totals)) {
    const id = Number(idStr);
    let subsSum = 0;
    for (const [k, v] of subBalances) {
      const [acc, sub] = k.split(":").map(Number);
      if (acc !== id || sub === 0 || v === 0) continue;
      out[k] = v;
      subsSum += v;
    }
    const rest = total - subsSum;
    if (rest !== 0) out[subKey(id, null)] = rest;
  }
  // 事業主貸・借などリセットされた科目の補助残高は引き継がない
  return out;
};

/** 補助科目ごとの試算表の1行 */
export const subTrialRow = (
  account: Account,
  subId: number | null,
  subOpening: SubOpeningBalances,
  lines: FlatLine[],
  yearStartIso: string,
  periodFrom: string,
  periodTo: string,
): TrialBalanceRow => {
  const filtered = lines.filter((l) => l.account_id === account.id && matchSub(l, subId));
  const base = isBS(account.category) ? subOpening[subKey(account.id, subId)] ?? 0 : 0;
  return buildTrialBalance([account], { [account.id]: base }, filtered, yearStartIso, periodFrom, periodTo)[0];
};

// ────────────────────────────────────────────
// 日付
// ────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
export const monthStart = (y: number, m: number) => `${y}-${pad(m)}-01`;
export const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
export const yearStart = (y: number) => `${y}-01-01`;
export const yearEnd = (y: number) => `${y}-12-31`;

export const prevDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
