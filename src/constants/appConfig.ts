/** アプリ全体の設定値 */

export const APP_NAME = "chi";

/** 書類フォルダ内に作るフォルダ名 */
export const APP_DIR_NAME = "chi";
export const BACKUP_DIR_NAME = "Backup";

/** 帳簿データ（1ファイル = 1事業者） */
export const EXT_MAIN = "chik";
/** 以前の帳簿ファイルの拡張子（開けるように残しておく） */
export const EXT_LEGACY = ["chi"];
/** 帳簿ファイル（今の拡張子・以前の拡張子）か */
export const isBookFile = (path: string) => [EXT_MAIN, ...EXT_LEGACY].some((e) => path.toLowerCase().endsWith(`.${e}`));
/** 自動バックアップ */
export const EXT_BACKUP = "chib";
export const FILE_FILTER_NAME = "chi 帳簿ファイル";

/** DBスキーマのバージョン（マイグレーション用） */
export const SCHEMA_VERSION = 2;

/** バックアップを残す世代数（帳簿ごとに事業者設定で変えられる） */
export const DEFAULT_BACKUP_GENERATIONS = 100;
export const MAX_BACKUP_GENERATIONS = 999;

/** --- 上限 --- */
/** 証憑ファイル1件の上限（帳簿ファイルとバックアップが大きくなりすぎないように） */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
/** 補助科目は1科目あたりこの数まで（入力候補が多すぎると選びにくくなるため） */
export const MAX_SUB_ACCOUNTS_PER_ACCOUNT = 100;
/** 勘定科目は区分ごとにコードの範囲（100〜199 など）で区切るので、1区分あたり最大100科目 */
export const MAX_ACCOUNTS_PER_CATEGORY = 100;
