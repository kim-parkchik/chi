/** 勘定科目の区分 */
export type AccountCategory =
  | "asset"      // 資産
  | "liability"  // 負債
  | "equity"     // 資本（元入金・事業主借）
  | "revenue"    // 収益
  | "cogs"       // 売上原価
  | "expense"    // 経費
  | "special";   // 専従者給与など（所得計算の後段）

export type Side = "debit" | "credit";

export interface Account {
  id: number;
  code: string;
  name: string;
  kana: string;
  category: AccountCategory;
  normal_side: Side;
  sort_order: number;
  is_active: number; // 0 / 1
  /** 初期から入っている科目（削除・区分変更はできない） */
  is_system: number; // 0 / 1
}

/** 補助科目（例：普通預金 → ○○銀行、売掛金 → 取引先） */
export interface SubAccount {
  id: number;
  account_id: number;
  name: string;
  kana: string;
  sort_order: number;
  is_active: number;
}

export interface JournalLine {
  id?: number;
  entry_id?: number;
  row_no: number;
  side: Side;
  account_id: number;
  sub_account_id: number | null;
  amount: number; // 円（整数）
  memo: string;
}

export interface JournalEntry {
  id: number;
  date: string; // YYYY-MM-DD
  description: string;
  /** 取引先（任意） */
  counterparty_id: number | null;
  revision: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
  /** 登録した人・最後に変更した人（ユーザー名。ユーザーの機能を入れる前の仕訳は null） */
  created_by_name?: string | null;
  updated_by_name?: string | null;
  lines: JournalLine[];
}

/** 訂正・削除履歴の1件（電子帳簿保存法の「訂正削除履歴」に相当） */
export type HistoryAction = "create" | "update" | "delete";

export interface SnapshotLine {
  side: Side;
  account: string;
  sub: string;
  amount: number;
  memo: string;
}

/** 履歴に残す仕訳の写し。科目名は記録時点の名前で保存する */
export interface EntrySnapshot {
  date: string;
  /** 取引先の名前（記録時点。取引先の機能を入れる前の履歴には無い） */
  counterparty?: string;
  lines: SnapshotLine[];
}

export interface HistoryRecord {
  id: number;
  entry_id: number;
  revision: number;
  action: HistoryAction;
  recorded_at: string;
  reason: string;
  snapshot: EntrySnapshot;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 振替伝票の1行（借方・貸方のペア） */
export interface VoucherRow {
  debitAccountId: number | null;
  debitSubId: number | null;
  debitAmount: number | null;
  creditAccountId: number | null;
  creditSubId: number | null;
  creditAmount: number | null;
  memo: string;
}

export type FilingType = "blue65" | "blue55" | "blue10" | "white";
export type TaxStatus = "exempt" | "standard" | "simplified" | "twenty";
export type TaxMethod = "inclusive" | "exclusive";
/** strict = 電子帳簿保存法（優良な電子帳簿）対応、standard = 通常 */
export type EBookMode = "strict" | "standard";

export interface Settings {
  business_name: string;
  owner_name: string;
  fiscal_year: number;
  filing_type: FilingType;
  industry: string;
  tax_status: TaxStatus;
  tax_method: TaxMethod;
  /** 帳簿作成時に一度だけ決める。null = 未選択 */
  e_book_mode: EBookMode | null;
}

/** 期首残高: account_id → 金額（科目の正常残高側をプラスとする。補助科目の分も合算） */
export type OpeningBalances = Record<number, number>;

/** 補助科目ごとの期首残高: "科目ID:補助ID" → 金額（補助ID 0 は「補助なし」） */
export type SubOpeningBalances = Record<string, number>;
export const subKey = (accountId: number, subId: number | null) => `${accountId}:${subId ?? 0}`;

/** 科目・補助科目・期首残高の変更履歴 */
export interface MasterHistoryRecord {
  id: number;
  target_type: "account" | "sub" | "opening" | "homeuse" | "closing" | "counterparty" | "user";
  target_id: number;
  /** close / unlock は年度の締め（target_type = closing、target_id = 年度） */
  action: "create" | "rename" | "hide" | "show" | "delete" | "change" | "close" | "unlock";
  fiscal_year: number;
  label: string;
  old_value: string;
  new_value: string;
  recorded_at: string;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 家事按分の設定（その年度に有効なもの） */
export type HomeUseMethod = "entry" | "yearend";
export interface HomeUseRate {
  account_id: number;
  from_year: number;
  /** 事業で使っている割合（%） */
  rate: number;
  method: HomeUseMethod;
  basis: string;
}

/** 証憑 */
export type EvidenceKind = "electronic" | "scan";
/** 利用者が入力・訂正できる項目 */
export interface EvidenceMeta {
  doc_type: string;
  /** 取引年月日 */
  txn_date: string;
  /** 取引金額（円） */
  amount: number;
  /** 取引先 */
  counterparty: string;
  memo: string;
}
export interface Evidence extends EvidenceMeta {
  id: number;
  /** 取引先一覧の取引先（取引先名が一覧の名前と一致したときに入る。任意） */
  counterparty_id: number | null;
  kind: EvidenceKind;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  revision: number;
  is_void: number;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  /** ひも付いている仕訳の伝票番号 */
  entry_ids: number[];
}
/** 証憑の履歴に残す写し */
export interface EvidenceSnapshot extends EvidenceMeta {
  kind: EvidenceKind;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  entry_ids: number[];
}
export type EvidenceAction = "create" | "update" | "void" | "link" | "unlink";
export interface EvidenceHistoryRecord {
  id: number;
  evidence_id: number;
  revision: number;
  action: EvidenceAction;
  recorded_at: string;
  reason: string;
  snapshot: EvidenceSnapshot;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 取引先（任意で使う）。仕訳1件に1つ、証憑にも付けられる */
export interface Counterparty {
  id: number;
  name: string;
  kana: string;
  /** 適格請求書発行事業者の登録番号（T + 13桁。無ければ空） */
  invoice_no: string;
  memo: string;
  is_active: number;
}

/** 年度の締め（行があれば締め済み） */
export interface FiscalClosing {
  fiscal_year: number;
  period_start: string;
  period_end: string;
  closed_at: string;
  /** 締めたときの記録の連鎖の先頭（確認コードのもと。厳密モードのみ） */
  chain_head: string;
}

/** ユーザー（権限はまだ分けない。誰が操作したかを記録するため） */
export interface User {
  id: number;
  name: string;
  /** パスワードを設定しているか */
  has_password: number;
  is_active: number;
  created_at: string;
}

export interface AccessLogRecord {
  id: number;
  user_id: number;
  user_name: string;
  action: "login" | "logout";
  recorded_at: string;
}
