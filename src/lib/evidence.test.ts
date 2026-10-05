import { describe, expect, test } from "bun:test";
import type { Evidence } from "./types";
import {
  decodeText, detectFileType, exportFileName, filterEvidences, fromBase64, rankCandidates, sha256Hex, toBase64, validateEvidenceFile, validateEvidenceMeta,
} from "./evidence";
import { MAX_EVIDENCE_BYTES } from "../constants/appConfig";

const ev = (id: number, txn_date: string, amount: number, counterparty: string, extra: Partial<Evidence> = {}): Evidence => ({
  id, counterparty_id: null, kind: "electronic", doc_type: "請求書", txn_date, amount, counterparty, memo: "", file_name: "a.pdf", mime: "application/pdf",
  size: 1, sha256: "", revision: 1, is_void: 0, created_at: "", updated_at: "", voided_at: null, entry_ids: [], ...extra,
});

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe("証憑ファイル", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const cat = (...parts: (number[] | Uint8Array)[]) => new Uint8Array(parts.flatMap((p) => [...p]));
  const mime = (b: Uint8Array, name = "") => detectFileType(b, name)?.mime ?? null;

  test("PDF・画像は中身で判定する（拡張子が違っていても中身を優先）", () => {
    expect(mime(pdf, "請求書.png")).toBe("application/pdf");
    expect(mime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(mime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(mime(enc("GIF89a....."))).toBe("image/gif");
    expect(mime(cat(enc("RIFF"), [0, 0, 0, 0], enc("WEBPVP8 ")))).toBe("image/webp");
    expect(mime(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2]))).toBe("image/tiff");
  });
  test("iPhone の写真（HEIC）", () => {
    expect(mime(cat([0, 0, 0, 0x18], enc("ftypheic"), [0, 0, 0, 0]), "IMG_0001.HEIC")).toBe("image/heic");
    expect(mime(cat([0, 0, 0, 0x18], enc("ftypmif1"), [0, 0, 0, 0]))).toBe("image/heif");
    expect(mime(cat([0, 0, 0, 0x18], enc("ftypisom"), [0, 0, 0, 0]), "movie.mp4")).toBeNull(); // 動画は受け付けない
  });
  test("Excel・Word は ZIP の中身で見分ける。旧形式は拡張子で", () => {
    const zip = (inner: string) => cat([0x50, 0x4b, 0x03, 0x04], enc(`....${inner}....`));
    expect(mime(zip("xl/workbook.xml"), "a.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mime(zip("word/document.xml"))).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mime(zip("foo.txt"))).toBe("application/zip");
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(mime(ole, "請求書.XLS")).toBe("application/vnd.ms-excel");
    expect(mime(ole, "a.bin")).toBeNull();
  });
  test("XML・CSV・テキスト。何か分からない文字のファイルは受け付けない", () => {
    expect(mime(enc("\uFEFF<?xml version=\"1.0\"?><Invoice/>"), "invoice")).toBe("application/xml");
    expect(mime(enc("日付,金額\n2026/01/31,11000"), "明細.csv")).toBe("text/csv");
    expect(mime(enc("memo"), "a.txt")).toBe("text/plain");
    expect(mime(enc("#!/bin/sh\nrm -rf"), "run.sh")).toBeNull();
    expect(mime(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "setup.exe")).toBeNull();
  });
  test("空・大きすぎ・対応外は取り込めない", () => {
    expect(validateEvidenceFile(new Uint8Array())).toMatch(/空/);
    const big = new Uint8Array(MAX_EVIDENCE_BYTES + 1);
    big.set(pdf);
    expect(validateEvidenceFile(big)).toMatch(/大きすぎ/);
    expect(validateEvidenceFile(enc("hello"), "a.sh")).toMatch(/取り込めません/);
    expect(validateEvidenceFile(pdf)).toBeNull();
  });
  test("CSV の表示用の読み込み：UTF-8 で読めなければ Shift_JIS", () => {
    expect(decodeText(enc("\uFEFF金額"))).toBe("金額");
    expect(decodeText(new Uint8Array([0x8b, 0xe0, 0x8a, 0x7a]))).toBe("金額"); // Shift_JIS の「金額」
  });
  test("SHA-256（既知の値）", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("base64 の往復（大きめのデータでも崩れない）", () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });
});

describe("証憑の項目", () => {
  const ok = { doc_type: "請求書", txn_date: "2026-02-28", amount: 11000, counterparty: "株式会社A", memo: "" };
  test("取引年月日・取引金額・取引先は必須", () => {
    expect(validateEvidenceMeta(ok)).toBeNull();
    expect(validateEvidenceMeta({ ...ok, txn_date: "2026-02-30" })).toMatch(/取引年月日/);
    expect(validateEvidenceMeta({ ...ok, amount: -1 })).toMatch(/取引金額/);
    expect(validateEvidenceMeta({ ...ok, counterparty: " " })).toMatch(/取引先/);
  });
});

describe("証憑の検索", () => {
  const list = [
    ev(1, "2026-01-10", 11000, "株式会社ＡＢＣ"),
    ev(2, "2026-01-20", 5500, "ABC商店", { entry_ids: [3] }),
    ev(3, "2026-02-05", 11000, "山田文具"),
    ev(4, "2026-02-06", 11000, "株式会社ABC", { is_void: 1 }),
  ];
  test("日付の範囲・金額の範囲・取引先を組み合わせる", () => {
    const r = filterEvidences(list, { dateFrom: "2026-01-01", dateTo: "2026-01-31", amountMin: 10000, counterparty: "abc" });
    expect(r.map((e) => e.id)).toEqual([1]);
  });
  test("取引先は全角半角を区別しない。無効は既定で除く", () => {
    expect(filterEvidences(list, { counterparty: "ABC" }).map((e) => e.id)).toEqual([1, 2]);
    expect(filterEvidences(list, { counterparty: "ABC", includeVoid: true }).map((e) => e.id)).toEqual([1, 2, 4]);
  });
  test("ひも付いていないものだけ", () => {
    expect(filterEvidences(list, { unlinkedOnly: true }).map((e) => e.id)).toEqual([1, 3]);
  });
  test("ひも付けの候補は、金額が同じ → 日付が近い順", () => {
    expect(rankCandidates(list, "2026-02-01", 11000).map((e) => e.id)).toEqual([3, 1, 2]);
  });
  test("書き出すファイル名", () => {
    expect(exportFileName(ev(12, "2026-01-10", 11000, "株式会社 A/B"))).toBe("20260110_株式会社_A_B_11000円_No12.pdf");
  });
});
