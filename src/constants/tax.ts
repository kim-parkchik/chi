/**
 * 消費税まわりの定義
 * 現在は「免税事業者・税込経理」のみ対応。ほかの選択肢は画面に出しつつ選べないようにしています。
 * 対応するときは enabled を true にし、集計ロジック（lib/accounting.ts）に税額計算を足します。
 */
import type { TaxMethod, TaxStatus } from "../lib/types";

export const TAX_STATUS_OPTIONS: { value: TaxStatus; label: string; enabled: boolean }[] = [
  { value: "exempt", label: "免税事業者", enabled: true },
  { value: "standard", label: "課税事業者（本則課税）", enabled: false },
  { value: "simplified", label: "課税事業者（簡易課税）", enabled: false },
  { value: "twenty", label: "課税事業者（2割特例）", enabled: false },
];

export const TAX_METHOD_OPTIONS: { value: TaxMethod; label: string; enabled: boolean }[] = [
  { value: "inclusive", label: "税込経理", enabled: true },
  { value: "exclusive", label: "税抜経理", enabled: false },
];

/** 仕訳の税区分（journal_lines.tax_code に入る予定の値） */
export const TAX_CODES = [
  { code: "none", label: "対象外" },
  { code: "sales10", label: "課税売上 10%" },
  { code: "sales8", label: "課税売上 8%（軽減）" },
  { code: "purchase10", label: "課税仕入 10%" },
  { code: "purchase8", label: "課税仕入 8%（軽減）" },
  { code: "exempt", label: "非課税" },
] as const;

export const TAX_DISABLED_NOTE = "免税事業者のため、税区分は「対象外」で固定です";
