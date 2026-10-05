/**
 * 証憑（純粋関数）
 *  - ファイルの種類は拡張子ではなく中身で判定する。保存は受け取ったファイルのまま（変換しない）
 *  - ハッシュは SHA-256。登録時に記録し、あとで中身と照らし合わせて改ざんを確認する
 *  - 検索は、電子取引データの検索要件（取引年月日・取引金額の範囲指定、取引先、組み合わせ）に合わせる
 */
import type { Evidence, EvidenceMeta } from "./types";
import { EVIDENCE_MAIN_FORMATS, fileTypeOf, type EvidenceFileType } from "../constants/evidence";
import { MAX_EVIDENCE_BYTES } from "../constants/appConfig";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** バイト列の中に ASCII の文字列があるか（ZIP の中身の判定用） */
const containsAscii = (b: Uint8Array, text: string) => {
  const t = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + t.length <= b.length; i++) {
    for (let j = 0; j < t.length; j++) if (b[i + j] !== t[j]) continue outer;
    return true;
  }
  return false;
};

/** 先頭 8KB に NUL が無ければ文字のファイルとみなす */
const looksLikeText = (b: Uint8Array) => !b.subarray(0, 8192).includes(0);

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** HEIF 系（iPhone の写真など）の主なブランド */
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis"];
const HEIF_BRANDS = ["mif1", "msf1", "heif"];

/**
 * 中身から種類を判定する（対応外なら null）。
 * 拡張子は、中身だけでは区別できないときの手がかりにだけ使う（旧形式の Office、CSV とテキストなど）
 */
export const detectFileType = (bytes: Uint8Array, fileName = ""): EvidenceFileType | null => {
  const t = (mime: string) => fileTypeOf(mime)!;
  const ext = extOf(fileName);
  const b = bytes;
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return t("application/pdf"); // %PDF-
  if (startsWith(b, [0xff, 0xd8, 0xff])) return t("image/jpeg");
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return t("image/png");
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return t("image/gif");
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return t("image/webp");
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return t("image/tiff");
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (HEIC_BRANDS.includes(brand)) return t("image/heic");
    if (HEIF_BRANDS.includes(brand)) return t("image/heif");
    return null;
  }
  // ZIP（新しい Office の形式も中身は ZIP）
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    if (containsAscii(b, "xl/workbook")) return t("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    if (containsAscii(b, "word/document")) return t("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return t("application/zip");
  }
  // 旧形式の Office（中身だけでは Excel か Word か区別しにくいので拡張子で見る）
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === "xls") return t("application/vnd.ms-excel");
    if (ext === "doc") return t("application/msword");
    return null;
  }
  if (b.length > 0 && looksLikeText(b)) {
    const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("<?xml") || ext === "xml") return t("application/xml");
    if (ext === "csv") return t("text/csv");
    if (ext === "txt" || ext === "tsv") return t("text/plain");
    return null; // 文字のファイルでも、何のファイルか分からないものは受け付けない
  }
  return null;
};

export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.ceil(n / 1024)} KB` : `${n} B`;

/** 取り込めるファイルか（エラーの文言 or null） */
export const validateEvidenceFile = (bytes: Uint8Array, fileName = ""): string | null => {
  if (bytes.length === 0) return "空のファイルは取り込めません";
  if (bytes.length > MAX_EVIDENCE_BYTES) return `ファイルが大きすぎます（${formatBytes(bytes.length)}）。${formatBytes(MAX_EVIDENCE_BYTES)} までです`;
  if (!detectFileType(bytes, fileName)) return `この種類のファイルは取り込めません。取り込めるのは ${EVIDENCE_MAIN_FORMATS} です`;
  return null;
};

/** 文字のファイル（CSV・XML など）を表示用に読む。UTF-8 で読めなければ Shift_JIS（銀行の CSV に多い） */
export const decodeText = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
};

const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/** 検索要件の3項目（取引年月日・取引金額・取引先）は必須 */
export const validateEvidenceMeta = (m: EvidenceMeta): string | null => {
  if (!m.doc_type) return "書類の種類を選んでください";
  if (!isIsoDate(m.txn_date)) return "取引年月日を入れてください";
  if (!Number.isInteger(m.amount) || m.amount < 0) return "取引金額を入れてください（0 円以上の整数）";
  if (!m.counterparty.trim()) return "取引先を入れてください";
  if (m.counterparty.trim().length > 60) return "取引先は60文字までです";
  if (m.memo.length > 200) return "メモは200文字までです";
  return null;
};

export const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  const CHUNK = 0x8000; // 大きいファイルでも引数の上限に当たらないよう分けて変換する
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
};

export const fromBase64 = (b64: string) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

// ────────────────────────────────────────────
// 検索
// ────────────────────────────────────────────
export interface EvidenceFilter {
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number | null;
  amountMax?: number | null;
  /** 取引先（部分一致・大文字小文字と全角半角の違いは区別しない） */
  counterparty?: string;
  docType?: string;
  /** 仕訳にひも付いていないものだけ */
  unlinkedOnly?: boolean;
  includeVoid?: boolean;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export const filterEvidences = (list: Evidence[], f: EvidenceFilter) => {
  const cp = f.counterparty ? norm(f.counterparty) : "";
  return list.filter((e) => {
    if (!f.includeVoid && e.is_void) return false;
    if (f.dateFrom && e.txn_date < f.dateFrom) return false;
    if (f.dateTo && e.txn_date > f.dateTo) return false;
    if (f.amountMin != null && e.amount < f.amountMin) return false;
    if (f.amountMax != null && e.amount > f.amountMax) return false;
    if (cp && !norm(e.counterparty).includes(cp)) return false;
    if (f.docType && e.doc_type !== f.docType) return false;
    if (f.unlinkedOnly && e.entry_ids.length > 0) return false;
    return true;
  });
};

/**
 * 仕訳にひも付ける候補の並び順：金額が同じもの → 日付が近いもの
 * （請求書の日付と支払日はずれるので、日付では絞らずに並べるだけにする）
 */
export const rankCandidates = (list: Evidence[], date: string, amount: number) => {
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
  const d0 = day(date);
  return list
    .filter((e) => !e.is_void)
    .map((e) => ({ e, sameAmount: e.amount === amount ? 0 : 1, gap: Math.abs(day(e.txn_date) - d0) }))
    .sort((a, b) => a.sameAmount - b.sameAmount || a.gap - b.gap || a.e.id - b.e.id)
    .map((x) => x.e);
};

/**
 * 書き出すときのファイル名：取引年月日_取引先_金額_証憑番号.拡張子
 * （ファイル名だけで日付・取引先・金額がわかるようにしておくと、ソフトの外でも探しやすい）
 */
export const exportFileName = (e: Pick<Evidence, "id" | "txn_date" | "counterparty" | "amount" | "mime">) => {
  const ext = fileTypeOf(e.mime)?.ext ?? "bin";
  const safe = e.counterparty.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "取引先なし";
  return `${e.txn_date.replace(/-/g, "")}_${safe}_${e.amount}円_No${e.id}.${ext}`;
};
