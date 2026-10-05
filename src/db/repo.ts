/**
 * DBアクセスはこのファイルに集約します。画面側には SQL を書かない方針です。
 *
 * 注意：tauri-plugin-sql は内部で接続プールを使うため、BEGIN/COMMIT によるトランザクションが
 * 同じ接続で実行される保証がありません。そのため「1文で済ませる」「失敗したら後始末する」で整合性を保っています。
 */
import type Database from "@tauri-apps/plugin-sql";
import type {
  Account, AccountCategory, EBookMode, EntrySnapshot, HistoryAction, HistoryRecord, JournalEntry, JournalLine,
  HomeUseRate, MasterHistoryRecord, OpeningBalances, Settings, SubAccount, SubOpeningBalances,
} from "../lib/types";
import { subKey } from "../lib/types";
import type { FlatLine } from "../lib/accounting";
import { CATEGORY_CODE_RANGE, normalSideOf } from "../constants/accounts";
import { MAX_SUB_ACCOUNTS_PER_ACCOUNT } from "../constants/appConfig";

// ────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────
export const getSettings = async (db: Database): Promise<Settings> => {
  const rows = await db.select<Settings[]>(
    "SELECT business_name, owner_name, industry, fiscal_year, filing_type, tax_status, tax_method, e_book_mode FROM settings WHERE id = 1",
  );
  return rows[0];
};

/** 電子帳簿保存法モードを決める（一度だけ。変更はトリガーで拒否される） */
export const setEBookMode = (db: Database, mode: EBookMode) =>
  db.execute("UPDATE settings SET e_book_mode = ? WHERE id = 1 AND e_book_mode IS NULL", [mode]);

const isStrict = async (db: Database) => {
  const r = await db.select<{ e_book_mode: EBookMode | null }[]>("SELECT e_book_mode FROM settings WHERE id = 1");
  return r[0]?.e_book_mode === "strict";
};

const currentYear = async (db: Database) => {
  const r = await db.select<{ fiscal_year: number }[]>("SELECT fiscal_year FROM settings WHERE id = 1");
  return r[0].fiscal_year;
};

// ────────────────────────────────────────────
// 変更履歴（科目・補助科目・期首残高）厳密モードのときだけ記録
// ────────────────────────────────────────────
type MasterLog = Omit<MasterHistoryRecord, "id" | "recorded_at">;

const logMaster = async (db: Database, rec: MasterLog) => {
  if (!(await isStrict(db))) return;
  await db.execute(
    `INSERT INTO master_history (target_type, target_id, action, fiscal_year, label, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [rec.target_type, rec.target_id, rec.action, rec.fiscal_year, rec.label, rec.old_value, rec.new_value],
  );
};

export const getMasterHistory = (db: Database) =>
  db.select<MasterHistoryRecord[]>("SELECT * FROM master_history ORDER BY id DESC LIMIT 2000");

/** 年度ごとの名前（無ければ作成時の名前）を引く SQL 片 */
const effectiveName = (type: "account" | "sub", alias: string) =>
  `COALESCE((SELECT m.name FROM master_names m WHERE m.target_type = '${type}' AND m.target_id = ${alias}.id
     AND m.from_year <= ? ORDER BY m.from_year DESC LIMIT 1), ${alias}.name)`;

export const saveSettings = async (db: Database, s: Settings) => {
  await db.execute(
    `UPDATE settings SET business_name = ?, owner_name = ?, industry = ?, fiscal_year = ?, filing_type = ?,
            tax_status = ?, tax_method = ? WHERE id = 1`,
    [s.business_name, s.owner_name, s.industry, s.fiscal_year, s.filing_type, s.tax_status, s.tax_method],
  );
};

// ────────────────────────────────────────────
// 勘定科目
// ────────────────────────────────────────────
/** 勘定科目（名前はその年度のもの） */
export const getAccounts = (db: Database, year: number) =>
  db.select<Account[]>(
    `SELECT a.id, a.code, ${effectiveName("account", "a")} AS name, a.kana, a.category, a.normal_side,
            a.sort_order, a.is_active, a.is_system
       FROM accounts a ORDER BY a.code`,
    [year],
  );

const accountLabel = async (db: Database, id: number) => {
  const year = await currentYear(db);
  return (await getAccounts(db, year)).find((a) => a.id === id)?.name ?? `#${id}`;
};

export const setAccountActive = async (db: Database, id: number, active: boolean) => {
  await db.execute("UPDATE accounts SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, {
    target_type: "account", target_id: id, action: active ? "show" : "hide",
    fiscal_year: await currentYear(db), label: await accountLabel(db, id), old_value: "", new_value: "",
  });
};

/** 科目の使用件数（仕訳・期首残高） */
export const accountUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id = ?)
          + (SELECT COUNT(*) FROM opening_balances WHERE account_id = ?) AS n`,
    [id, id],
  );
  return r[0].n;
};

/** その区分で次に空いているコード */
export const nextAccountCode = (accounts: Account[], category: AccountCategory): string | null => {
  const [lo, hi] = CATEGORY_CODE_RANGE[category];
  const used = new Set(accounts.map((a) => a.code));
  for (let c = lo; c <= hi; c++) if (!used.has(String(c))) return String(c);
  return null;
};

export interface AccountInputData {
  code: string;
  name: string;
  kana: string;
  category: AccountCategory;
}

export const validateAccount = (accounts: Account[], data: AccountInputData, editingId?: number): string | null => {
  const name = data.name.trim();
  if (!name) return "科目名を入れてください";
  if (name.length > 20) return "科目名は20文字までです";
  if (!/^\d{3}$/.test(data.code)) return "コードは3桁の数字です";
  const [lo, hi] = CATEGORY_CODE_RANGE[data.category];
  const n = Number(data.code);
  if (n < lo || n > hi) return `この区分のコードは ${lo}〜${hi} です`;
  if (accounts.some((a) => a.code === data.code && a.id !== editingId)) return "そのコードはすでに使われています";
  if (accounts.some((a) => a.name === name && a.id !== editingId)) return "同じ名前の科目があります";
  return null;
};

export const createAccount = async (db: Database, data: AccountInputData) => {
  const res = await db.execute(
    `INSERT INTO accounts (code, name, kana, category, normal_side, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [data.code, data.name.trim(), data.kana.trim(), data.category, normalSideOf(data.category), Number(data.code) * 10],
  );
  await logMaster(db, {
    target_type: "account", target_id: Number(res.lastInsertId), action: "create",
    fiscal_year: await currentYear(db), label: data.name.trim(), old_value: "", new_value: `${data.code} ${data.name.trim()}`,
  });
};

/**
 * 名前・よみ・コードの変更（区分は変えられない：過去の集計が変わってしまうため）
 *  - 厳密モード：名前は「表示中の年度から」変わる。過去の年度は元の名前のまま。変更は履歴に残る
 *  - 通常モード：すべての年度の名前が変わる
 */
export const updateAccount = async (db: Database, id: number, data: Omit<AccountInputData, "category">) => {
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before) return;
  const name = data.name.trim();
  if (await isStrict(db)) {
    await db.execute("UPDATE accounts SET code = ?, kana = ?, sort_order = ? WHERE id = ?", [
      data.code, data.kana.trim(), Number(data.code) * 10, id,
    ]);
    if (name !== before.name) {
      await db.execute(
        "INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('account', ?, ?, ?) ON CONFLICT (target_type, target_id, from_year) DO UPDATE SET name = excluded.name",
        [id, year, name],
      );
      await logMaster(db, { target_type: "account", target_id: id, action: "rename", fiscal_year: year, label: name, old_value: before.name, new_value: name });
    }
    if (data.code !== before.code) {
      await logMaster(db, { target_type: "account", target_id: id, action: "change", fiscal_year: year, label: name, old_value: `コード ${before.code}`, new_value: `コード ${data.code}` });
    }
  } else {
    await db.execute("UPDATE accounts SET code = ?, name = ?, kana = ?, sort_order = ? WHERE id = ?", [
      data.code, name, data.kana.trim(), Number(data.code) * 10, id,
    ]);
  }
};

/** 追加した科目で、一度も使っていないものだけ削除できる */
export const deleteAccount = async (db: Database, id: number) => {
  const label = await accountLabel(db, id);
  await db.execute("DELETE FROM sub_accounts WHERE account_id = ?", [id]);
  await db.execute("DELETE FROM accounts WHERE id = ? AND is_system = 0", [id]);
  await logMaster(db, { target_type: "account", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
};

// ────────────────────────────────────────────
// 補助科目
// ────────────────────────────────────────────
/** 補助科目（名前はその年度のもの） */
export const getSubAccounts = (db: Database, year: number) =>
  db.select<SubAccount[]>(
    `SELECT s.id, s.account_id, ${effectiveName("sub", "s")} AS name, s.kana, s.sort_order, s.is_active
       FROM sub_accounts s ORDER BY s.account_id, s.sort_order, s.id`,
    [year],
  );

/** 「普通預金 / みずほ銀行」のような履歴用の表示名 */
const subLabel = async (db: Database, id: number) => {
  const year = await currentYear(db);
  const sub = (await getSubAccounts(db, year)).find((x) => x.id === id);
  if (!sub) return `#${id}`;
  return `${await accountLabel(db, sub.account_id)} / ${sub.name}`;
};

export const validateSub = (subs: SubAccount[], accountId: number, name: string, editingId?: number): string | null => {
  const n = name.trim();
  if (!n) return "補助科目名を入れてください";
  if (n.length > 30) return "補助科目名は30文字までです";
  const mine = subs.filter((s) => s.account_id === accountId);
  if (mine.some((s) => s.name === n && s.id !== editingId)) return "同じ名前の補助科目があります";
  if (!editingId && mine.length >= MAX_SUB_ACCOUNTS_PER_ACCOUNT)
    return `補助科目は1科目につき ${MAX_SUB_ACCOUNTS_PER_ACCOUNT} 件までです`;
  return null;
};

export const createSub = async (db: Database, accountId: number, name: string, kana = "") => {
  const res = await db.execute(
    `INSERT INTO sub_accounts (account_id, name, kana, sort_order)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM sub_accounts WHERE account_id = ?))`,
    [accountId, name.trim(), kana.trim(), accountId],
  );
  const id = Number(res.lastInsertId);
  await logMaster(db, { target_type: "sub", target_id: id, action: "create", fiscal_year: await currentYear(db), label: await subLabel(db, id), old_value: "", new_value: name.trim() });
};

/** 補助科目の名前変更（厳密モードでは表示中の年度から。過去は元の名前） */
export const renameSub = async (db: Database, id: number, name: string) => {
  const year = await currentYear(db);
  const before = (await getSubAccounts(db, year)).find((x) => x.id === id);
  const n = name.trim();
  if (!before || before.name === n) return;
  if (await isStrict(db)) {
    await db.execute(
      "INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('sub', ?, ?, ?) ON CONFLICT (target_type, target_id, from_year) DO UPDATE SET name = excluded.name",
      [id, year, n],
    );
    await logMaster(db, { target_type: "sub", target_id: id, action: "rename", fiscal_year: year, label: await subLabel(db, id), old_value: before.name, new_value: n });
  } else {
    await db.execute("UPDATE sub_accounts SET name = ? WHERE id = ?", [n, id]);
  }
};

export const setSubActive = async (db: Database, id: number, active: boolean) => {
  await db.execute("UPDATE sub_accounts SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, { target_type: "sub", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db), label: await subLabel(db, id), old_value: "", new_value: "" });
};

export const subUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_lines WHERE sub_account_id = ?)
          + (SELECT COUNT(*) FROM opening_balances WHERE sub_account_id = ?) AS n`,
    [id, id],
  );
  return r[0].n;
};

export const deleteSub = async (db: Database, id: number) => {
  const label = await subLabel(db, id);
  await db.execute("DELETE FROM sub_accounts WHERE id = ?", [id]);
  await logMaster(db, { target_type: "sub", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
};

// ────────────────────────────────────────────
// 期首残高
// ────────────────────────────────────────────
export interface OpeningData {
  /** 科目ごとの合計（補助科目の分も含む） */
  byAccount: OpeningBalances;
  /** "科目ID:補助ID" ごとの金額（補助ID 0 = 補助なし） */
  bySub: SubOpeningBalances;
}

export const getOpening = async (db: Database, year: number): Promise<OpeningData> => {
  const rows = await db.select<{ account_id: number; sub_account_id: number; amount: number }[]>(
    "SELECT account_id, sub_account_id, amount FROM opening_balances WHERE fiscal_year = ?",
    [year],
  );
  const byAccount: OpeningBalances = {};
  const bySub: SubOpeningBalances = {};
  for (const r of rows) {
    byAccount[r.account_id] = (byAccount[r.account_id] ?? 0) + r.amount;
    bySub[subKey(r.account_id, r.sub_account_id || null)] = r.amount;
  }
  return { byAccount, bySub };
};

export const hasOpening = async (db: Database, year: number) => {
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM opening_balances WHERE fiscal_year = ?", [year]);
  return rows[0].n > 0;
};

/** bySub（"科目ID:補助ID" → 金額）をそのまま保存する */
export const saveOpening = async (db: Database, year: number, bySub: SubOpeningBalances, viaCarryForward = false) => {
  const items = Object.entries(bySub).filter(([, v]) => v !== 0);

  // 厳密モード：変わった金額を履歴に残す
  if (await isStrict(db)) {
    const before = (await getOpening(db, year)).bySub;
    const keys = new Set([...Object.keys(before), ...Object.keys(bySub)]);
    const accounts = await getAccounts(db, year);
    const subs = await getSubAccounts(db, year);
    for (const k of keys) {
      const o = before[k] ?? 0;
      const n = bySub[k] ?? 0;
      if (o === n) continue;
      const [acc, sub] = k.split(":").map(Number);
      const label = (accounts.find((a) => a.id === acc)?.name ?? `#${acc}`) + (sub ? ` / ${subs.find((x) => x.id === sub)?.name ?? ""}` : "");
      await logMaster(db, {
        target_type: "opening", target_id: acc, action: "change", fiscal_year: year,
        label: viaCarryForward ? `${label}（繰越処理）` : label, old_value: String(o), new_value: String(n),
      });
    }
  }

  await db.execute("DELETE FROM opening_balances WHERE fiscal_year = ?", [year]);
  if (items.length === 0) return;
  const placeholders = items.map(() => "(?, ?, ?, ?)").join(", ");
  const params = items.flatMap(([k, v]) => {
    const [acc, sub] = k.split(":").map(Number);
    return [year, acc, sub, v];
  });
  await db.execute(
    `INSERT INTO opening_balances (fiscal_year, account_id, sub_account_id, amount) VALUES ${placeholders}`,
    params,
  );
};

// ────────────────────────────────────────────
// 仕訳
// ────────────────────────────────────────────

/** 期間内の仕訳明細を、日付・摘要つきで取得する（既定では削除済みを除く） */
export const getLines = (db: Database, from: string, to: string, includeDeleted = false) =>
  db.select<FlatLine[]>(
    `SELECT l.entry_id, e.date, e.description, e.is_deleted, e.revision, l.row_no, l.side,
            l.account_id, l.sub_account_id, l.amount, l.memo
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.date BETWEEN ? AND ? ${includeDeleted ? "" : "AND e.is_deleted = 0"}
      ORDER BY e.date, l.entry_id, l.row_no, CASE l.side WHEN 'debit' THEN 0 ELSE 1 END`,
    [from, to],
  );

export const getEntry = async (db: Database, id: number): Promise<JournalEntry | null> => {
  const e = await db.select<Omit<JournalEntry, "lines">[]>(
    "SELECT id, date, description, revision, is_deleted, created_at, updated_at FROM journal_entries WHERE id = ?",
    [id],
  );
  if (e.length === 0) return null;
  const lines = await db.select<JournalLine[]>(
    `SELECT id, entry_id, row_no, side, account_id, sub_account_id, amount, memo
       FROM journal_lines WHERE entry_id = ? ORDER BY row_no, CASE side WHEN 'debit' THEN 0 ELSE 1 END`,
    [id],
  );
  return { ...e[0], lines };
};

const insertLines = async (db: Database, entryId: number, lines: JournalLine[]) => {
  // 1文でまとめて INSERT（途中で失敗しても半端な明細が残らない）
  const placeholders = lines.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = lines.flatMap((l) => [entryId, l.row_no, l.side, l.account_id, l.sub_account_id, l.amount, l.memo]);
  await db.execute(
    `INSERT INTO journal_lines (entry_id, row_no, side, account_id, sub_account_id, amount, memo) VALUES ${placeholders}`,
    params,
  );
};

const descriptionOf = (lines: JournalLine[]) => lines.find((l) => l.memo)?.memo ?? "";

/** 履歴用の写しを作る（科目名は今の名前で固定して残す） */
const makeSnapshot = async (db: Database, date: string, lines: JournalLine[]): Promise<EntrySnapshot> => {
  // 仕訳の日付の年度で使われている名前で残す
  const year = Number(date.slice(0, 4));
  const accounts = await getAccounts(db, year);
  const subs = await getSubAccounts(db, year);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  return {
    date,
    lines: lines.map((l) => ({
      side: l.side,
      account: an.get(l.account_id) ?? `#${l.account_id}`,
      sub: l.sub_account_id ? sn.get(l.sub_account_id) ?? "" : "",
      amount: l.amount,
      memo: l.memo,
    })),
  };
};

const writeHistory = async (
  db: Database, entryId: number, revision: number, action: HistoryAction, snapshot: EntrySnapshot, reason: string,
) => {
  await db.execute(
    "INSERT INTO entry_history (entry_id, revision, action, reason, snapshot) VALUES (?, ?, ?, ?, ?)",
    [entryId, revision, action, reason.trim(), JSON.stringify(snapshot)],
  );
};

export const createEntry = async (db: Database, date: string, lines: JournalLine[]) => {
  const res = await db.execute("INSERT INTO journal_entries (date, description) VALUES (?, ?)", [
    date,
    descriptionOf(lines),
  ]);
  const entryId = Number(res.lastInsertId);
  try {
    await insertLines(db, entryId, lines);
    if (await isStrict(db)) await writeHistory(db, entryId, 1, "create", await makeSnapshot(db, date, lines), "");
  } catch (e) {
    // 履歴がまだ無いので、ここだけは物理削除で後始末できる
    await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [entryId]);
    await db.execute("DELETE FROM journal_entries WHERE id = ?", [entryId]);
    throw e;
  }
  return entryId;
};

/** 訂正：仕訳を書き換える。厳密モードでは新しい版を履歴に積む */
export const updateEntry = async (db: Database, id: number, date: string, lines: JournalLine[], reason = "") => {
  const before = await getEntry(db, id);
  if (!before) throw new Error("仕訳が見つかりません");
  if (before.is_deleted) throw new Error("削除済みの仕訳は訂正できません");
  const revision = before.revision + 1;

  await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
  try {
    await insertLines(db, id, lines);
  } catch (e) {
    await insertLines(db, id, before.lines); // 元の明細を戻す
    throw e;
  }
  await db.execute(
    `UPDATE journal_entries SET date = ?, description = ?, revision = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [date, descriptionOf(lines), revision, id],
  );
  if (await isStrict(db)) await writeHistory(db, id, revision, "update", await makeSnapshot(db, date, lines), reason);
};

/** 削除：厳密モードでは消さずに「削除済み」にし、削除時点の内容を履歴に残す */
export const deleteEntry = async (db: Database, id: number, reason = "") => {
  const before = await getEntry(db, id);
  if (!before || before.is_deleted) return;
  // 通常モード：本当に消す（履歴が無いのでトリガーにも止められない）
  if (!(await isStrict(db))) {
    await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM journal_entries WHERE id = ?", [id]);
    return;
  }
  const revision = before.revision + 1;
  await db.execute(
    `UPDATE journal_entries SET is_deleted = 1, revision = ?, deleted_at = DATETIME('now','localtime'),
            updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [revision, id],
  );
  await writeHistory(db, id, revision, "delete", await makeSnapshot(db, before.date, before.lines), reason);
};

interface HistoryRow extends Omit<HistoryRecord, "snapshot"> { snapshot: string }

/** 履歴（entryId を渡せばその仕訳だけ）。新しい順 */
export const getHistory = async (db: Database, entryId?: number): Promise<HistoryRecord[]> => {
  const rows = await db.select<HistoryRow[]>(
    `SELECT id, entry_id, revision, action, recorded_at, reason, snapshot FROM entry_history
      ${entryId ? "WHERE entry_id = ?" : ""} ORDER BY id DESC LIMIT 2000`,
    entryId ? [entryId] : [],
  );
  return rows.map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) as EntrySnapshot }));
};

/** 摘要の入力候補（よく使う順） */
export const getMemoSuggestions = async (db: Database) => {
  const rows = await db.select<{ memo: string }[]>(
    `SELECT memo FROM journal_lines WHERE memo <> '' GROUP BY memo ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 300`,
  );
  return rows.map((r) => r.memo);
};

/** データがある年度の一覧 */
export const getYears = async (db: Database, current: number) => {
  const rows = await db.select<{ y: string }[]>(
    `SELECT DISTINCT substr(date, 1, 4) AS y FROM journal_entries WHERE is_deleted = 0
     UNION SELECT DISTINCT CAST(fiscal_year AS TEXT) FROM opening_balances`,
  );
  const set = new Set(rows.map((r) => Number(r.y)));
  set.add(current);
  return [...set].sort((a, b) => b - a);
};

// ────────────────────────────────────────────
// 家事按分
// ────────────────────────────────────────────

/** その年度に有効な按分設定（科目ごとに、from_year が年度以下で最新のもの） */
export const getHomeUseRates = (db: Database, year: number) =>
  db.select<HomeUseRate[]>(
    `SELECT h.account_id, h.from_year, h.rate, h.method, h.basis FROM home_use_rates h
      WHERE h.from_year = (SELECT MAX(x.from_year) FROM home_use_rates x WHERE x.account_id = h.account_id AND x.from_year <= ?)`,
    [year],
  );

/** 按分設定を保存する（その年度から適用。前の年度の設定はそのまま残る） */
export const saveHomeUseRate = async (db: Database, year: number, rate: Omit<HomeUseRate, "from_year">) => {
  const before = (await getHomeUseRates(db, year)).find((r) => r.account_id === rate.account_id);
  await db.execute(
    `INSERT INTO home_use_rates (account_id, from_year, rate, method, basis) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, from_year) DO UPDATE SET rate = excluded.rate, method = excluded.method, basis = excluded.basis`,
    [rate.account_id, year, rate.rate, rate.method, rate.basis.trim()],
  );
  const fmt = (r?: Omit<HomeUseRate, "from_year">) =>
    r ? `事業 ${r.rate}%（${r.method === "entry" ? "入力時" : "年末一括"}）${r.basis ? " 根拠：" + r.basis : ""}` : "設定なし";
  await logMaster(db, {
    target_type: "homeuse", target_id: rate.account_id, action: "change", fiscal_year: year,
    label: await accountLabel(db, rate.account_id), old_value: fmt(before), new_value: fmt(rate),
  });
};

export const getHomeUseRun = async (db: Database, year: number) => {
  const r = await db.select<{ entry_id: number }[]>(
    `SELECT r.entry_id FROM home_use_runs r JOIN journal_entries e ON e.id = r.entry_id
      WHERE r.fiscal_year = ? AND e.is_deleted = 0`,
    [year],
  );
  return r[0]?.entry_id ?? null;
};

export const setHomeUseRun = (db: Database, year: number, entryId: number) =>
  db.execute(
    "INSERT INTO home_use_runs (fiscal_year, entry_id) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET entry_id = excluded.entry_id",
    [year, entryId],
  );
