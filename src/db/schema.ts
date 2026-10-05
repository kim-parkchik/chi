/**
 * データベース定義
 *
 * 方針
 *  - 金額はすべて INTEGER（円）。浮動小数点は使わない
 *  - 仕訳は物理削除しない。削除は「削除済み」の印をつけるだけ（論理削除）
 *  - 登録・訂正・削除のたびに、その時点の仕訳の写しを entry_history に積み上げる
 *  - entry_history はトリガーで「書き換え・削除不可」にしている
 *    （電子帳簿保存法の「訂正・削除の事実と内容を確認できること」を意識した作り）
 *  - ただし SQLite ファイル自体を外部ツールで直接いじることは防げない。
 *    ここは「ソフトとして保証できる範囲」と「保存要件」の差として研究上の論点になる
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    business_name TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    fiscal_year INTEGER NOT NULL,
    filing_type TEXT NOT NULL DEFAULT 'blue65',
    tax_status TEXT NOT NULL DEFAULT 'exempt',   -- 消費税：今は免税のみ
    tax_method TEXT NOT NULL DEFAULT 'inclusive',
    e_book_mode TEXT CHECK (e_book_mode IN ('strict','standard')),  -- 電子帳簿保存法モード。NULL = 未選択
    schema_version INTEGER NOT NULL DEFAULT 2
  );`,

  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kana TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_system INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE TABLE IF NOT EXISTS sub_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kana TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (account_id, name)
  );`,

  `CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 伝票番号。欠番になっても再利用しない
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,   -- 訂正のたびに +1
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    deleted_at TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    row_no INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('debit','credit')),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    sub_account_id INTEGER REFERENCES sub_accounts(id),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    memo TEXT NOT NULL DEFAULT '',
    tax_code TEXT          -- 将来の消費税区分用（今は未使用）
  );`,

  /** 訂正・削除履歴。snapshot はその時点の仕訳（科目名つき）の JSON */
  `CREATE TABLE IF NOT EXISTS entry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    reason TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    UNIQUE (entry_id, revision)
  );`,

  `CREATE TABLE IF NOT EXISTS opening_balances (
    fiscal_year INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    sub_account_id INTEGER NOT NULL DEFAULT 0,  -- 0 = 補助なしの部分
    amount INTEGER NOT NULL,
    PRIMARY KEY (fiscal_year, account_id, sub_account_id)
  );`,

  /**
   * 科目・補助科目の名前を年度ごとに持つ（厳密モードのみ使用）
   * from_year 以降はこの名前。無ければ accounts / sub_accounts の name（作成時の名前）
   */
  `CREATE TABLE IF NOT EXISTS master_names (
    target_type TEXT NOT NULL CHECK (target_type IN ('account','sub')),
    target_id INTEGER NOT NULL,
    from_year INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (target_type, target_id, from_year)
  );`,

  /** 科目・補助科目・期首残高の変更履歴（厳密モードのみ記録）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS master_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,       -- account / sub / opening
    target_id INTEGER NOT NULL,
    action TEXT NOT NULL,            -- create / rename / hide / show / delete / change
    fiscal_year INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',  -- 対象の表示名（記録時点）
    old_value TEXT NOT NULL DEFAULT '',
    new_value TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 家事按分の設定（科目ごと・年度ごと。from_year 以降に適用）
   * rate = 事業で使っている割合（%）。100 = 按分しない
   * method = entry（入力時に分ける）/ yearend（年末にまとめて振り替える）
   */
  `CREATE TABLE IF NOT EXISTS home_use_rates (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    from_year INTEGER NOT NULL,
    rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 100),
    method TEXT NOT NULL CHECK (method IN ('entry','yearend')),
    basis TEXT NOT NULL DEFAULT '',   -- 按分の根拠（例：床面積 20㎡ / 60㎡）
    PRIMARY KEY (account_id, from_year)
  );`,

  /** 年末の按分振替で作った仕訳（年度ごとに1本。作り直すときはこの仕訳を訂正する） */
  `CREATE TABLE IF NOT EXISTS home_use_runs (
    fiscal_year INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id)
  );`,

  `CREATE INDEX IF NOT EXISTS idx_entries_date ON journal_entries(date);`,
  `CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);`,
  `CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id, sub_account_id);`,
  `CREATE INDEX IF NOT EXISTS idx_history_entry ON entry_history(entry_id);`,

  // ── 履歴を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_history_no_update BEFORE UPDATE ON entry_history
   BEGIN SELECT RAISE(ABORT, '訂正削除履歴は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_history_no_delete BEFORE DELETE ON entry_history
   BEGIN SELECT RAISE(ABORT, '訂正削除履歴は削除できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_master_history_no_update BEFORE UPDATE ON master_history
   BEGIN SELECT RAISE(ABORT, '変更履歴は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_master_history_no_delete BEFORE DELETE ON master_history
   BEGIN SELECT RAISE(ABORT, '変更履歴は削除できません'); END;`,
  // 電子帳簿保存法モードは一度決めたら変更できない
  `CREATE TRIGGER IF NOT EXISTS trg_settings_mode_fixed BEFORE UPDATE OF e_book_mode ON settings
   WHEN OLD.e_book_mode IS NOT NULL AND (NEW.e_book_mode IS NULL OR NEW.e_book_mode <> OLD.e_book_mode)
   BEGIN SELECT RAISE(ABORT, '電子帳簿保存法モードは変更できません'); END;`,
  // 履歴が1件でもある仕訳は物理削除させない（登録途中の失敗の後始末だけは許す）
  `CREATE TRIGGER IF NOT EXISTS trg_entries_no_delete BEFORE DELETE ON journal_entries
   WHEN EXISTS (SELECT 1 FROM entry_history WHERE entry_id = OLD.id)
   BEGIN SELECT RAISE(ABORT, '仕訳は削除できません（削除済みの印をつけてください）'); END;`,
  // 削除済みの仕訳は元に戻せない
  `CREATE TRIGGER IF NOT EXISTS trg_entries_no_undelete BEFORE UPDATE ON journal_entries
   WHEN OLD.is_deleted = 1
   BEGIN SELECT RAISE(ABORT, '削除済みの仕訳は変更できません'); END;`,
];

/**
 * 既存ファイルへの列追加（古い帳簿を開いたときに足りない列を足す）
 * [テーブル, 列名, 定義]。今後スキーマを変えたらここに足していく
 */
export const COLUMN_MIGRATIONS: [string, string, string][] = [
  ["settings", "e_book_mode", "TEXT CHECK (e_book_mode IN ('strict','standard'))"],
];
