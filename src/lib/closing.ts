/**
 * 年度の締め・繰越の確認（純粋関数）
 *
 *  - 繰越した年度は締め済みにし、そのままでは編集できない
 *  - 編集するには「締めの解除」を明示的に行う（厳密モードでは理由つきで履歴に残す）
 *  - 前の年度を直したら、翌年の期首残高が繰越額とずれるので、それを見つけて知らせる
 */
import type { Account, FiscalClosing, OpeningBalances, SubOpeningBalances } from "./types";
import { carryForwardWithSubs, closingBalances, subClosingBalances, type FlatLine } from "./accounting";

/** その日付を含む締め（無ければ undefined） */
export const closingOf = (closings: FiscalClosing[], date: string) =>
  closings.find((c) => c.period_start <= date && date <= c.period_end);

/**
 * 既存の帳簿で、自動で締める年度。
 * 翌年度の期首残高がある（＝繰越済み）かつ、その年度自体にデータがある年度
 * （データの無い年度まで締めると、一覧に空の年度が並んでしまうため）
 */
export const yearsToAutoClose = (openingYears: number[], dataYears: number[], closedYears: number[]) => {
  const opening = new Set(openingYears);
  const closed = new Set(closedYears);
  return [...new Set(dataYears)].filter((y) => opening.has(y + 1) && !closed.has(y)).sort((a, b) => a - b);
};

/** 年度末の残高から作った「翌年の期首残高」（繰越処理と同じ計算） */
export const expectedNextOpening = (
  accounts: Account[],
  opening: OpeningBalances,
  subOpening: SubOpeningBalances,
  lines: FlatLine[],
): SubOpeningBalances =>
  carryForwardWithSubs(accounts, closingBalances(accounts, opening, lines), subClosingBalances(accounts, subOpening, lines));

export interface OpeningMismatch {
  /** "科目ID:補助ID" */
  key: string;
  /** 繰越処理をやり直したときの金額 */
  expected: number;
  /** いま保存されている期首残高 */
  actual: number;
}

/** 期首残高の食い違い（0 と「なし」は同じとみなす） */
export const openingMismatches = (expected: SubOpeningBalances, actual: SubOpeningBalances): OpeningMismatch[] => {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const out: OpeningMismatch[] = [];
  for (const key of keys) {
    const e = expected[key] ?? 0;
    const a = actual[key] ?? 0;
    if (e !== a) out.push({ key, expected: e, actual: a });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true }));
};
