/**
 * repo.ts を、bun:sqlite のメモリ上の DB で動かして確かめる
 * （tauri-plugin-sql の Database と同じ形の select / execute だけを用意する）
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA } from "./schema";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import * as repo from "./repo";
import type { JournalLine } from "../lib/types";

const makeDb = (mode: "strict" | "standard") => {
  const raw = new Sqlite(":memory:");
  const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
  for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s);
  for (const [t, c, d] of COLUMN_MIGRATIONS) {
    const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
    if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  }
  for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
  raw.run("INSERT INTO settings (id, fiscal_year, e_book_mode, business_name) VALUES (1, 2026, ?, 'テスト')", [mode]);
  ACCOUNT_SEEDS.forEach((a, i) =>
    raw.run("INSERT INTO accounts (code, name, kana, category, normal_side, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [a.code, a.name, a.kana, a.category, a.normal_side, i]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (params?: unknown[]) => (params ?? []) as any[];
  const db = {
    select: async (sql: string, params?: unknown[]) => raw.query(sql).all(...p(params)),
    execute: async (sql: string, params?: unknown[]) => {
      const r = raw.query(sql).run(...p(params));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  } as unknown as Database;
  return { db, raw };
};

const pdf = (text: string) => new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), ...new TextEncoder().encode(text)]);
const meta = { doc_type: "請求書", txn_date: "2026-01-31", amount: 11000, counterparty: "株式会社A", memo: "" };

let strict: ReturnType<typeof makeDb>;
let lines: JournalLine[];
beforeEach(async () => {
  strict = makeDb("strict");
  const accts = await repo.getAccounts(strict.db, 2026);
  const id = (n: string) => accts.find((a) => a.name === n)!.id;
  lines = [
    { row_no: 1, side: "debit", account_id: id("外注工賃"), sub_account_id: null, amount: 11000, memo: "外注" },
    { row_no: 1, side: "credit", account_id: id("現金"), sub_account_id: null, amount: 11000, memo: "外注" },
  ];
});

describe("年度の締め（repo）", () => {
  test("締めた年度の仕訳は登録・訂正・削除できず、解除には理由が要る（厳密モード）", async () => {
    const { db } = strict;
    const entry = await repo.createEntry(db, "2025-12-01", lines);
    await repo.closeYear(db, 2025);
    await expect(repo.createEntry(db, "2025-12-02", lines)).rejects.toThrow(/2025年は締め済み/);
    await expect(repo.updateEntry(db, entry, "2025-12-03", lines)).rejects.toThrow(/締め済み/);
    await expect(repo.deleteEntry(db, entry)).rejects.toThrow(/締め済み/);
    // 開いている年度の仕訳を締め済みの年度へ動かすのも不可
    const e2 = await repo.createEntry(db, "2026-01-05", lines);
    await expect(repo.updateEntry(db, e2, "2025-12-31", lines)).rejects.toThrow(/締め済み/);
    expect((await repo.getEntry(db, e2))!.lines).toHaveLength(2); // 明細が消えていない
    await expect(repo.reopenYear(db, 2025, " ")).rejects.toThrow(/理由/);
    await repo.reopenYear(db, 2025, "計上漏れの追加");
    await repo.createEntry(db, "2025-12-02", lines);
    const hist = await repo.getMasterHistory(db);
    expect(hist.map((h) => h.action)).toEqual(["unlock", "close"]);
  });

  test("既存の帳簿は、繰越済みの年度だけ一度だけ自動で締める", async () => {
    const { db } = strict;
    await repo.createEntry(db, "2025-03-01", lines);
    await repo.saveOpening(db, 2026, { "1:0": 1000 });
    await repo.initClosings(db);
    expect((await repo.getClosings(db)).map((c) => c.fiscal_year)).toEqual([2025]);
    await repo.reopenYear(db, 2025, "確認");
    await repo.initClosings(db); // 2回目は何もしない
    expect(await repo.getClosings(db)).toEqual([]);
  });
});

describe("取引先（repo）", () => {
  test("仕訳に付けた取引先は履歴の写しに名前が残り、訂正で省けばそのまま", async () => {
    const { db } = strict;
    const cp = await repo.createCounterparty(db, { name: "株式会社A", kana: "えー", invoice_no: "ｔ1234567890123", memo: "" });
    expect((await repo.getCounterparties(db))[0].invoice_no).toBe("T1234567890123");
    const entry = await repo.createEntry(db, "2026-01-31", lines, cp);
    await repo.updateEntry(db, entry, "2026-02-01", lines, "日付の訂正");
    expect((await repo.getEntry(db, entry))!.counterparty_id).toBe(cp);
    const hist = await repo.getHistory(db, entry);
    expect(hist.map((h) => h.snapshot.counterparty)).toEqual(["株式会社A", "株式会社A"]);
    await repo.updateEntry(db, entry, "2026-02-01", lines, "取引先を外す", null);
    expect((await repo.getEntry(db, entry))!.counterparty_id).toBeNull();
  });

  test("証憑の取引先名が一覧と同じならつながる。使った取引先は削除できない", async () => {
    const { db } = strict;
    const cp = await repo.createCounterparty(db, { name: "株式会社A", kana: "", invoice_no: "", memo: "" });
    const id = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    expect((await repo.getEvidence(db, id))!.counterparty_id).toBe(cp);
    await expect(repo.deleteCounterparty(db, cp)).rejects.toThrow(/使われている/);
    const unused = await repo.createCounterparty(db, { name: "B商店", kana: "", invoice_no: "", memo: "" });
    await repo.deleteCounterparty(db, unused);
    const hist = await repo.getMasterHistory(db);
    expect(hist.filter((h) => h.target_type === "counterparty").map((h) => h.action)).toEqual(["delete", "create", "create"]);
  });
});

describe("証憑（repo）", () => {
  test("登録・訂正・ひも付け・無効が履歴に残り、無効の証憑は変更できない（厳密モード）", async () => {
    const { db } = strict;
    const entry = await repo.createEntry(db, "2026-01-31", lines);
    const id = await repo.createEvidence(db, meta, { name: "invoice.pdf", bytes: pdf("a") });
    await repo.linkEvidence(db, id, entry);
    await repo.updateEvidence(db, id, { ...meta, amount: 12000 }, "金額の入力ミス");
    expect((await repo.getEntryEvidences(db, entry)).map((e) => e.id)).toEqual([id]);
    await repo.voidEvidence(db, id, "二重登録");
    const e = (await repo.getEvidence(db, id))!;
    expect(e.is_void).toBe(1);
    expect((await repo.getEvidenceHistory(db, id)).map((h) => h.action)).toEqual(["void", "update", "link", "create"]);
    await expect(repo.updateEvidence(db, id, meta)).rejects.toThrow(/無効/);
    await expect(repo.linkEvidence(db, id, entry)).rejects.toThrow(/無効/);
    // 中身は残っている
    expect(new TextDecoder().decode(await repo.getEvidenceBytes(db, id))).toBe("%PDF-1.7\na");
  });

  test("対応外のファイル・必須項目の抜けは登録できない", async () => {
    const { db } = strict;
    await expect(repo.createEvidence(db, meta, { name: "a.sh", bytes: new TextEncoder().encode("hello") })).rejects.toThrow(/取り込めません/);
    await expect(repo.createEvidence(db, { ...meta, counterparty: "" }, { name: "a.pdf", bytes: pdf("a") })).rejects.toThrow(/取引先/);
    expect(await repo.getEvidences(db)).toEqual([]);
  });

  test("HEIC・CSV は受け取ったまま保存する（変換しない。ハッシュも元のファイルのもの）", async () => {
    const { db } = strict;
    const { sha256Hex } = await import("../lib/evidence");
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 1, 2, 3, 4]);
    const id = await repo.createEvidence(db, { ...meta, doc_type: "領収書" }, { name: "IMG_0001.HEIC", bytes: heic });
    const e = (await repo.getEvidence(db, id))!;
    expect(e.mime).toBe("image/heic");
    expect(await repo.getEvidenceBytes(db, id)).toEqual(heic);
    expect(e.sha256).toBe(await sha256Hex(heic));
    const csv = await repo.createEvidence(db, meta, { name: "明細.csv", bytes: new Uint8Array([0x8b, 0xe0, 0x8a, 0x7a, 0x0a]) });
    expect((await repo.getEvidence(db, csv))!.mime).toBe("text/csv");
  });

  test("改ざんの確認：中身とハッシュを直接書き換えても、登録時の履歴と食い違えば見つかる", async () => {
    const { db, raw } = strict;
    const id = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    expect((await repo.verifyEvidences(db))[0].status).toBe("ok");
    // トリガーを外して、ファイルとハッシュを両方すり替える（SQLite を直接いじられた想定）
    raw.run("DROP TRIGGER trg_evidence_files_no_update");
    raw.run("DROP TRIGGER trg_evidences_file_fixed");
    raw.run("UPDATE evidence_files SET data = ? WHERE evidence_id = ?", [Buffer.from(pdf("b")).toString("base64"), id]);
    expect((await repo.verifyEvidences(db))[0].detail).toMatch(/中身/);
    const { sha256Hex } = await import("../lib/evidence");
    raw.run("UPDATE evidences SET sha256 = ? WHERE id = ?", [await sha256Hex(pdf("b")), id]);
    expect((await repo.verifyEvidences(db))[0].detail).toMatch(/履歴/);
  });

  test("通常モード：削除は物理削除。仕訳を削除してもひも付けだけ外れる", async () => {
    const { db } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    const ls = lines.map((l) => ({ ...l, account_id: accts[l.account_id - 1]?.id ?? l.account_id }));
    const entry = await repo.createEntry(db, "2026-01-31", ls);
    const a = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const b = await repo.createEvidence(db, meta, { name: "b.pdf", bytes: pdf("b") });
    await repo.linkEvidence(db, a, entry);
    await repo.deleteEntry(db, entry);
    expect((await repo.getEvidence(db, a))!.entry_ids).toEqual([]);
    await repo.voidEvidence(db, b);
    expect(await repo.getEvidence(db, b)).toBeNull();
    expect(await repo.getEvidenceHistory(db)).toEqual([]);
  });
});

describe("改ざんの検知（repo）", () => {
  const setup = async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const e1 = await repo.createEntry(db, "2026-01-10", lines);
    const e2 = await repo.createEntry(db, "2026-01-20", lines);
    await repo.updateEntry(db, e2, "2026-01-21", lines, "日付の訂正");
    await repo.saveOpening(db, 2026, { "1:0": 5000, [`${(await repo.getAccounts(db, 2026)).find((a) => a.name === "元入金")!.id}:0`]: 5000 });
    const ev = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    await repo.linkEvidence(db, ev, e1);
    await repo.closeYear(db, 2025);
    await repo.reopenYear(db, 2025, "確認");
    return { db, raw, e1, e2, ev };
  };
  const errors = (r: repo.IntegrityReport) => r.issues.filter((i) => i.level === "error").map((i) => i.message);

  test("ソフトを通した操作だけなら、問題なし", async () => {
    const { db } = await setup();
    const r = await repo.verifyIntegrity(db, { files: true });
    expect(r.enabled).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.length).toBeGreaterThan(5);
  });

  test("仕訳の金額を直接書き換えると見つかる", async () => {
    const { db, raw, e1 } = await setup();
    raw.run("UPDATE journal_lines SET amount = 1 WHERE entry_id = ?", [e1]);
    expect(errors(await repo.verifyIntegrity(db))).toEqual([expect.stringMatching(new RegExp(`伝票 No.${e1}.*一致しません`))]);
  });

  test("仕訳を直接足すと見つかる", async () => {
    const { db, raw } = await setup();
    raw.run("INSERT INTO journal_entries (id, date) VALUES (99, '2026-03-01')");
    expect(errors(await repo.verifyIntegrity(db)).join()).toMatch(/伝票 No.99.*記録がありません/);
  });

  test("期首残高・証憑を直接書き換えると見つかる", async () => {
    const { db, raw, ev } = await setup();
    raw.run("UPDATE opening_balances SET amount = 9999 WHERE account_id = 1 AND fiscal_year = 2026");
    raw.run("UPDATE evidences SET amount = 1 WHERE id = ?", [ev]);
    const msgs = errors(await repo.verifyIntegrity(db)).join("\n");
    expect(msgs).toMatch(/2026年の期首残高/);
    expect(msgs).toMatch(new RegExp(`証憑 No.${ev}`));
  });

  test("履歴を書き換え・削除すると見つかる（トリガーを消されても）", async () => {
    const { db, raw } = await setup();
    raw.run("DROP TRIGGER trg_history_no_update");
    raw.run("DROP TRIGGER trg_history_no_delete");
    raw.run("UPDATE entry_history SET reason = '改ざん' WHERE id = 2");
    raw.run("DELETE FROM entry_history WHERE id = 1");
    const msgs = errors(await repo.verifyIntegrity(db)).join("\n");
    expect(msgs).toMatch(/仕訳の履歴 No.2 の内容が.*書き換えられています/);
    expect(msgs).toMatch(/仕訳の履歴 No.1 が消されています/);
  });

  test("連鎖の途中を消すと、つながりが切れて見つかる", async () => {
    const { db, raw } = await setup();
    raw.run("DROP TRIGGER trg_audit_chain_no_delete");
    raw.run("DELETE FROM audit_chain WHERE id = 3");
    expect(errors(await repo.verifyIntegrity(db)).join()).toMatch(/途切れています/);
  });

  test("連鎖をまるごと作り直されると中では見抜けないが、控えた確認コードで見つかる", async () => {
    const { db, raw, e1 } = await setup();
    const code = repo.anchorCode((await repo.getChainHead(db))!.row_hash);
    expect(await repo.findAnchor(db, code)).not.toBeNull();
    // 改ざんしたうえで、連鎖を一から計算し直す（同じソフトのコードを使えば誰でもできる）
    raw.run("UPDATE journal_lines SET amount = 1 WHERE entry_id = ?", [e1]);
    raw.run("DROP TRIGGER trg_audit_chain_no_delete");
    raw.run("DELETE FROM audit_chain");
    raw.run("UPDATE settings SET chain_initialized = 0");
    await repo.initChain(db);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]); // 中だけでは見抜けない
    expect(await repo.findAnchor(db, code)).toBeNull(); // 控えたコードが無くなっている
  });

  test("トリガーが消されていたら、開いたときに記録して知らせる", async () => {
    const { db, raw } = await setup();
    const names = () => (raw.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((x) => x.name);
    await repo.checkTriggers(db, names()); // 前回開いたときの一覧を控える
    raw.run("DROP TRIGGER trg_history_no_update");
    await repo.checkTriggers(db, names()); // 次に開いたとき
    const r = await repo.verifyIntegrity(db);
    expect(r.issues.filter((i) => i.level === "warn").map((i) => i.message).join()).toMatch(/trg_history_no_update/);
    expect(errors(r)).toEqual([]);
  });

  test("連鎖を始める前の履歴も取り込み、その時点を基準にする", async () => {
    const { db } = strict;
    await repo.createEntry(db, "2026-01-10", lines); // 連鎖を始める前
    await repo.initChain(db);
    await repo.createEntry(db, "2026-01-11", lines);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
  });
});

describe("トランザクションと中断の検知（repo）", () => {
  test("途中で失敗したら丸ごと取り消され、保存中の目印も残らない", async () => {
    const { db, raw } = strict;
    const bad = [...lines, { ...lines[0], row_no: 2, account_id: 99999 }]; // 存在しない科目（外部キーで失敗）
    raw.run("PRAGMA foreign_keys = ON");
    await expect(repo.createEntry(db, "2026-01-10", bad)).rejects.toThrow();
    expect(raw.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 0 });
    expect(raw.query("SELECT COUNT(*) AS n FROM journal_lines").get()).toEqual({ n: 0 });
    expect(raw.query("SELECT COUNT(*) AS n FROM pending_ops").get()).toEqual({ n: 0 });
  });

  test("保存中にソフトが止まった（目印が残った）ら、次に開いたときに知らせて記録する", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    raw.run("INSERT INTO pending_ops (label, started_at) VALUES ('伝票 No.12 の訂正', '2026-10-05 10:00:00')");
    const msgs = await repo.checkInterrupted(db);
    expect(msgs).toEqual(["2026-10-05 10:00:00　伝票 No.12 の訂正"]);
    expect(await repo.checkInterrupted(db)).toEqual([]); // 2回目は出ない
    const r = await repo.verifyIntegrity(db);
    expect(r.issues.map((i) => i.message).join()).toMatch(/保存が完了せず、取り消されました.*伝票 No.12/);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("書き込みは順番に1つずつ行われる（同時に呼んでも混ざらない）", async () => {
    const { db } = strict;
    const ids = await Promise.all([1, 2, 3, 4, 5].map((d) => repo.createEntry(db, `2026-01-0${d}`, lines)));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.getHistory(db)).length).toBe(5);
  });
});

describe("ユーザー（repo）", () => {
  test("最初のユーザーは自動で作る。パスワードは任意で、ハッシュで保存する", async () => {
    const { db, raw } = strict;
    await repo.ensureUsers(db, "山田");
    await repo.ensureUsers(db, "山田"); // 2回目は何もしない
    const [yamada] = await repo.getUsers(db);
    expect(yamada).toMatchObject({ name: "山田", has_password: 0, is_active: 1 });
    expect(await repo.checkLogin(db, yamada.id, "")).toBe(true);

    const suzuki = await repo.createUser(db, "鈴木", "secret1");
    const stored = (raw.query("SELECT password_hash FROM users WHERE id = ?").get(suzuki) as { password_hash: string }).password_hash;
    expect(stored).toMatch(/^pbkdf2-sha256\$/);
    expect(stored).not.toContain("secret1");
    expect(await repo.checkLogin(db, suzuki, "secret1")).toBe(true);
    expect(await repo.checkLogin(db, suzuki, "wrong")).toBe(false);
    await expect(repo.createUser(db, "鈴木")).rejects.toThrow(/同じ名前/);
  });

  test("パスワードを変えるには今のパスワードが要る", async () => {
    const { db } = strict;
    const id = await repo.createUser(db, "鈴木", "secret1");
    await expect(repo.setUserPassword(db, id, "wrong", "newpass")).rejects.toThrow(/今のパスワード/);
    await repo.setUserPassword(db, id, "secret1", "newpass");
    expect(await repo.checkLogin(db, id, "newpass")).toBe(true);
    await repo.setUserPassword(db, id, "newpass", ""); // 解除
    expect(await repo.checkLogin(db, id, "")).toBe(true);
  });

  test("誰が操作したかが、履歴・仕訳・証憑・利用の記録に残る", async () => {
    const { db } = strict;
    await repo.initChain(db);
    const a = await repo.createUser(db, "山田");
    const b = await repo.createUser(db, "鈴木");
    repo.setActor(a);
    await repo.logAccess(db, a, "login");
    const entry = await repo.createEntry(db, "2026-01-10", lines);
    repo.setActor(b);
    await repo.updateEntry(db, entry, "2026-01-11", lines, "訂正");
    const ev = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const e = (await repo.getEntry(db, entry))!;
    expect([e.created_by_name, e.updated_by_name]).toEqual(["山田", "鈴木"]);
    expect((await repo.getHistory(db, entry)).map((h) => h.user_name)).toEqual(["鈴木", "山田"]);
    expect((await repo.getEvidenceHistory(db, ev))[0].user_name).toBe("鈴木");
    expect((await repo.getAccessLog(db)).map((x) => [x.user_name, x.action])).toEqual([["山田", "login"]]);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]); // 利用の記録も連鎖に入っている
    repo.setActor(null);
  });

  test("使えるユーザーを0人にはできない", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const [u] = await repo.getUsers(db);
    await expect(repo.setUserActive(db, u.id, false)).rejects.toThrow(/1人もいなく/);
  });
});
