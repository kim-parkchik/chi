/**
 * バックアップの世代管理（純粋関数）
 * バックアップ名は「帳簿名_YYYYMMDD-HHMMSS.拡張子」。日時の部分は文字列の順に並べると古い順になる
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 消すべきバックアップのファイル名（古いもの）。keep 世代より多い分だけ返す */
export const backupsToRemove = (fileNames: string[], bookName: string, ext: string, keep: number): string[] => {
  // 「帳簿_2」の帳簿に「帳簿」のバックアップが混ざらないよう、日時の形まで見て判定する
  const re = new RegExp(`^${escapeRe(bookName)}_(\\d{8}-\\d{6})\\.${escapeRe(ext)}$`);
  const mine = fileNames.filter((f) => re.test(f)).sort((a, b) => (re.exec(a)![1] < re.exec(b)![1] ? -1 : 1));
  const n = Math.max(1, Math.floor(keep));
  return mine.length > n ? mine.slice(0, mine.length - n) : [];
};
