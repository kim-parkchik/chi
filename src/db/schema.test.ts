/**
 * DB のトリガーの確認（bun:sqlite のメモリ上の DB で、アプリと同じ定義を流す）
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./schema";

let db: Database;
const isTrigger = (sql: string) => sql.trimStart().startsWith("CREATE TRIGGER");

beforeEach(() => {
  db = new Database(":memory:");
  for (const sql of SCHEMA.filter((x) => !isTrigger(x))) db.run(sql);
  for (const sql of SCHEMA.filter(isTrigger)) db.run(sql);
  db.run("INSERT INTO settings (id, fiscal_year, e_book_mode) VALUES (1, 2026, 'strict')");
  db.run("INSERT INTO accounts (id, code, name, category, normal_side) VALUES (1, '101', '現金', 'asset', 'debit'), (2, '401', '売上高', 'revenue', 'credit')");
  // 2025年の仕訳を1本入れてから、2025年を締める
  db.run("INSERT INTO journal_entries (id, date) VALUES (1, '2025-06-01')");
  db.run("INSERT INTO journal_lines (entry_id, row_no, side, account_id, amount) VALUES (1, 1, 'debit', 1, 1000), (1, 1, 'credit', 2, 1000)");
  db.run("INSERT INTO opening_balances (fiscal_year, account_id, amount) VALUES (2025, 1, 500), (2026, 1, 1500)");
  db.run("INSERT INTO fiscal_closings (fiscal_year, period_start, period_end) VALUES (2025, '2025-01-01', '2025-12-31')");
});

const CLOSED = /締め済みの年度は変更できません/;

describe("締め済みの年度", () => {
  test("仕訳の登録・訂正・削除を拒否する", () => {
    expect(() => db.run("INSERT INTO journal_entries (date) VALUES ('2025-12-31')")).toThrow(CLOSED);
    expect(() => db.run("UPDATE journal_entries SET description = 'x' WHERE id = 1")).toThrow(CLOSED);
    expect(() => db.run("UPDATE journal_entries SET is_deleted = 1 WHERE id = 1")).toThrow(CLOSED);
    expect(() => db.run("DELETE FROM journal_entries WHERE id = 1")).toThrow(CLOSED);
    expect(() => db.run("DELETE FROM journal_lines WHERE entry_id = 1")).toThrow(CLOSED);
    expect(() => db.run("UPDATE journal_lines SET amount = 2000 WHERE entry_id = 1")).toThrow(CLOSED);
    expect(() => db.run("INSERT INTO journal_lines (entry_id, row_no, side, account_id, amount) VALUES (1, 2, 'debit', 1, 1)")).toThrow(CLOSED);
  });

  test("開いている年度の仕訳を、締め済みの年度へ動かすのも拒否する", () => {
    db.run("INSERT INTO journal_entries (id, date) VALUES (2, '2026-01-10')");
    expect(() => db.run("UPDATE journal_entries SET date = '2025-12-31' WHERE id = 2")).toThrow(CLOSED);
    db.run("UPDATE journal_entries SET description = 'ok' WHERE id = 2");
  });

  test("期首残高・家事按分・年度ごとの科目名を拒否する", () => {
    expect(() => db.run("UPDATE opening_balances SET amount = 1 WHERE fiscal_year = 2025")).toThrow(CLOSED);
    expect(() => db.run("DELETE FROM opening_balances WHERE fiscal_year = 2025")).toThrow(CLOSED);
    expect(() => db.run("INSERT INTO home_use_rates (account_id, from_year, rate, method) VALUES (1, 2025, 50, 'entry')")).toThrow(CLOSED);
    expect(() => db.run("INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('account', 1, 2025, '手元現金')")).toThrow(CLOSED);
    // 翌年度は変更できる（繰越のやり直し）
    db.run("DELETE FROM opening_balances WHERE fiscal_year = 2026");
    db.run("INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('account', 1, 2026, '手元現金')");
  });

  test("締めを解除すれば変更できる", () => {
    db.run("DELETE FROM fiscal_closings WHERE fiscal_year = 2025");
    db.run("UPDATE journal_lines SET amount = 2000 WHERE entry_id = 1");
    db.run("UPDATE opening_balances SET amount = 1 WHERE fiscal_year = 2025");
  });
});

describe("証憑", () => {
  const addEvidence = (id: number) => {
    db.run(`INSERT INTO evidences (id, txn_date, amount, counterparty, file_name, mime, size, sha256)
            VALUES (${id}, '2026-02-01', 1000, 'A', 'a.pdf', 'application/pdf', 3, 'h')`);
    db.run(`INSERT INTO evidence_files (evidence_id, data) VALUES (${id}, 'YWJj')`);
  };

  test("ファイルの中身・名前・ハッシュは変えられない（どちらのモードでも）", () => {
    addEvidence(1);
    expect(() => db.run("UPDATE evidence_files SET data = 'eHl6' WHERE evidence_id = 1")).toThrow(/変更できません/);
    expect(() => db.run("UPDATE evidences SET sha256 = 'x' WHERE id = 1")).toThrow(/変更できません/);
    expect(() => db.run("UPDATE evidences SET file_name = 'b.pdf' WHERE id = 1")).toThrow(/変更できません/);
    db.run("UPDATE evidences SET amount = 2000 WHERE id = 1"); // 項目の訂正はできる
  });

  test("履歴のある証憑は削除できない。履歴が無ければ（通常モード）削除できる", () => {
    addEvidence(1);
    addEvidence(2);
    db.run("INSERT INTO evidence_history (evidence_id, revision, action, snapshot) VALUES (1, 1, 'create', '{}')");
    expect(() => db.run("DELETE FROM evidence_files WHERE evidence_id = 1")).toThrow(/削除できません/);
    expect(() => db.run("DELETE FROM evidences WHERE id = 1")).toThrow(/削除できません/);
    expect(() => db.run("UPDATE evidence_history SET reason = 'x'")).toThrow(/変更できません/);
    db.run("DELETE FROM evidence_files WHERE evidence_id = 2");
    db.run("DELETE FROM evidences WHERE id = 2");
  });

  test("無効にした証憑は変更できない", () => {
    addEvidence(1);
    db.run("UPDATE evidences SET is_void = 1 WHERE id = 1");
    expect(() => db.run("UPDATE evidences SET is_void = 0 WHERE id = 1")).toThrow(/無効/);
  });
});
