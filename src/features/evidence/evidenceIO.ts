/**
 * 証憑ファイルの書き出し（1件ずつ／まとめて）
 * まとめて書き出すときは、一覧の CSV も一緒に置く（税務調査での「ダウンロードの求め」への対応を想定）
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import type Database from "../../db/connection";
import type { Counterparty, Evidence } from "../../lib/types";
import { exportFileName } from "../../lib/evidence";
import { EVIDENCE_KIND_LABEL } from "../../constants/evidence";
import * as repo from "../../db/repo";

const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;

/** 証憑の一覧 CSV（Excel で開けるよう BOM つき） */
export const evidenceCsv = (list: Evidence[], counterparties: Counterparty[] = []) => {
  const inv = new Map(counterparties.map((c) => [c.id, c.invoice_no]));
  const header = ["証憑No", "区分", "書類", "取引年月日", "取引金額", "取引先", "登録番号", "メモ", "ファイル名", "書き出し名", "SHA-256", "伝票No", "状態", "登録日時", "更新日時"];
  const body = list.map((e) =>
    [e.id, EVIDENCE_KIND_LABEL[e.kind], e.doc_type, e.txn_date, e.amount, e.counterparty, e.counterparty_id ? inv.get(e.counterparty_id) ?? "" : "", e.memo, e.file_name, exportFileName(e), e.sha256,
      e.entry_ids.join(" "), e.is_void ? "無効" : "", e.created_at, e.updated_at].map(esc).join(","),
  );
  return "﻿" + [header.map(esc).join(","), ...body].join("\r\n");
};

/** 1件を保存先を選んで書き出す。書き出したら true */
export const exportOne = async (db: Database, e: Evidence) => {
  const ext = exportFileName(e).split(".").pop()!;
  const path = await save({ defaultPath: exportFileName(e), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!path) return false;
  await writeFile(path, await repo.getEvidenceBytes(db, e.id));
  return true;
};

/** まとめてフォルダへ書き出す（ファイル + 一覧.csv）。書き出した件数（やめたら null） */
export const exportAll = async (db: Database, list: Evidence[], counterparties: Counterparty[] = []) => {
  const dir = await open({ directory: true, multiple: false, title: "書き出し先のフォルダを選ぶ" });
  if (typeof dir !== "string") return null;
  for (const e of list) await writeFile(await join(dir, exportFileName(e)), await repo.getEvidenceBytes(db, e.id));
  await writeTextFile(await join(dir, "証憑一覧.csv"), evidenceCsv(list, counterparties));
  return list.length;
};
