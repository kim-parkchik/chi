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

// ── 締め済みの年度への書き込みを拒否するトリガー ──
// 画面側（repo.ts）でも先に確認するが、ここが最後の砦。メッセージは repo.ts の CLOSED_MESSAGE と揃える
const CLOSED_MSG = "締め済みの年度は変更できません";
const dateClosed = (date: string) =>
  `EXISTS (SELECT 1 FROM fiscal_closings c WHERE ${date} BETWEEN c.period_start AND c.period_end)`;
const entryClosed = (entryId: string) => dateClosed(`(SELECT e.date FROM journal_entries e WHERE e.id = ${entryId})`);
const yearClosed = (year: string) => `EXISTS (SELECT 1 FROM fiscal_closings c WHERE c.fiscal_year = ${year})`;

const guard = (name: string, timing: "INSERT" | "UPDATE" | "DELETE", table: string, when: string) =>
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${timing} ON ${table} WHEN ${when}
   BEGIN SELECT RAISE(ABORT, '${CLOSED_MSG}'); END;`;

/** 年度で区切られるテーブルごとに、INSERT / UPDATE / DELETE を止める */
const yearGuards = (prefix: string, table: string, col: string) => [
  guard(`${prefix}_ins`, "INSERT", table, yearClosed(`NEW.${col}`)),
  guard(`${prefix}_upd`, "UPDATE", table, `${yearClosed(`OLD.${col}`)} OR ${yearClosed(`NEW.${col}`)}`),
  guard(`${prefix}_del`, "DELETE", table, yearClosed(`OLD.${col}`)),
];

const CLOSED_TRIGGERS: string[] = [
  // 仕訳：日付で判定（訂正で日付を締め済みの年度へ動かす／から動かすのも不可）
  guard("trg_closed_entries_ins", "INSERT", "journal_entries", dateClosed("NEW.date")),
  guard("trg_closed_entries_upd", "UPDATE", "journal_entries", `${dateClosed("OLD.date")} OR ${dateClosed("NEW.date")}`),
  guard("trg_closed_entries_del", "DELETE", "journal_entries", dateClosed("OLD.date")),
  // 明細：親の仕訳の日付で判定
  guard("trg_closed_lines_ins", "INSERT", "journal_lines", entryClosed("NEW.entry_id")),
  guard("trg_closed_lines_upd", "UPDATE", "journal_lines", `${entryClosed("OLD.entry_id")} OR ${entryClosed("NEW.entry_id")}`),
  guard("trg_closed_lines_del", "DELETE", "journal_lines", entryClosed("OLD.entry_id")),
  // 期首残高・家事按分・年度ごとの科目名
  ...yearGuards("trg_closed_opening", "opening_balances", "fiscal_year"),
  ...yearGuards("trg_closed_homeuse_rates", "home_use_rates", "from_year"),
  ...yearGuards("trg_closed_homeuse_runs", "home_use_runs", "fiscal_year"),
  ...yearGuards("trg_closed_master_names", "master_names", "from_year"),
];

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

  /**
   * 取引先（任意で使う）。仕訳1件に1つ（journal_entries.counterparty_id）、証憑にも付けられる
   * 補助科目とは別に持つ：同じ相手が売掛金にも外注工賃にも出てくるため。登録番号（インボイス）もここに持つ
   */
  `CREATE TABLE IF NOT EXISTS counterparties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kana TEXT NOT NULL DEFAULT '',
    invoice_no TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 年度の締め。行がある年度は「締め済み」。解除すると行を消す（厳密モードでは master_history に記録）
   * 期間の開始日・終了日を持つのは、法人の任意の会計期間にも同じ仕組みで対応するため
   */
  `CREATE TABLE IF NOT EXISTS fiscal_closings (
    fiscal_year INTEGER PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    closed_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 証憑（領収書・請求書などの PDF / 画像）
   *  - 取引年月日・取引金額・取引先は、電子取引データの検索要件の項目。仕訳とは別に証憑そのものに持つ
   *  - kind：electronic = 電子取引データ（メールで受け取った PDF など）／ scan = スキャナ保存（紙を撮影。今は未対応）
   *  - ファイルの中身・名前・ハッシュは、登録したあと変えられない（差し替えるときは新しく登録して古い方を無効にする）
   *  - 厳密モードでは削除できない（無効の印をつけるだけ）。登録・訂正・無効・ひも付けは evidence_history に残す
   */
  `CREATE TABLE IF NOT EXISTS evidences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 証憑番号。欠番になっても再利用しない
    kind TEXT NOT NULL DEFAULT 'electronic' CHECK (kind IN ('electronic','scan')),
    doc_type TEXT NOT NULL DEFAULT '',
    txn_date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    counterparty TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,                  -- ファイルの SHA-256（16進）。改ざんの確認用
    revision INTEGER NOT NULL DEFAULT 1,
    is_void INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    voided_at TEXT
  );`,

  /**
   * 証憑のファイル本体（base64 の文字列）
   * 画面との受け渡しが JSON のため、BLOB ではなく文字列で持つ。一覧の読み込みを軽くするため別テーブル
   */
  `CREATE TABLE IF NOT EXISTS evidence_files (
    evidence_id INTEGER PRIMARY KEY REFERENCES evidences(id),
    data TEXT NOT NULL
  );`,

  /** 証憑と仕訳のひも付け（多対多：請求書1枚を分割で払う、1つの仕訳に請求書と領収書、など） */
  `CREATE TABLE IF NOT EXISTS evidence_links (
    evidence_id INTEGER NOT NULL REFERENCES evidences(id),
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    PRIMARY KEY (evidence_id, entry_id)
  );`,

  /** 証憑の履歴（厳密モードのみ記録）。snapshot はその時点の項目・ハッシュ・ひも付け先の JSON。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS evidence_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL REFERENCES evidences(id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update','void','link','unlink')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    reason TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    UNIQUE (evidence_id, revision)
  );`,

  /**
   * 記録の連鎖（ハッシュチェーン）。厳密モードで履歴を1件書くたびに1行積む。仕組みは lib/integrity.ts
   *  - content_hash：履歴の1行の中身のハッシュ
   *  - state_key / state_hash：変更後の状態（entry:伝票番号、evidence:証憑番号、opening:年度、closing:年度）のハッシュ
   *  - row_hash：1つ前の row_hash を含めたハッシュ（途中を書き換えると先が合わなくなる）
   */
  `CREATE TABLE IF NOT EXISTS audit_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    state_key TEXT NOT NULL DEFAULT '',
    state_hash TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /** 検知した出来事（トリガーが消されていた、など）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS integrity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * ユーザー（権限はまだ分けない。誰が操作したかを記録するため）
   * password_hash：空ならパスワードなし。形式は lib/password.ts（PBKDF2-SHA256）
   * 操作した人は、履歴（entry_history など）の user_id と、仕訳・証憑の created_by / updated_by に残る
   */
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /** 利用の記録（ログイン・ログアウト）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('login','logout')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 保存中の目印。書き込みのトランザクションを始める前に置き、終わったら消す（repo.ts の tx）
   * 残っていたら、前回は保存の途中でソフトが止まった（書きかけは SQLite が取り消している）
   */
  `CREATE TABLE IF NOT EXISTS pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    user_id INTEGER,
    started_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  `CREATE INDEX IF NOT EXISTS idx_evidences_date ON evidences(txn_date);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_links_entry ON evidence_links(entry_id);`,

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
  `CREATE TRIGGER IF NOT EXISTS trg_access_log_no_update BEFORE UPDATE ON access_log
   BEGIN SELECT RAISE(ABORT, '利用の記録は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_access_log_no_delete BEFORE DELETE ON access_log
   BEGIN SELECT RAISE(ABORT, '利用の記録は削除できません'); END;`,

  // ── 記録の連鎖・検知の記録を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_update BEFORE UPDATE ON audit_chain
   BEGIN SELECT RAISE(ABORT, '記録の連鎖は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_delete BEFORE DELETE ON audit_chain
   BEGIN SELECT RAISE(ABORT, '記録の連鎖は削除できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_integrity_events_no_update BEFORE UPDATE ON integrity_events
   BEGIN SELECT RAISE(ABORT, '検知の記録は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_integrity_events_no_delete BEFORE DELETE ON integrity_events
   BEGIN SELECT RAISE(ABORT, '検知の記録は削除できません'); END;`,

  // ── 証憑を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_history_no_update BEFORE UPDATE ON evidence_history
   BEGIN SELECT RAISE(ABORT, '証憑の履歴は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_history_no_delete BEFORE DELETE ON evidence_history
   BEGIN SELECT RAISE(ABORT, '証憑の履歴は削除できません'); END;`,
  // ファイルの中身は、どちらのモードでも書き換えさせない
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_files_no_update BEFORE UPDATE ON evidence_files
   BEGIN SELECT RAISE(ABORT, '証憑のファイルは変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_file_fixed BEFORE UPDATE OF file_name, mime, size, sha256 ON evidences
   BEGIN SELECT RAISE(ABORT, '証憑のファイルは変更できません'); END;`,
  // 履歴がある証憑（厳密モード）は削除させない（登録途中の失敗の後始末だけは許す）
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_no_delete BEFORE DELETE ON evidences
   WHEN EXISTS (SELECT 1 FROM evidence_history WHERE evidence_id = OLD.id)
   BEGIN SELECT RAISE(ABORT, '証憑は削除できません（無効の印をつけてください）'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_files_no_delete BEFORE DELETE ON evidence_files
   WHEN EXISTS (SELECT 1 FROM evidence_history WHERE evidence_id = OLD.evidence_id)
   BEGIN SELECT RAISE(ABORT, '証憑は削除できません（無効の印をつけてください）'); END;`,
  // 無効にした証憑は変更できない
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_no_unvoid BEFORE UPDATE ON evidences
   WHEN OLD.is_void = 1
   BEGIN SELECT RAISE(ABORT, '無効にした証憑は変更できません'); END;`,

  // ── 締め済みの年度を守るトリガー ──
  ...CLOSED_TRIGGERS,
];

/**
 * 既存ファイルへの列追加（古い帳簿を開いたときに足りない列を足す）
 * [テーブル, 列名, 定義]。今後スキーマを変えたらここに足していく
 */
export const COLUMN_MIGRATIONS: [string, string, string][] = [
  ["settings", "e_book_mode", "TEXT CHECK (e_book_mode IN ('strict','standard'))"],
  // 1 = 繰越済みの年度を自動で締める処理を済ませた（一度だけ行う。解除した年度を開くたびに締め直さないため）
  ["settings", "closings_initialized", "INTEGER NOT NULL DEFAULT 0"],
  // バックアップを残す世代数（既定値は constants/appConfig.ts の DEFAULT_BACKUP_GENERATIONS と揃える）
  ["settings", "backup_generations", "INTEGER NOT NULL DEFAULT 100"],
  // 改ざんの検知：記録の連鎖を始めたか（既存の履歴を一度だけ連鎖に取り込む）、前回開いたときにあったトリガー
  ["settings", "chain_initialized", "INTEGER NOT NULL DEFAULT 0"],
  ["settings", "known_triggers", "TEXT NOT NULL DEFAULT ''"],
  // 締めたときの連鎖の先頭（確認コードのもと）
  ["fiscal_closings", "chain_head", "TEXT NOT NULL DEFAULT ''"],
  // 操作したユーザー
  ["entry_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["master_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["evidence_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["integrity_events", "user_id", "INTEGER REFERENCES users(id)"],
  ["journal_entries", "created_by", "INTEGER REFERENCES users(id)"],
  ["journal_entries", "updated_by", "INTEGER REFERENCES users(id)"],
  ["evidences", "created_by", "INTEGER REFERENCES users(id)"],
  ["evidences", "updated_by", "INTEGER REFERENCES users(id)"],
  // 取引先（任意）
  ["journal_entries", "counterparty_id", "INTEGER REFERENCES counterparties(id)"],
  ["evidences", "counterparty_id", "INTEGER REFERENCES counterparties(id)"],
];
