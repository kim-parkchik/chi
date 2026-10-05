/**
 * 改ざんの検知（純粋関数）
 *
 * 帳簿ファイルは普通の SQLite なので、ソフトを通さずに書き換えること自体は防げない。
 * ソースコードを公開しているので、ソフトの中に秘密の鍵を隠す方法も使えない。
 * そこで「できるところまで検知する」ために、次の3段で守る（厳密モードのみ）
 *
 *  1. 記録の連鎖（ハッシュチェーン）
 *     履歴を1件書くたびに、chain に「1つ前の行のハッシュ + 履歴の中身のハッシュ + 変更後の状態のハッシュ」
 *     からハッシュを作って積む。履歴を書き換え・削除すると、そこから先の連鎖が合わなくなる
 *  2. 今の状態との照合
 *     仕訳・証憑・期首残高・締めの「最後に記録した状態のハッシュ」と、今の中身を比べる。
 *     履歴を残さずに仕訳などを直接書き換えると食い違う
 *  3. 外部の控え（確認コード）
 *     連鎖をすべて計算し直されると 1・2 では見抜けない。年度の締めなどのときに連鎖の先頭のハッシュ
 *     （確認コード）をファイルの外に控えておけば、あとで照らし合わせて見つけられる。
 *     確実にしたい場合は、確認コードに有料のタイムスタンプを付ける
 */
import { sha256Hex } from "./evidence";

/** 連鎖の最初の「1つ前」 */
export const GENESIS = "0".repeat(64);

/** 確認コードの長さ（ハッシュの先頭。96ビットあれば狙って合わせることはできない） */
export const ANCHOR_LENGTH = 24;

export const hashText = (s: string) => sha256Hex(new TextEncoder().encode(s));

// ── 状態の正規形（同じ中身なら必ず同じ文字列になるように並べる） ──
export interface EntryStateInput {
  date: string;
  counterparty_id: number | null;
  is_deleted: number;
  revision: number;
}
export interface LineStateInput {
  row_no: number;
  side: string;
  account_id: number;
  sub_account_id: number | null;
  amount: number;
  memo: string;
}
const lineKey = (l: LineStateInput) => [l.row_no, l.side === "debit" ? 0 : 1, l.account_id, l.sub_account_id ?? 0, l.amount, l.memo];
const cmp = (a: unknown[], b: unknown[]) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return String(a[i]).localeCompare(String(b[i]), "en", { numeric: true });
  }
  return 0;
};

export const entryState = (e: EntryStateInput, lines: LineStateInput[]) =>
  JSON.stringify([e.date, e.counterparty_id ?? null, Number(e.is_deleted), Number(e.revision), lines.map(lineKey).sort(cmp)]);

export interface EvidenceStateInput {
  doc_type: string; txn_date: string; amount: number; counterparty: string; counterparty_id: number | null; memo: string;
  file_name: string; mime: string; size: number; sha256: string; revision: number; is_void: number;
}
export const evidenceState = (e: EvidenceStateInput, entryIds: number[]) =>
  JSON.stringify([e.doc_type, e.txn_date, e.amount, e.counterparty, e.counterparty_id ?? null, e.memo, e.file_name, e.mime,
    e.size, e.sha256, Number(e.revision), Number(e.is_void), [...entryIds].sort((a, b) => a - b)]);

export const openingState = (rows: { account_id: number; sub_account_id: number; amount: number }[]) =>
  JSON.stringify(rows.map((r) => [r.account_id, r.sub_account_id, r.amount]).sort(cmp));

export const closingState = (c: { period_start: string; period_end: string } | null) =>
  JSON.stringify(c ? [c.period_start, c.period_end] : null);

/**
 * 履歴の1行の正規形（列の順を固定）
 * 「?」つきの列はあとから足した列：値があるときだけ入れる（足す前に記録した行のハッシュが変わらないように）
 */
export const historyContent = (row: Record<string, unknown>, columns: readonly string[]) => {
  const out: unknown[] = [];
  for (const c of columns) {
    if (c.endsWith("?")) {
      const k = c.slice(0, -1);
      if (row[k] != null) out.push([k, row[k]]);
    } else out.push(row[c] ?? null);
  }
  return JSON.stringify(out);
};

export const HISTORY_COLUMNS = {
  entry_history: ["id", "entry_id", "revision", "action", "recorded_at", "reason", "snapshot", "user_id?"],
  master_history: ["id", "target_type", "target_id", "action", "fiscal_year", "label", "old_value", "new_value", "recorded_at", "user_id?"],
  evidence_history: ["id", "evidence_id", "revision", "action", "recorded_at", "reason", "snapshot", "user_id?"],
  integrity_events: ["id", "kind", "detail", "recorded_at", "user_id?"],
  access_log: ["id", "user_id", "action", "recorded_at"],
} as const;
export type ChainSource = keyof typeof HISTORY_COLUMNS;

export interface ChainLink {
  prev_hash: string;
  source: string;
  source_id: number;
  state_key: string;
  state_hash: string;
  content_hash: string;
}
export const chainHash = (l: ChainLink) =>
  hashText([l.prev_hash, l.source, l.source_id, l.state_key, l.state_hash, l.content_hash].join("\n"));

export interface ChainRow extends ChainLink {
  id: number;
  row_hash: string;
  recorded_at: string;
}

export interface IntegrityIssue {
  /** error = 改ざんの疑いが強い ／ warn = 確認が必要 */
  level: "error" | "warn";
  message: string;
}

/**
 * 連鎖をたどって確かめる
 * @param contentOf 履歴の今の中身（正規形）。無ければ undefined（＝消された）
 */
export const verifyChain = async (
  chain: ChainRow[],
  contentOf: (source: string, id: number) => string | undefined,
): Promise<IntegrityIssue[]> => {
  const issues: IntegrityIssue[] = [];
  let prev = GENESIS;
  for (const row of [...chain].sort((a, b) => a.id - b.id)) {
    if (row.prev_hash !== prev) {
      issues.push({ level: "error", message: `記録の連鎖が途切れています（連鎖 No.${row.id} の前の記録が消されたか、書き換えられています）` });
    }
    const content = contentOf(row.source, row.source_id);
    if (content === undefined) {
      issues.push({ level: "error", message: `${sourceLabel(row.source)} No.${row.source_id} が消されています` });
    } else if ((await hashText(content)) !== row.content_hash) {
      issues.push({ level: "error", message: `${sourceLabel(row.source)} No.${row.source_id} の内容が、記録したときから書き換えられています` });
    }
    if ((await chainHash(row)) !== row.row_hash) {
      issues.push({ level: "error", message: `記録の連鎖 No.${row.id} が書き換えられています` });
    }
    prev = row.row_hash;
  }
  return issues;
};

export const sourceLabel = (s: string) =>
  ({ entry_history: "仕訳の履歴", master_history: "科目・期首残高などの履歴", evidence_history: "証憑の履歴", integrity_events: "検知の記録", access_log: "利用の記録", baseline: "基準点" } as Record<string, string>)[s] ?? s;

/** 状態のキーの表示名 */
export const stateLabel = (key: string) => {
  const [kind, id] = key.split(":");
  return ({ entry: `仕訳（伝票 No.${id}）`, evidence: `証憑 No.${id}`, opening: `${id}年の期首残高`, closing: `${id}年の締め` })[kind] ?? key;
};

/** 連鎖の先頭から確認コードを作る（4文字ずつ区切る） */
export const anchorCode = (rowHash: string) => (rowHash.slice(0, ANCHOR_LENGTH).match(/.{4}/g) ?? []).join("-").toUpperCase();
export const normalizeAnchor = (code: string) => code.normalize("NFKC").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
