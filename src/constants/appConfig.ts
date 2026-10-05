/** アプリ全体の設定値 */

export const APP_NAME = "chi";

/** 書類フォルダ内に作るフォルダ名 */
export const APP_DIR_NAME = "chi";
export const BACKUP_DIR_NAME = "Backup";

/** 帳簿データ（1ファイル = 1事業者） */
export const EXT_MAIN = "chi";
/** 自動バックアップ */
export const EXT_BACKUP = "chib";
export const FILE_FILTER_NAME = "chi 帳簿ファイル";

/** DBスキーマのバージョン（マイグレーション用） */
export const SCHEMA_VERSION = 2;

/** --- 上限 --- */
/** 補助科目は1科目あたりこの数まで（入力候補が多すぎると選びにくくなるため） */
export const MAX_SUB_ACCOUNTS_PER_ACCOUNT = 100;
/** 勘定科目は区分ごとにコードの範囲（100〜199 など）で区切るので、1区分あたり最大100科目 */
export const MAX_ACCOUNTS_PER_CATEGORY = 100;
