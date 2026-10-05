import { describe, expect, test } from "bun:test";
import type { Counterparty } from "./types";
import { findCounterparty, normalizeInvoiceNo, validateCounterparty } from "./counterparty";

const list: Counterparty[] = [
  { id: 1, name: "株式会社ABC", kana: "えーびーしー", invoice_no: "T1234567890123", memo: "", is_active: 1 },
];
const d = { name: "山田文具", kana: "", invoice_no: "", memo: "" };

describe("取引先", () => {
  test("登録番号は T + 13桁。全角やハイフンはそろえる", () => {
    expect(normalizeInvoiceNo("ｔ１２３４-５６７８-９０１２-３")).toBe("T1234567890123");
    expect(validateCounterparty(list, { ...d, invoice_no: "T123" })).toMatch(/13桁/);
    expect(validateCounterparty(list, { ...d, invoice_no: "1234567890123" })).toMatch(/13桁/);
    expect(validateCounterparty(list, { ...d, invoice_no: "T9999999999999" })).toBeNull();
    expect(validateCounterparty(list, d)).toBeNull(); // 登録番号は任意
  });
  test("名前・登録番号の重複は不可（表記ゆれも同じとみなす）", () => {
    expect(validateCounterparty(list, { ...d, name: "株式会社ＡＢＣ" })).toMatch(/同じ名前/);
    expect(validateCounterparty(list, { ...d, invoice_no: "T1234567890123" })).toMatch(/同じ登録番号/);
    expect(validateCounterparty(list, { ...d, name: "株式会社ABC" }, 1)).toBeNull(); // 自分自身はよい
  });
  test("名前から探す", () => {
    expect(findCounterparty(list, " 株式会社ａｂｃ ")?.id).toBe(1);
    expect(findCounterparty(list, "ABC")).toBeNull();
    expect(findCounterparty(list, "")).toBeNull();
  });
});
