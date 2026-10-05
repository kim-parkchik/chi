/**
 * DBアクセスはこのファイルに集約します。画面側には SQL を書かない方針です。
 *
 * 注意：tauri-plugin-sql は内部で接続プールを使うため、BEGIN/COMMIT によるトランザクションが
 * 同じ接続で実行される保証がありません。そのため「1文で済ませる」「失敗したら後始末する」で整合性を保っています。
 */
import type Database from "./connection";
import type {
  AccessLogRecord, Account, AccountCategory, Counterparty, User, EBookMode, EntrySnapshot, Evidence, EvidenceAction, EvidenceHistoryRecord, EvidenceKind, EvidenceMeta,
  EvidenceSnapshot, FiscalClosing, HistoryAction, HistoryRecord, JournalEntry, JournalLine,
  HomeUseRate, MasterHistoryRecord, OpeningBalances, Settings, SubAccount, SubOpeningBalances,
} from "../lib/types";
import { subKey } from "../lib/types";
import { yearEnd, yearStart, type FlatLine } from "../lib/accounting";
import { yearsToAutoClose } from "../lib/closing";
import { normalizeInvoiceNo, type CounterpartyInput } from "../lib/counterparty";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";
import {
  anchorCode, chainHash, closingState, entryState, evidenceState, GENESIS, hashText, HISTORY_COLUMNS, historyContent, normalizeAnchor,
  openingState, sourceLabel, stateLabel, verifyChain, type ChainRow, type ChainSource, type IntegrityIssue,
} from "../lib/integrity";
import { detectFileType, fromBase64, sha256Hex, toBase64, validateEvidenceFile, validateEvidenceMeta } from "../lib/evidence";
import { CATEGORY_CODE_RANGE, normalSideOf } from "../constants/accounts";
import { DEFAULT_BACKUP_GENERATIONS, MAX_BACKUP_GENERATIONS, MAX_SUB_ACCOUNTS_PER_ACCOUNT } from "../constants/appConfig";

// ────────────────────────────────────────────
// トランザクション
//  書き込みはすべて tx() の中で行う（失敗したら丸ごと取り消す）。
//  始める前に「保存中」の目印（pending_ops）を置き、終わったら消す。
//  ソフトが途中で止まると、SQLite が書きかけを取り消し、目印だけが残る → 次に開いたときに知らせる（checkInterrupted）
//  tx の中から別の tx は呼ばない（呼ぶと待ち合わせて止まる）。中では「_」つきの関数を使う
// ────────────────────────────────────────────
let queue: Promise<unknown> = Promise.resolve();

export const tx = <T>(db: Database, label: string, fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(async () => {
    const mark = await db.execute("INSERT INTO pending_ops (label, user_id) VALUES (?, ?)", [label, currentActor]);
    await db.execute("BEGIN IMMEDIATE");
    try {
      const r = await fn();
      await db.execute("COMMIT");
      return r;
    } catch (e) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        /* すでに取り消されている */
      }
      throw e;
    } finally {
      await db.execute("DELETE FROM pending_ops WHERE id = ?", [mark.lastInsertId]);
    }
  });
  queue = run.catch(() => undefined);
  return run;
};

type Rest<F> = F extends (db: Database, ...a: infer R) => unknown ? R : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inTx = <F extends (db: Database, ...a: any[]) => Promise<any>>(f: F, label: (...a: Rest<F>) => string) =>
  (db: Database, ...a: Rest<F>) => tx(db, label(...a), () => f(db, ...a)) as ReturnType<F>;

/** 操作しているユーザー（帳簿を開いてユーザーを選んだときに setActor で決める） */
let currentActor: number | null = null;
export const setActor = (userId: number | null) => {
  currentActor = userId;
};
export const getActor = () => currentActor;

/**
 * 前回、保存の途中でソフトが止まっていないか（帳簿を開いたとき）。
 * 書きかけは SQLite が取り消しているので帳簿は整っている。何が取り消されたかを知らせ、厳密モードでは記録する
 */
export const checkInterrupted = async (db: Database) => {
  const rows = await db.select<{ id: number; label: string; started_at: string; user_name: string | null }[]>(
    `SELECT p.id, p.label, p.started_at, u.name AS user_name FROM pending_ops p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id`,
  );
  const messages = rows.map((r) => `${r.started_at}　${r.label}${r.user_name ? `（${r.user_name}）` : ""}`);
  if (rows.length === 0) return messages;
  await tx(db, "中断の記録", async () => {
    for (const m of messages) await recordEvent(db, "interrupted", `保存が完了せず、取り消されました：${m}`);
  });
  for (const r of rows) await db.execute("DELETE FROM pending_ops WHERE id = ?", [r.id]);
  return messages;
};

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
const setEBookMode_ = (db: Database, mode: EBookMode) =>
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
  const res = await db.execute(
    `INSERT INTO master_history (target_type, target_id, action, fiscal_year, label, old_value, new_value, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.target_type, rec.target_id, rec.action, rec.fiscal_year, rec.label, rec.old_value, rec.new_value, currentActor],
  );
  const key = rec.target_type === "opening" ? `opening:${rec.fiscal_year}` : rec.target_type === "closing" ? `closing:${rec.target_id}` : "";
  await appendChain(db, "master_history", Number(res.lastInsertId), key);
};

export const getMasterHistory = (db: Database) =>
  db.select<MasterHistoryRecord[]>(
    "SELECT h.*, u.name AS user_name FROM master_history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC LIMIT 2000",
  );

// ────────────────────────────────────────────
// 年度の締め
//  締め済みの年度には、仕訳・期首残高・家事按分・年度ごとの科目名を書き込めない。
//  ここで先に確認してわかりやすいメッセージを出し、DB のトリガー（schema.ts）でも拒否する
// ────────────────────────────────────────────
export const closedMessage = (year: number) => `${year}年は締め済みのため変更できません。事業者設定で締めを解除してください。`;

export const getClosings = (db: Database) =>
  db.select<FiscalClosing[]>("SELECT fiscal_year, period_start, period_end, closed_at, chain_head FROM fiscal_closings ORDER BY fiscal_year");

/** 年度が締め済みなら止める */
const assertYearOpen = async (db: Database, year: number) => {
  const r = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM fiscal_closings WHERE fiscal_year = ?", [year]);
  if (r[0].n > 0) throw new Error(closedMessage(year));
};

/** 日付が締め済みの年度に入っていれば止める */
const assertDateOpen = async (db: Database, date: string) => {
  const r = await db.select<{ fiscal_year: number }[]>(
    "SELECT fiscal_year FROM fiscal_closings WHERE ? BETWEEN period_start AND period_end",
    [date],
  );
  if (r.length > 0) throw new Error(closedMessage(r[0].fiscal_year));
};

/** 年度を締める（すでに締め済みなら何もしない）。note は履歴に残す補足 */
const closeYear_ = async (db: Database, year: number, note = "") => {
  const res = await db.execute(
    "INSERT OR IGNORE INTO fiscal_closings (fiscal_year, period_start, period_end) VALUES (?, ?, ?)",
    [year, yearStart(year), yearEnd(year)],
  );
  if (res.rowsAffected === 0) return;
  await logMaster(db, {
    target_type: "closing", target_id: year, action: "close", fiscal_year: year,
    label: `${year}年`, old_value: "", new_value: note,
  });
  // 締めたときの連鎖の先頭を控える（確認コードとして画面に出し、ファイルの外に残してもらう）
  const head = await getChainHead(db);
  if (head) await db.execute("UPDATE fiscal_closings SET chain_head = ? WHERE fiscal_year = ?", [head.row_hash, year]);
};

/** 締めを解除する。厳密モードでは理由が必須で、履歴に残す */
const reopenYear_ = async (db: Database, year: number, reason: string) => {
  const r = reason.trim();
  const strict = await isStrict(db);
  if (strict && !r) throw new Error("締めを解除する理由を入れてください");
  const res = await db.execute("DELETE FROM fiscal_closings WHERE fiscal_year = ?", [year]);
  if (res.rowsAffected === 0) return;
  await logMaster(db, {
    target_type: "closing", target_id: year, action: "unlock", fiscal_year: year,
    label: `${year}年`, old_value: "", new_value: r,
  });
};

/**
 * 既存の帳簿で、繰越済みの年度を締め済みにする（帳簿を開いたときに一度だけ）。
 * 一度済ませたら印をつけ、あとで解除した年度を開くたびに締め直すことはしない
 */
const initClosings_ = async (db: Database) => {
  const flag = await db.select<{ closings_initialized: number }[]>("SELECT closings_initialized FROM settings WHERE id = 1");
  if (!flag[0] || flag[0].closings_initialized) return;
  const openingYears = (await db.select<{ y: number }[]>("SELECT DISTINCT fiscal_year AS y FROM opening_balances")).map((r) => r.y);
  const dataYears: number[] = [];
  for (const y of openingYears.map((x) => x - 1)) {
    const r = await db.select<{ n: number }[]>(
      `SELECT (SELECT COUNT(*) FROM journal_entries WHERE date BETWEEN ? AND ?)
            + (SELECT COUNT(*) FROM opening_balances WHERE fiscal_year = ?) AS n`,
      [yearStart(y), yearEnd(y), y],
    );
    if (r[0].n > 0) dataYears.push(y);
  }
  const closed = (await getClosings(db)).map((c) => c.fiscal_year);
  for (const y of yearsToAutoClose(openingYears, dataYears, closed)) {
    await closeYear_(db, y, "繰越済みの年度を自動で締め");
  }
  await db.execute("UPDATE settings SET closings_initialized = 1 WHERE id = 1");
};

/** 年度ごとの名前（無ければ作成時の名前）を引く SQL 片 */
const effectiveName = (type: "account" | "sub", alias: string) =>
  `COALESCE((SELECT m.name FROM master_names m WHERE m.target_type = '${type}' AND m.target_id = ${alias}.id
     AND m.from_year <= ? ORDER BY m.from_year DESC LIMIT 1), ${alias}.name)`;

const saveSettings_ = async (db: Database, s: Settings) => {
  await db.execute(
    `UPDATE settings SET business_name = ?, owner_name = ?, industry = ?, fiscal_year = ?, filing_type = ?,
            tax_status = ?, tax_method = ? WHERE id = 1`,
    [s.business_name, s.owner_name, s.industry, s.fiscal_year, s.filing_type, s.tax_status, s.tax_method],
  );
};

/** バックアップを残す世代数 */
export const getBackupGenerations = async (db: Database) => {
  const r = await db.select<{ backup_generations: number | null }[]>("SELECT backup_generations FROM settings WHERE id = 1");
  return r[0]?.backup_generations || DEFAULT_BACKUP_GENERATIONS;
};

const setBackupGenerations_ = async (db: Database, n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BACKUP_GENERATIONS) throw new Error(`世代数は 1〜${MAX_BACKUP_GENERATIONS} の整数で入れてください`);
  await db.execute("UPDATE settings SET backup_generations = ? WHERE id = 1", [n]);
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

const setAccountActive_ = async (db: Database, id: number, active: boolean) => {
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

const createAccount_ = async (db: Database, data: AccountInputData) => {
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
const updateAccount_ = async (db: Database, id: number, data: Omit<AccountInputData, "category">) => {
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before) return;
  const name = data.name.trim();
  if (await isStrict(db)) {
    if (name !== before.name) await assertYearOpen(db, year);
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
const deleteAccount_ = async (db: Database, id: number) => {
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

const createSub_ = async (db: Database, accountId: number, name: string, kana = "") => {
  const res = await db.execute(
    `INSERT INTO sub_accounts (account_id, name, kana, sort_order)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM sub_accounts WHERE account_id = ?))`,
    [accountId, name.trim(), kana.trim(), accountId],
  );
  const id = Number(res.lastInsertId);
  await logMaster(db, { target_type: "sub", target_id: id, action: "create", fiscal_year: await currentYear(db), label: await subLabel(db, id), old_value: "", new_value: name.trim() });
};

/** 補助科目の名前変更（厳密モードでは表示中の年度から。過去は元の名前） */
const renameSub_ = async (db: Database, id: number, name: string) => {
  const year = await currentYear(db);
  const before = (await getSubAccounts(db, year)).find((x) => x.id === id);
  const n = name.trim();
  if (!before || before.name === n) return;
  if (await isStrict(db)) {
    await assertYearOpen(db, year);
    await db.execute(
      "INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('sub', ?, ?, ?) ON CONFLICT (target_type, target_id, from_year) DO UPDATE SET name = excluded.name",
      [id, year, n],
    );
    await logMaster(db, { target_type: "sub", target_id: id, action: "rename", fiscal_year: year, label: await subLabel(db, id), old_value: before.name, new_value: n });
  } else {
    await db.execute("UPDATE sub_accounts SET name = ? WHERE id = ?", [n, id]);
  }
};

const setSubActive_ = async (db: Database, id: number, active: boolean) => {
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

const deleteSub_ = async (db: Database, id: number) => {
  const label = await subLabel(db, id);
  await db.execute("DELETE FROM sub_accounts WHERE id = ?", [id]);
  await logMaster(db, { target_type: "sub", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
};

// ────────────────────────────────────────────
// 取引先（任意で使う）
//  厳密モードでは追加・変更・非表示・削除を master_history に残す
// ────────────────────────────────────────────
export const getCounterparties = (db: Database) =>
  db.select<Counterparty[]>("SELECT id, name, kana, invoice_no, memo, is_active FROM counterparties ORDER BY kana = '', kana, name");

const counterpartyName = async (db: Database, id: number | null | undefined) => {
  if (!id) return "";
  const r = await db.select<{ name: string }[]>("SELECT name FROM counterparties WHERE id = ?", [id]);
  return r[0]?.name ?? `#${id}`;
};

const cpText = (c: { name: string; invoice_no: string; memo: string }) =>
  [c.name, c.invoice_no && `登録番号 ${c.invoice_no}`, c.memo && `メモ：${c.memo}`].filter(Boolean).join("　");

const createCounterparty_ = async (db: Database, d: CounterpartyInput) => {
  const c = { name: d.name.trim(), kana: d.kana.trim(), invoice_no: normalizeInvoiceNo(d.invoice_no), memo: d.memo.trim() };
  const res = await db.execute(
    "INSERT INTO counterparties (name, kana, invoice_no, memo) VALUES (?, ?, ?, ?)",
    [c.name, c.kana, c.invoice_no, c.memo],
  );
  const id = Number(res.lastInsertId);
  await logMaster(db, {
    target_type: "counterparty", target_id: id, action: "create", fiscal_year: await currentYear(db), label: c.name, old_value: "", new_value: cpText(c),
  });
  return id;
};

/** 名前の変更はすべての年度・過去の仕訳の表示に反映される（履歴の写しには記録時点の名前が残る） */
const updateCounterparty_ = async (db: Database, id: number, d: CounterpartyInput) => {
  const before = (await getCounterparties(db)).find((c) => c.id === id);
  if (!before) return;
  const c = { name: d.name.trim(), kana: d.kana.trim(), invoice_no: normalizeInvoiceNo(d.invoice_no), memo: d.memo.trim() };
  await db.execute("UPDATE counterparties SET name = ?, kana = ?, invoice_no = ?, memo = ? WHERE id = ?", [c.name, c.kana, c.invoice_no, c.memo, id]);
  const year = await currentYear(db);
  if (c.name !== before.name) {
    await logMaster(db, { target_type: "counterparty", target_id: id, action: "rename", fiscal_year: year, label: c.name, old_value: before.name, new_value: c.name });
  }
  if (c.invoice_no !== before.invoice_no || c.memo !== before.memo) {
    await logMaster(db, { target_type: "counterparty", target_id: id, action: "change", fiscal_year: year, label: c.name, old_value: cpText(before), new_value: cpText(c) });
  }
};

const setCounterpartyActive_ = async (db: Database, id: number, active: boolean) => {
  await db.execute("UPDATE counterparties SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, {
    target_type: "counterparty", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db),
    label: await counterpartyName(db, id), old_value: "", new_value: "",
  });
};

/** 使用件数（仕訳・証憑） */
export const counterpartyUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE counterparty_id = ?)
          + (SELECT COUNT(*) FROM evidences WHERE counterparty_id = ?) AS n`,
    [id, id],
  );
  return r[0].n;
};

/** 一度も使っていない取引先だけ削除できる（使ったものは非表示にする） */
const deleteCounterparty_ = async (db: Database, id: number) => {
  if ((await counterpartyUsage(db, id)) > 0) throw new Error("この取引先は使われているので削除できません。非表示にしてください");
  const label = await counterpartyName(db, id);
  await db.execute("DELETE FROM counterparties WHERE id = ?", [id]);
  await logMaster(db, { target_type: "counterparty", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
};

/** 名前が取引先一覧の名前と一致すれば、その取引先（証憑の取引先名から引く） */
const counterpartyIdByName = async (db: Database, name: string) => {
  const r = await db.select<{ id: number }[]>("SELECT id FROM counterparties WHERE name = ?", [name.trim()]);
  return r[0]?.id ?? null;
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
const saveOpening_ = async (db: Database, year: number, bySub: SubOpeningBalances, viaCarryForward = false) => {
  await assertYearOpen(db, year);
  const items = Object.entries(bySub).filter(([, v]) => v !== 0);
  const before = (await getOpening(db, year)).bySub;

  await db.execute("DELETE FROM opening_balances WHERE fiscal_year = ?", [year]);
  if (items.length > 0) {
    const placeholders = items.map(() => "(?, ?, ?, ?)").join(", ");
    const params = items.flatMap(([k, v]) => {
      const [acc, sub] = k.split(":").map(Number);
      return [year, acc, sub, v];
    });
    await db.execute(
      `INSERT INTO opening_balances (fiscal_year, account_id, sub_account_id, amount) VALUES ${placeholders}`,
      params,
    );
  }

  // 厳密モード：変わった金額を履歴に残す（書き込んだあとに記録する。記録の連鎖に変更後の状態を残すため）
  if (await isStrict(db)) {
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
};

// ────────────────────────────────────────────
// 仕訳
// ────────────────────────────────────────────

/** 期間内の仕訳明細を、日付・摘要つきで取得する（既定では削除済みを除く） */
export const getLines = (db: Database, from: string, to: string, includeDeleted = false) =>
  db.select<FlatLine[]>(
    `SELECT l.entry_id, e.date, e.description, e.is_deleted, e.revision, e.counterparty_id, l.row_no, l.side,
            l.account_id, l.sub_account_id, l.amount, l.memo
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.date BETWEEN ? AND ? ${includeDeleted ? "" : "AND e.is_deleted = 0"}
      ORDER BY e.date, l.entry_id, l.row_no, CASE l.side WHEN 'debit' THEN 0 ELSE 1 END`,
    [from, to],
  );

export const getEntry = async (db: Database, id: number): Promise<JournalEntry | null> => {
  const e = await db.select<Omit<JournalEntry, "lines">[]>(
    `SELECT e.id, e.date, e.description, e.counterparty_id, e.revision, e.is_deleted, e.created_at, e.updated_at,
            cu.name AS created_by_name, uu.name AS updated_by_name
       FROM journal_entries e LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by
      WHERE e.id = ?`,
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
const makeSnapshot = async (db: Database, date: string, lines: JournalLine[], counterpartyId: number | null = null): Promise<EntrySnapshot> => {
  // 仕訳の日付の年度で使われている名前で残す
  const year = Number(date.slice(0, 4));
  const accounts = await getAccounts(db, year);
  const subs = await getSubAccounts(db, year);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const counterparty = await counterpartyName(db, counterpartyId);
  return {
    date,
    ...(counterparty ? { counterparty } : {}),
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
  const res = await db.execute(
    "INSERT INTO entry_history (entry_id, revision, action, reason, snapshot, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    [entryId, revision, action, reason.trim(), JSON.stringify(snapshot), currentActor],
  );
  await appendChain(db, "entry_history", Number(res.lastInsertId), `entry:${entryId}`);
};

const createEntry_ = async (db: Database, date: string, lines: JournalLine[], counterpartyId: number | null = null) => {
  await assertDateOpen(db, date);
  const res = await db.execute(
    "INSERT INTO journal_entries (date, description, counterparty_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)",
    [date, descriptionOf(lines), counterpartyId, currentActor, currentActor],
  );
  const entryId = Number(res.lastInsertId);
  // 途中で失敗しても tx() が丸ごと取り消す
  await insertLines(db, entryId, lines);
  if (await isStrict(db)) await writeHistory(db, entryId, 1, "create", await makeSnapshot(db, date, lines, counterpartyId), "");
  return entryId;
};

/** 訂正：仕訳を書き換える。厳密モードでは新しい版を履歴に積む */
/** counterpartyId を省くと取引先はそのまま（null を渡すと外す） */
const updateEntry_ = async (
  db: Database, id: number, date: string, lines: JournalLine[], reason = "", counterpartyId?: number | null,
) => {
  const before = await getEntry(db, id);
  if (!before) throw new Error("仕訳が見つかりません");
  if (before.is_deleted) throw new Error("削除済みの仕訳は訂正できません");
  // 元の日付・新しい日付のどちらかが締め済みの年度なら訂正できない（明細だけ書き換わるのを防ぐため先に確認）
  await assertDateOpen(db, before.date);
  await assertDateOpen(db, date);
  const revision = before.revision + 1;
  const cp = counterpartyId === undefined ? before.counterparty_id : counterpartyId;

  await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
  await insertLines(db, id, lines);
  await db.execute(
    `UPDATE journal_entries SET date = ?, description = ?, counterparty_id = ?, revision = ?, updated_by = ?,
            updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [date, descriptionOf(lines), cp, revision, currentActor, id],
  );
  if (await isStrict(db)) await writeHistory(db, id, revision, "update", await makeSnapshot(db, date, lines, cp), reason);
};

/** 削除：厳密モードでは消さずに「削除済み」にし、削除時点の内容を履歴に残す */
const deleteEntry_ = async (db: Database, id: number, reason = "") => {
  const before = await getEntry(db, id);
  if (!before || before.is_deleted) return;
  await assertDateOpen(db, before.date);
  // 通常モード：本当に消す（履歴が無いのでトリガーにも止められない）
  if (!(await isStrict(db))) {
    // 証憑そのものは残し、この仕訳とのひも付けだけ外す
    await db.execute("DELETE FROM evidence_links WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM journal_entries WHERE id = ?", [id]);
    return;
  }
  const revision = before.revision + 1;
  await db.execute(
    `UPDATE journal_entries SET is_deleted = 1, revision = ?, updated_by = ?, deleted_at = DATETIME('now','localtime'),
            updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [revision, currentActor, id],
  );
  await writeHistory(db, id, revision, "delete", await makeSnapshot(db, before.date, before.lines, before.counterparty_id), reason);
};

interface HistoryRow extends Omit<HistoryRecord, "snapshot"> { snapshot: string }

/** 履歴（entryId を渡せばその仕訳だけ）。新しい順 */
export const getHistory = async (db: Database, entryId?: number): Promise<HistoryRecord[]> => {
  const rows = await db.select<HistoryRow[]>(
    `SELECT h.id, h.entry_id, h.revision, h.action, h.recorded_at, h.reason, h.snapshot, u.name AS user_name
       FROM entry_history h LEFT JOIN users u ON u.id = h.user_id
      ${entryId ? "WHERE h.entry_id = ?" : ""} ORDER BY h.id DESC LIMIT 2000`,
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
const saveHomeUseRate_ = async (db: Database, year: number, rate: Omit<HomeUseRate, "from_year">) => {
  await assertYearOpen(db, year);
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

const setHomeUseRun_ = (db: Database, year: number, entryId: number) =>
  db.execute(
    "INSERT INTO home_use_runs (fiscal_year, entry_id) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET entry_id = excluded.entry_id",
    [year, entryId],
  );

// ────────────────────────────────────────────
// 証憑
//  - ファイルの中身は登録後に変えられない（トリガーでも拒否）
//  - 厳密モード：削除せず無効の印。登録・訂正・無効・ひも付けを evidence_history に残す
//  - 通常モード：履歴なし。削除は物理削除
// ────────────────────────────────────────────
interface EvidenceRow extends Omit<Evidence, "entry_ids"> { entry_ids: string | null }

const EVIDENCE_COLUMNS = `ev.id, ev.counterparty_id, ev.kind, ev.doc_type, ev.txn_date, ev.amount, ev.counterparty, ev.memo, ev.file_name, ev.mime, ev.size,
  ev.sha256, ev.revision, ev.is_void, ev.created_at, ev.updated_at, ev.voided_at,
  (SELECT GROUP_CONCAT(entry_id) FROM (SELECT entry_id FROM evidence_links WHERE evidence_id = ev.id ORDER BY entry_id)) AS entry_ids`;

const toEvidence = (r: EvidenceRow): Evidence => ({
  ...r,
  entry_ids: r.entry_ids ? String(r.entry_ids).split(",").map(Number) : [],
});

/** 証憑の一覧（ファイルの中身は含まない）。新しい取引年月日から */
export const getEvidences = async (db: Database) =>
  (await db.select<EvidenceRow[]>(`SELECT ${EVIDENCE_COLUMNS} FROM evidences ev ORDER BY ev.txn_date DESC, ev.id DESC`)).map(toEvidence);

export const getEvidence = async (db: Database, id: number) => {
  const r = await db.select<EvidenceRow[]>(`SELECT ${EVIDENCE_COLUMNS} FROM evidences ev WHERE ev.id = ?`, [id]);
  return r[0] ? toEvidence(r[0]) : null;
};

/** 仕訳にひも付いている証憑 */
export const getEntryEvidences = async (db: Database, entryId: number) =>
  (await db.select<EvidenceRow[]>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidences ev JOIN evidence_links l ON l.evidence_id = ev.id
      WHERE l.entry_id = ? ORDER BY ev.txn_date, ev.id`,
    [entryId],
  )).map(toEvidence);

/** 仕訳ごとの証憑の件数（無効を除く）。伝票番号 → 件数 */
export const getEvidenceCounts = async (db: Database) => {
  const rows = await db.select<{ entry_id: number; n: number }[]>(
    `SELECT l.entry_id, COUNT(*) AS n FROM evidence_links l JOIN evidences ev ON ev.id = l.evidence_id
      WHERE ev.is_void = 0 GROUP BY l.entry_id`,
  );
  return new Map(rows.map((r) => [r.entry_id, r.n]));
};

/** ファイルの中身 */
export const getEvidenceBytes = async (db: Database, id: number) => {
  const r = await db.select<{ data: string }[]>("SELECT data FROM evidence_files WHERE evidence_id = ?", [id]);
  if (!r[0]) throw new Error("証憑のファイルが見つかりません");
  return fromBase64(r[0].data);
};

const evidenceSnapshot = (e: Evidence): EvidenceSnapshot => ({
  kind: e.kind, doc_type: e.doc_type, txn_date: e.txn_date, amount: e.amount, counterparty: e.counterparty, memo: e.memo,
  file_name: e.file_name, mime: e.mime, size: e.size, sha256: e.sha256, entry_ids: e.entry_ids,
});

/** 今の状態を履歴に積む（厳密モードのみ。呼ぶ前に revision を上げておく） */
const writeEvidenceHistory = async (db: Database, id: number, action: EvidenceAction, reason: string) => {
  if (!(await isStrict(db))) return;
  const e = await getEvidence(db, id);
  if (!e) return;
  const res = await db.execute(
    "INSERT INTO evidence_history (evidence_id, revision, action, reason, snapshot, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    [id, e.revision, action, reason.trim(), JSON.stringify(evidenceSnapshot(e)), currentActor],
  );
  await appendChain(db, "evidence_history", Number(res.lastInsertId), `evidence:${id}`);
};

const bumpEvidence = (db: Database, id: number) =>
  db.execute("UPDATE evidences SET revision = revision + 1, updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?", [currentActor, id]);

const cleanMeta = (m: EvidenceMeta): EvidenceMeta => ({ ...m, counterparty: m.counterparty.trim(), memo: m.memo.trim() });

/** 証憑を登録する。ファイルの種類・大きさ・ハッシュはここで決める（画面から渡された値は信用しない） */
const createEvidence_ = async (
  db: Database, meta: EvidenceMeta, file: { name: string; bytes: Uint8Array }, kind: EvidenceKind = "electronic",
) => {
  const fileErr = validateEvidenceFile(file.bytes, file.name);
  if (fileErr) throw new Error(fileErr);
  const metaErr = validateEvidenceMeta(meta);
  if (metaErr) throw new Error(metaErr);
  const type = detectFileType(file.bytes, file.name)!;
  const hash = await sha256Hex(file.bytes);
  const m = cleanMeta(meta);
  const res = await db.execute(
    `INSERT INTO evidences (kind, doc_type, txn_date, amount, counterparty, counterparty_id, memo, file_name, mime, size, sha256, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, m.doc_type, m.txn_date, m.amount, m.counterparty, await counterpartyIdByName(db, m.counterparty), m.memo, file.name, type.mime,
      file.bytes.length, hash, currentActor, currentActor],
  );
  const id = Number(res.lastInsertId);
  // 途中で失敗しても tx() が丸ごと取り消す
  await db.execute("INSERT INTO evidence_files (evidence_id, data) VALUES (?, ?)", [id, toBase64(file.bytes)]);
  await writeEvidenceHistory(db, id, "create", "");
  return id;
};

/** 項目（取引年月日・金額・取引先など）の訂正。ファイルは変えられない */
const updateEvidence_ = async (db: Database, id: number, meta: EvidenceMeta, reason = "") => {
  const err = validateEvidenceMeta(meta);
  if (err) throw new Error(err);
  const before = await getEvidence(db, id);
  if (!before) throw new Error("証憑が見つかりません");
  if (before.is_void) throw new Error("無効にした証憑は訂正できません");
  const m = cleanMeta(meta);
  await db.execute(
    `UPDATE evidences SET doc_type = ?, txn_date = ?, amount = ?, counterparty = ?, counterparty_id = ?, memo = ?,
            revision = revision + 1, updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [m.doc_type, m.txn_date, m.amount, m.counterparty, await counterpartyIdByName(db, m.counterparty), m.memo, currentActor, id],
  );
  await writeEvidenceHistory(db, id, "update", reason);
};

/** 厳密モード：無効の印をつける（中身と履歴は残る）。通常モード：削除する */
const voidEvidence_ = async (db: Database, id: number, reason = "") => {
  const before = await getEvidence(db, id);
  if (!before || before.is_void) return;
  if (!(await isStrict(db))) {
    await db.execute("DELETE FROM evidence_links WHERE evidence_id = ?", [id]);
    await db.execute("DELETE FROM evidence_files WHERE evidence_id = ?", [id]);
    await db.execute("DELETE FROM evidences WHERE id = ?", [id]);
    return;
  }
  // 無効にしてから履歴を積む（記録の連鎖に無効にしたあとの状態を残すため。無効にした行は以後変更できない）
  await db.execute(
    `UPDATE evidences SET is_void = 1, revision = revision + 1, voided_at = DATETIME('now','localtime'),
            updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [currentActor, id],
  );
  await writeEvidenceHistory(db, id, "void", reason);
};

/** 仕訳とひも付ける */
const linkEvidence_ = async (db: Database, evidenceId: number, entryId: number) => {
  const ev = await getEvidence(db, evidenceId);
  if (!ev || ev.is_void) throw new Error("無効にした証憑はひも付けられません");
  const entry = await getEntry(db, entryId);
  if (!entry || entry.is_deleted) throw new Error("削除済みの仕訳にはひも付けられません");
  const res = await db.execute("INSERT OR IGNORE INTO evidence_links (evidence_id, entry_id) VALUES (?, ?)", [evidenceId, entryId]);
  if (res.rowsAffected === 0) return;
  await bumpEvidence(db, evidenceId);
  await writeEvidenceHistory(db, evidenceId, "link", `伝票 No.${entryId}`);
};

/** ひも付けを外す */
const unlinkEvidence_ = async (db: Database, evidenceId: number, entryId: number) => {
  const ev = await getEvidence(db, evidenceId);
  if (!ev || ev.is_void) throw new Error("無効にした証憑は変更できません");
  const res = await db.execute("DELETE FROM evidence_links WHERE evidence_id = ? AND entry_id = ?", [evidenceId, entryId]);
  if (res.rowsAffected === 0) return;
  await bumpEvidence(db, evidenceId);
  await writeEvidenceHistory(db, evidenceId, "unlink", `伝票 No.${entryId}`);
};

interface EvidenceHistoryRow extends Omit<EvidenceHistoryRecord, "snapshot"> { snapshot: string }

export const getEvidenceHistory = async (db: Database, evidenceId?: number): Promise<EvidenceHistoryRecord[]> => {
  const rows = await db.select<EvidenceHistoryRow[]>(
    `SELECT h.id, h.evidence_id, h.revision, h.action, h.recorded_at, h.reason, h.snapshot, u.name AS user_name
       FROM evidence_history h LEFT JOIN users u ON u.id = h.user_id
      ${evidenceId ? "WHERE h.evidence_id = ?" : ""} ORDER BY h.id DESC LIMIT 2000`,
    evidenceId ? [evidenceId] : [],
  );
  return rows.map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) as EvidenceSnapshot }));
};

export interface EvidenceCheckResult {
  id: number;
  /** ok = 中身のハッシュが記録と一致 */
  status: "ok" | "changed" | "missing";
  detail: string;
}

/**
 * 改ざんの確認：ファイルの中身から計算したハッシュを、証憑の記録と、登録時の履歴（厳密モード）の両方と比べる。
 * 中身と記録を同時に書き換えられても、書き換え不可の履歴と食い違えば見つけられる
 */
export const verifyEvidences = async (db: Database): Promise<EvidenceCheckResult[]> => {
  const list = await getEvidences(db);
  const created = await db.select<{ evidence_id: number; snapshot: string }[]>(
    "SELECT evidence_id, snapshot FROM evidence_history WHERE action = 'create'",
  );
  const firstHash = new Map(created.map((r) => [r.evidence_id, (JSON.parse(r.snapshot) as EvidenceSnapshot).sha256]));
  const out: EvidenceCheckResult[] = [];
  for (const e of list) {
    let bytes: Uint8Array;
    try {
      bytes = await getEvidenceBytes(db, e.id);
    } catch {
      out.push({ id: e.id, status: "missing", detail: "ファイルの中身がありません" });
      continue;
    }
    const actual = await sha256Hex(bytes);
    const recorded = firstHash.get(e.id);
    if (actual !== e.sha256) out.push({ id: e.id, status: "changed", detail: "中身が登録時のハッシュと一致しません" });
    else if (recorded !== undefined && recorded !== e.sha256) out.push({ id: e.id, status: "changed", detail: "ハッシュの記録が登録時の履歴と一致しません" });
    else out.push({ id: e.id, status: "ok", detail: "" });
  }
  return out;
};

/** 取引先の入力候補（証憑で使ったもの） */
export const getEvidenceCounterparties = async (db: Database) =>
  (await db.select<{ c: string }[]>(
    "SELECT counterparty AS c FROM evidences WHERE counterparty <> '' GROUP BY counterparty ORDER BY COUNT(*) DESC LIMIT 300",
  )).map((r) => r.c);

/** 同じ中身のファイルがすでに登録されていないか（無効のものを除く） */
export const findEvidenceByHash = async (db: Database, sha256: string) => {
  const r = await db.select<{ id: number }[]>("SELECT id FROM evidences WHERE sha256 = ? AND is_void = 0 ORDER BY id", [sha256]);
  return r.map((x) => x.id);
};

// ────────────────────────────────────────────
// 改ざんの検知（厳密モードのみ）。考え方は lib/integrity.ts
// ────────────────────────────────────────────
const chainReady = async (db: Database) => {
  const r = await db.select<{ e_book_mode: string | null; chain_initialized: number }[]>(
    "SELECT e_book_mode, chain_initialized FROM settings WHERE id = 1",
  );
  return r[0]?.e_book_mode === "strict" && r[0].chain_initialized === 1;
};

/** 状態のキー（entry:12 など）の今の中身（正規形） */
const currentState = async (db: Database, key: string): Promise<string> => {
  const [kind, idStr] = key.split(":");
  const id = Number(idStr);
  if (kind === "entry") {
    const e = await db.select<{ date: string; counterparty_id: number | null; is_deleted: number; revision: number }[]>(
      "SELECT date, counterparty_id, is_deleted, revision FROM journal_entries WHERE id = ?", [id],
    );
    if (!e[0]) return "null";
    const lines = await db.select<{ row_no: number; side: string; account_id: number; sub_account_id: number | null; amount: number; memo: string }[]>(
      "SELECT row_no, side, account_id, sub_account_id, amount, memo FROM journal_lines WHERE entry_id = ?", [id],
    );
    return entryState(e[0], lines);
  }
  if (kind === "evidence") {
    const e = await db.select<Parameters<typeof evidenceState>[0][]>(
      `SELECT doc_type, txn_date, amount, counterparty, counterparty_id, memo, file_name, mime, size, sha256, revision, is_void
         FROM evidences WHERE id = ?`, [id],
    );
    if (!e[0]) return "null";
    const links = await db.select<{ entry_id: number }[]>("SELECT entry_id FROM evidence_links WHERE evidence_id = ?", [id]);
    return evidenceState(e[0], links.map((l) => l.entry_id));
  }
  if (kind === "opening") {
    return openingState(await db.select<{ account_id: number; sub_account_id: number; amount: number }[]>(
      "SELECT account_id, sub_account_id, amount FROM opening_balances WHERE fiscal_year = ?", [id],
    ));
  }
  if (kind === "closing") {
    const c = await db.select<{ period_start: string; period_end: string }[]>(
      "SELECT period_start, period_end FROM fiscal_closings WHERE fiscal_year = ?", [id],
    );
    return closingState(c[0] ?? null);
  }
  return "";
};

/** 連鎖の「基準点」：連鎖を始めた時点の状態を記録する行（source = baseline、source_id は基準点の通し番号。中身は state_key そのもの） */
const BASELINE = "baseline";

const loadHistoryRow = async (db: Database, source: ChainSource, id: number) => {
  const r = await db.select<Record<string, unknown>[]>(`SELECT * FROM ${source} WHERE id = ?`, [id]);
  return r[0];
};

export const getChainHead = async (db: Database) => {
  const r = await db.select<{ id: number; row_hash: string; recorded_at: string }[]>(
    "SELECT id, row_hash, recorded_at FROM audit_chain ORDER BY id DESC LIMIT 1",
  );
  return r[0] ?? null;
};

/** 連鎖に1行積む（厳密モードで、連鎖を始めたあとだけ） */
const appendChain = async (db: Database, source: ChainSource | typeof BASELINE, sourceId: number, stateKey = "", force = false) => {
  if (!force && !(await chainReady(db))) return;
  let content: string;
  if (source === BASELINE) content = stateKey;
  else {
    const row = await loadHistoryRow(db, source, sourceId);
    if (!row) return;
    content = historyContent(row, HISTORY_COLUMNS[source]);
  }
  const prev = (await getChainHead(db))?.row_hash ?? GENESIS;
  const link = {
    prev_hash: prev, source, source_id: sourceId, state_key: stateKey,
    state_hash: stateKey ? await hashText(await currentState(db, stateKey)) : "",
    content_hash: await hashText(content),
  };
  await db.execute(
    `INSERT INTO audit_chain (source, source_id, state_key, state_hash, content_hash, prev_hash, row_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [link.source, link.source_id, link.state_key, link.state_hash, link.content_hash, link.prev_hash, await chainHash(link)],
  );
};

/** 状態を持つもの（仕訳・証憑・期首残高・締め）のキーの一覧 */
const allStateKeys = async (db: Database) => {
  const ids = async (sql: string) => (await db.select<{ k: number }[]>(sql)).map((r) => r.k);
  return [
    ...(await ids("SELECT id AS k FROM journal_entries ORDER BY id")).map((k) => `entry:${k}`),
    ...(await ids("SELECT id AS k FROM evidences ORDER BY id")).map((k) => `evidence:${k}`),
    ...(await ids("SELECT DISTINCT fiscal_year AS k FROM opening_balances ORDER BY k")).map((k) => `opening:${k}`),
    ...(await ids("SELECT fiscal_year AS k FROM fiscal_closings ORDER BY k")).map((k) => `closing:${k}`),
  ];
};

/**
 * 記録の連鎖を始める（厳密モードの帳簿で一度だけ）。
 * この仕組みを入れる前の履歴を連鎖に取り込み、今の状態を基準点として記録する。
 * これより前に直接書き換えられていたものは見つけられない（README の課題に記載）
 */
const initChain_ = async (db: Database) => {
  const r = await db.select<{ e_book_mode: string | null; chain_initialized: number }[]>(
    "SELECT e_book_mode, chain_initialized FROM settings WHERE id = 1",
  );
  if (!r[0] || r[0].e_book_mode !== "strict" || r[0].chain_initialized) return;
  const sources = Object.keys(HISTORY_COLUMNS) as ChainSource[];
  const rows: { source: ChainSource; id: number; at: string }[] = [];
  for (const src of sources) {
    const xs = await db.select<{ id: number; recorded_at: string }[]>(`SELECT id, recorded_at FROM ${src}`);
    rows.push(...xs.map((x) => ({ source: src, id: x.id, at: x.recorded_at })));
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || sources.indexOf(a.source) - sources.indexOf(b.source) || a.id - b.id);
  for (const x of rows) await appendChain(db, x.source, x.id, "", true);
  let n = 0;
  for (const key of await allStateKeys(db)) await appendChain(db, BASELINE, ++n, key, true);
  await db.execute("UPDATE settings SET chain_initialized = 1 WHERE id = 1");
};

/** 検知した出来事を記録する（厳密モード） */
const recordEvent = async (db: Database, kind: string, detail: string) => {
  if (!(await isStrict(db))) return;
  const res = await db.execute("INSERT INTO integrity_events (kind, detail, user_id) VALUES (?, ?, ?)", [kind, detail, currentActor]);
  await appendChain(db, "integrity_events", Number(res.lastInsertId));
};

export const getIntegrityEvents = (db: Database) =>
  db.select<{ id: number; kind: string; detail: string; recorded_at: string }[]>("SELECT * FROM integrity_events ORDER BY id DESC");

/**
 * トリガーが消されていなかったかを確かめる（帳簿を開いたとき）。
 * 前回開いたときにあったトリガーが、今回開く前に無くなっていたら記録する。
 * トリガーは開くたびに作り直すので、消されても黙って元に戻ってしまう。その前に気づくための確認
 */
const checkTriggers_ = async (db: Database, before: string[]) => {
  const r = await db.select<{ known_triggers: string }[]>("SELECT known_triggers FROM settings WHERE id = 1");
  const known: string[] = r[0]?.known_triggers ? JSON.parse(r[0].known_triggers) : [];
  const missing = known.filter((n) => !before.includes(n));
  if (missing.length > 0) await recordEvent(db, "trigger_missing", `帳簿を開く前に、次のトリガー（書き換え防止の仕組み）が消されていました：${missing.join("、")}`);
  const now = (await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map((x) => x.name);
  await db.execute("UPDATE settings SET known_triggers = ? WHERE id = 1", [JSON.stringify(now)]);
};

export interface IntegrityReport {
  /** 厳密モードでなければ false（連鎖による検知はしない） */
  enabled: boolean;
  issues: IntegrityIssue[];
  /** 連鎖の件数・先頭 */
  length: number;
  head: { id: number; row_hash: string; recorded_at: string } | null;
}

/**
 * 改ざんの確認
 *  1. 連鎖をたどって、履歴の書き換え・削除を見つける
 *  2. 連鎖に入っていない履歴（ソフトを通さずに足された可能性）を見つける
 *  3. 仕訳・証憑・期首残高・締めの今の中身を、最後に記録した状態と比べる
 *  4. 検知の記録（トリガーが消されていた、など）を出す
 *  5. files = true なら証憑ファイルの中身もハッシュで確かめる
 */
export const verifyIntegrity = async (db: Database, opts: { files?: boolean } = {}): Promise<IntegrityReport> => {
  const issues: IntegrityIssue[] = [];
  if (opts.files) {
    for (const c of await verifyEvidences(db)) {
      if (c.status !== "ok") issues.push({ level: "error", message: `証憑 No.${c.id}：${c.detail}` });
    }
  }
  if (!(await chainReady(db))) return { enabled: false, issues, length: 0, head: null };

  const chain = await db.select<ChainRow[]>("SELECT * FROM audit_chain ORDER BY id");
  const contents = new Map<string, string>();
  const sources = Object.keys(HISTORY_COLUMNS) as ChainSource[];
  for (const src of sources) {
    for (const row of await db.select<Record<string, unknown>[]>(`SELECT * FROM ${src}`)) {
      contents.set(`${src}:${row.id}`, historyContent(row, HISTORY_COLUMNS[src]));
    }
  }
  issues.push(...(await verifyChain(chain, (src, id) => {
    if (src === BASELINE) return chain.find((c) => c.source === BASELINE && c.source_id === id)?.state_key; // 基準点は中身 = キー
    return contents.get(`${src}:${id}`);
  })));

  // 連鎖に入っていない履歴
  const chained = new Set(chain.map((c) => `${c.source}:${c.source_id}`));
  for (const key of contents.keys()) {
    if (!chained.has(key)) {
      const [src, id] = key.split(":");
      issues.push({ level: "warn", message: `${sourceLabel(src)} No.${id} が記録の連鎖に入っていません（ソフトを通さずに追加された、または記録の途中でソフトが止まった可能性があります）` });
    }
  }

  // 今の中身と、最後に記録した状態
  const latest = new Map<string, string>();
  for (const c of chain) if (c.state_key) latest.set(c.state_key, c.state_hash);
  const keys = new Set([...latest.keys(), ...(await allStateKeys(db))]);
  for (const key of keys) {
    const recorded = latest.get(key);
    const now = await hashText(await currentState(db, key));
    if (recorded === undefined) {
      issues.push({ level: "error", message: `${stateLabel(key)} に記録がありません（ソフトを通さずに追加された可能性があります）` });
    } else if (recorded !== now) {
      issues.push({ level: "error", message: `${stateLabel(key)} が、最後に記録した内容と一致しません（ソフトを通さずに変更された、または保存の途中でソフトが止まった可能性があります）` });
    }
  }

  for (const ev of await getIntegrityEvents(db)) issues.push({ level: "warn", message: `${ev.recorded_at}　${ev.detail}` });

  return { enabled: true, issues, length: chain.length, head: chain.length ? chain[chain.length - 1] : null };
};

/**
 * 控えておいた確認コードが、今の連鎖の中にあるか。
 * 連鎖をまるごと計算し直されていると、控えたコードが見つからなくなる
 */
export const findAnchor = async (db: Database, code: string) => {
  const c = normalizeAnchor(code);
  if (c.length < 16) throw new Error("確認コードが短すぎます");
  const r = await db.select<{ id: number; recorded_at: string; row_hash: string }[]>(
    "SELECT id, recorded_at, row_hash FROM audit_chain WHERE row_hash LIKE ? ORDER BY id LIMIT 1",
    [`${c}%`],
  );
  return r[0] ?? null;
};

export { anchorCode };

// ────────────────────────────────────────────
// ユーザー（権限はまだ分けない。誰が操作したかを記録するため）
// ────────────────────────────────────────────
export const getUsers = (db: Database) =>
  db.select<User[]>(
    "SELECT id, name, (password_hash <> '') AS has_password, is_active, created_at FROM users ORDER BY id",
  );

const userName = async (db: Database, id: number) =>
  (await db.select<{ name: string }[]>("SELECT name FROM users WHERE id = ?", [id]))[0]?.name ?? `#${id}`;

export const validateUserName = (users: User[], name: string, editingId?: number): string | null => {
  const n = name.trim();
  if (!n) return "ユーザー名を入れてください";
  if (n.length > 30) return "ユーザー名は30文字までです";
  if (users.some((u) => u.id !== editingId && u.name === n)) return "同じ名前のユーザーがいます";
  return null;
};

const createUser_ = async (db: Database, name: string, password = "") => {
  const err = validateUserName(await getUsers(db), name);
  if (err) throw new Error(err);
  if (password) {
    const pe = validatePassword(password);
    if (pe) throw new Error(pe);
  }
  const res = await db.execute("INSERT INTO users (name, password_hash) VALUES (?, ?)", [name.trim(), password ? await hashPassword(password) : ""]);
  const id = Number(res.lastInsertId);
  await logMaster(db, {
    target_type: "user", target_id: id, action: "create", fiscal_year: await currentYear(db), label: name.trim(),
    old_value: "", new_value: password ? "パスワードあり" : "パスワードなし",
  });
  return id;
};

const renameUser_ = async (db: Database, id: number, name: string) => {
  const err = validateUserName(await getUsers(db), name, id);
  if (err) throw new Error(err);
  const before = await userName(db, id);
  if (before === name.trim()) return;
  await db.execute("UPDATE users SET name = ? WHERE id = ?", [name.trim(), id]);
  await logMaster(db, { target_type: "user", target_id: id, action: "rename", fiscal_year: await currentYear(db), label: name.trim(), old_value: before, new_value: name.trim() });
};

/**
 * パスワードの設定・変更・解除（newPassword が空なら解除）。
 * すでにパスワードがあるときは、今のパスワードが必要（他の人に勝手に変えられないように）
 */
const setUserPassword_ = async (db: Database, id: number, currentPassword: string, newPassword: string) => {
  const r = await db.select<{ password_hash: string }[]>("SELECT password_hash FROM users WHERE id = ?", [id]);
  if (!r[0]) throw new Error("ユーザーが見つかりません");
  if (!(await verifyPassword(currentPassword, r[0].password_hash))) throw new Error("今のパスワードが違います");
  if (newPassword) {
    const pe = validatePassword(newPassword);
    if (pe) throw new Error(pe);
  }
  await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [newPassword ? await hashPassword(newPassword) : "", id]);
  await logMaster(db, {
    target_type: "user", target_id: id, action: "change", fiscal_year: await currentYear(db), label: await userName(db, id),
    old_value: r[0].password_hash ? "パスワードあり" : "パスワードなし", new_value: newPassword ? (r[0].password_hash ? "パスワードを変更" : "パスワードあり") : "パスワードなし",
  });
};

/** 使わなくなったユーザーは非表示（履歴に名前が残るので削除はしない）。使えるユーザーが1人もいなくなる変更は不可 */
const setUserActive_ = async (db: Database, id: number, active: boolean) => {
  if (!active) {
    const others = (await getUsers(db)).filter((u) => u.is_active && u.id !== id);
    if (others.length === 0) throw new Error("使えるユーザーが1人もいなくなるため、非表示にできません");
  }
  await db.execute("UPDATE users SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, { target_type: "user", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db), label: await userName(db, id), old_value: "", new_value: "" });
};

/** ユーザーが1人もいなければ、最初のユーザー（パスワードなし）を作る。帳簿を開いたときに呼ぶ */
const ensureUsers_ = async (db: Database, defaultName: string) => {
  if ((await getUsers(db)).length > 0) return;
  await createUser_(db, defaultName.trim() || "利用者1");
};

/** パスワードの確認（パスワードなしのユーザーは常に通る） */
export const checkLogin = async (db: Database, id: number, password: string) => {
  const r = await db.select<{ password_hash: string; is_active: number }[]>("SELECT password_hash, is_active FROM users WHERE id = ?", [id]);
  return !!r[0] && r[0].is_active === 1 && (await verifyPassword(password, r[0].password_hash));
};

/** ログイン・ログアウトの記録（どちらのモードでも残す。厳密モードでは記録の連鎖にも入れる） */
const logAccess_ = async (db: Database, userId: number, action: "login" | "logout") => {
  const res = await db.execute("INSERT INTO access_log (user_id, action) VALUES (?, ?)", [userId, action]);
  await appendChain(db, "access_log", Number(res.lastInsertId));
};

export const getAccessLog = (db: Database) =>
  db.select<AccessLogRecord[]>(
    "SELECT a.id, a.user_id, u.name AS user_name, a.action, a.recorded_at FROM access_log a JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 2000",
  );

/** 翌年への繰越：翌年の期首残高を保存し、この年度を締める（1つのトランザクションで） */
const carryForward_ = async (db: Database, year: number, nextOpening: SubOpeningBalances) => {
  await saveOpening_(db, year + 1, nextOpening, true);
  await closeYear_(db, year, "繰越処理による締め");
};

/** 家事按分の年末振替の仕訳を作る（作り直すときは同じ仕訳を訂正する）。仕訳の登録と記録を1つのトランザクションで */
const saveHomeUseRunEntry_ = async (db: Database, year: number, date: string, lines: JournalLine[], runId: number | null) => {
  if (runId) {
    await updateEntry_(db, runId, date, lines, "家事按分の再計算");
    return runId;
  }
  const id = await createEntry_(db, date, lines);
  await setHomeUseRun_(db, year, id);
  return id;
};

// ────────────────────────────────────────────
// 書き込みの入り口（すべてトランザクションの中で行う）
// ────────────────────────────────────────────
export const setEBookMode = inTx(setEBookMode_, () => "保存方式の設定");
export const saveSettings = inTx(saveSettings_, () => "事業者設定の保存");
export const setBackupGenerations = inTx(setBackupGenerations_, () => "バックアップ世代数の保存");
export const setAccountActive = inTx(setAccountActive_, (id) => `勘定科目 #${id} の表示切り替え`);
export const createAccount = inTx(createAccount_, (d) => `勘定科目「${d.name}」の追加`);
export const updateAccount = inTx(updateAccount_, (id) => `勘定科目 #${id} の変更`);
export const deleteAccount = inTx(deleteAccount_, (id) => `勘定科目 #${id} の削除`);
export const createSub = inTx(createSub_, (_a, name) => `補助科目「${name}」の追加`);
export const renameSub = inTx(renameSub_, (id) => `補助科目 #${id} の名前変更`);
export const setSubActive = inTx(setSubActive_, (id) => `補助科目 #${id} の表示切り替え`);
export const deleteSub = inTx(deleteSub_, (id) => `補助科目 #${id} の削除`);
export const createCounterparty = inTx(createCounterparty_, (d) => `取引先「${d.name}」の追加`);
export const updateCounterparty = inTx(updateCounterparty_, (id) => `取引先 #${id} の変更`);
export const setCounterpartyActive = inTx(setCounterpartyActive_, (id) => `取引先 #${id} の表示切り替え`);
export const deleteCounterparty = inTx(deleteCounterparty_, (id) => `取引先 #${id} の削除`);
export const saveOpening = inTx(saveOpening_, (year) => `${year}年の期首残高の保存`);
export const createEntry = inTx(createEntry_, (date) => `仕訳（${date}）の登録`);
export const updateEntry = inTx(updateEntry_, (id) => `伝票 No.${id} の訂正`);
export const deleteEntry = inTx(deleteEntry_, (id) => `伝票 No.${id} の削除`);
export const saveHomeUseRate = inTx(saveHomeUseRate_, (year) => `${year}年の家事按分の設定`);
export const setHomeUseRun = inTx(setHomeUseRun_, (year) => `${year}年の家事按分の振替`);
export const closeYear = inTx(closeYear_, (year) => `${year}年の締め`);
export const reopenYear = inTx(reopenYear_, (year) => `${year}年の締めの解除`);
export const initClosings = inTx(initClosings_, () => "繰越済みの年度の締め");
export const createEvidence = inTx(createEvidence_, (m) => `証憑（${m.txn_date} ${m.counterparty}）の取り込み`);
export const updateEvidence = inTx(updateEvidence_, (id) => `証憑 No.${id} の訂正`);
export const voidEvidence = inTx(voidEvidence_, (id) => `証憑 No.${id} の無効・削除`);
export const linkEvidence = inTx(linkEvidence_, (e, entry) => `証憑 No.${e} と伝票 No.${entry} のひも付け`);
export const unlinkEvidence = inTx(unlinkEvidence_, (e, entry) => `証憑 No.${e} と伝票 No.${entry} のひも付け解除`);
export const initChain = inTx(initChain_, () => "記録の連鎖の開始");
export const checkTriggers = inTx(checkTriggers_, () => "トリガーの確認");
export const createUser = inTx(createUser_, (name) => `ユーザー「${name}」の追加`);
export const renameUser = inTx(renameUser_, (id) => `ユーザー #${id} の名前変更`);
export const setUserPassword = inTx(setUserPassword_, (id) => `ユーザー #${id} のパスワード`);
export const setUserActive = inTx(setUserActive_, (id) => `ユーザー #${id} の表示切り替え`);
export const ensureUsers = inTx(ensureUsers_, () => "最初のユーザーの作成");
export const logAccess = inTx(logAccess_, (id, action) => `ユーザー #${id} の${action === "login" ? "ログイン" : "ログアウト"}`);
export const carryForward = inTx(carryForward_, (year) => `${year}年から${year + 1}年への繰越`);
export const saveHomeUseRunEntry = inTx(saveHomeUseRunEntry_, (year) => `${year}年の家事按分の振替`);
