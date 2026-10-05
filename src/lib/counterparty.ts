/**
 * 取引先（純粋関数）
 *  - 使うかどうかは任意。仕訳1件に1つ、証憑にも付けられる
 *  - 適格請求書発行事業者の登録番号は「T + 13桁」。任意
 */
import type { Counterparty } from "./types";

/** 名前の比較用（全角半角・大文字小文字・空白の違いを無視） */
export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** 登録番号を「T1234567890123」の形にそろえる（全角・ハイフン・空白を許す） */
export const normalizeInvoiceNo = (raw: string) => raw.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");

export const isValidInvoiceNo = (s: string) => /^T\d{13}$/.test(s);

export interface CounterpartyInput {
  name: string;
  kana: string;
  invoice_no: string;
  memo: string;
}

export const validateCounterparty = (list: Counterparty[], d: CounterpartyInput, editingId?: number): string | null => {
  const name = d.name.trim();
  if (!name) return "取引先名を入れてください";
  if (name.length > 60) return "取引先名は60文字までです";
  if (list.some((c) => c.id !== editingId && normName(c.name) === normName(name))) return "同じ名前の取引先があります";
  const inv = normalizeInvoiceNo(d.invoice_no);
  if (inv && !isValidInvoiceNo(inv)) return "登録番号は「T」と13桁の数字です（例：T1234567890123）";
  if (inv && list.some((c) => c.id !== editingId && c.invoice_no === inv)) return "同じ登録番号の取引先があります";
  if (d.memo.length > 200) return "メモは200文字までです";
  return null;
};

/** 入力された名前から取引先を探す（名前の完全一致。表記ゆれは normName で吸収） */
export const findCounterparty = (list: Counterparty[], text: string) => {
  const n = normName(text);
  return n ? list.find((c) => normName(c.name) === n) ?? null : null;
};
