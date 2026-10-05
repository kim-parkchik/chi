/** 表示・入力の変換ヘルパー */

/** 金額表示。マイナスは会計ソフトの慣例どおり ▲ で表す */
export const yen = (n: number, opts: { blankZero?: boolean } = {}) => {
  if (opts.blankZero && n === 0) return "";
  return n < 0 ? `▲${Math.abs(n).toLocaleString("ja-JP")}` : n.toLocaleString("ja-JP");
};

/** 全角数字・カンマ・円記号を許して整数にする。空なら null */
export const parseAmount = (raw: string): number | null => {
  const s = toHalfWidth(raw).replace(/[,，円¥\s]/g, "");
  if (s === "") return null;
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
};

export const toHalfWidth = (s: string) =>
  s.replace(/[０-９／－．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 日付の手入力を YYYY-MM-DD に変換する。
 * 「4/15」「0415」「415」「15」（当月扱い）でも入力できる。
 * @param year  会計年度
 * @param fallbackMonth 日だけ入力されたときの月
 */
export const parseDateInput = (raw: string, year: number, fallbackMonth: number): string | null => {
  const s = toHalfWidth(raw).trim().replace(/[.\-]/g, "/");
  if (!s) return null;
  let y = year, m: number, d: number;

  const full = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (full) {
    [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
  } else if (md) {
    [m, d] = [Number(md[1]), Number(md[2])];
  } else if (/^\d{8}$/.test(s)) {
    [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8))];
  } else if (/^\d{3,4}$/.test(s)) {
    m = Number(s.slice(0, s.length - 2));
    d = Number(s.slice(-2));
  } else if (/^\d{1,2}$/.test(s)) {
    m = fallbackMonth;
    d = Number(s);
  } else {
    return null;
  }
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

/** 2026-04-15 → 04/15 */
export const shortDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

/** 2026-04-15 → 2026年4月15日 */
export const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 会計年度内の「今日」。年度外なら年度末（過去年度）か年度初日（未来年度）を返す */
export const defaultDateInYear = (year: number) => {
  const t = todayIso();
  if (t.startsWith(`${year}-`)) return t;
  return Number(t.slice(0, 4)) > year ? `${year}-12-31` : `${year}-01-01`;
};
