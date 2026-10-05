/**
 * 家事按分の計算（純粋関数）
 * 端数は「事業分を切り捨て、残りを家事分（事業主貸）」にする（経費を多く見積もらない側に倒す）
 */
import type { Account, HomeUseRate } from "./types";
import type { FlatLine } from "./accounting";

export const splitByRate = (amount: number, rate: number) => {
  const business = Math.floor((amount * rate) / 100);
  return { business, private: amount - business };
};

export interface YearEndRow {
  account: Account;
  rate: HomeUseRate;
  /** 年間の計上額（按分振替の仕訳を除く） */
  total: number;
  business: number;
  private: number;
}

/**
 * 年末一括方式の科目について、年間の計上額から家事分を計算する
 * @param excludeEntryId すでに作った按分振替の仕訳（作り直すときは計算から除く）
 */
export const yearEndRows = (
  accounts: Account[],
  lines: FlatLine[],
  rates: HomeUseRate[],
  excludeEntryId?: number,
): YearEndRow[] => {
  const rows: YearEndRow[] = [];
  for (const rate of rates) {
    if (rate.method !== "yearend" || rate.rate >= 100) continue;
    const account = accounts.find((a) => a.id === rate.account_id);
    if (!account) continue;
    const total = lines
      .filter((l) => l.account_id === account.id && l.entry_id !== excludeEntryId)
      .reduce((s, l) => s + (l.side === account.normal_side ? l.amount : -l.amount), 0);
    const { business, private: priv } = splitByRate(Math.max(0, total), rate.rate);
    rows.push({ account, rate, total, business, private: priv });
  }
  return rows;
};
