/**
 * 振替伝票（複合仕訳も入力できる汎用フォーム）
 * 新規入力ページと、各帳簿からの修正モーダルの両方で使います。
 */
import { useState, type KeyboardEvent } from "react";
import { Plus, Trash2, Save, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { AccountWithSub, AmountInput, DateInput, MemoInput, TaxSelect } from "../../components/Inputs";
import { checkVoucher, emptyRow, rowsToLines } from "../../lib/accounting";
import { enterToNext, isComposing } from "../../lib/keyboard";
import { yen } from "../../lib/format";
import type { VoucherRow } from "../../lib/types";
import * as repo from "../../db/repo";
import { useToast } from "../../components/Toast";

interface Props {
  entryId?: number;
  initialDate: string;
  initialRows?: VoucherRow[];
  onSaved?: (date: string) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}

const MIN_ROWS = 4;
const padRows = (rows: VoucherRow[]) => {
  const out = [...rows];
  while (out.length < MIN_ROWS) out.push(emptyRow());
  return out;
};

export const VoucherForm = ({ entryId, initialDate, initialRows, onSaved, onDeleted, onCancel }: Props) => {
  const { db, year, bump, strict } = useAppContext();
  const toast = useToast();
  const [date, setDate] = useState(initialDate);
  const [rows, setRows] = useState<VoucherRow[]>(padRows(initialRows ?? []));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");

  const check = checkVoucher(rows);
  const diff = check.debitTotal - check.creditTotal;

  const update = (i: number, patch: Partial<VoucherRow>) =>
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r));
      // 科目を変えたら補助科目は選び直し
      if ("debitAccountId" in patch && patch.debitAccountId !== rs[i].debitAccountId) next[i].debitSubId = null;
      if ("creditAccountId" in patch && patch.creditAccountId !== rs[i].creditAccountId) next[i].creditSubId = null;
      // 1行だけの仕訳のときは、借方金額を貸方にも写す（貸方が空 or 同額だった場合）
      if ("debitAmount" in patch) {
        const before = rs[i];
        const othersEmpty = rs.every((r, j) => j === i || (!r.debitAccountId && !r.debitAmount && !r.creditAccountId && !r.creditAmount));
        if (othersEmpty && (before.creditAmount == null || before.creditAmount === before.debitAmount)) {
          next[i].creditAmount = patch.debitAmount ?? null;
        }
      }
      // 最終行に入力が始まったら1行足す
      const last = next[next.length - 1];
      if (last.debitAccountId || last.creditAccountId || last.debitAmount || last.creditAmount) next.push(emptyRow());
      return next;
    });

  const removeRow = (i: number) => setRows((rs) => padRows(rs.filter((_, j) => j !== i)));

  const submit = async () => {
    const c = checkVoucher(rows);
    if (c.errors.length) {
      setErrors(c.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const lines = rowsToLines(rows);
      if (entryId) await repo.updateEntry(db, entryId, date, lines, reason);
      else await repo.createEntry(db, date, lines);
      bump();
      toast(entryId ? "仕訳を更新しました" : "仕訳を登録しました");
      if (!entryId) setRows(padRows([]));
      onSaved?.(date);
    } catch (e) {
      console.error(e);
      toast(`保存できませんでした：${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!entryId) return;
    const ok = await ask(
      strict
        ? "この仕訳を削除します。帳簿や集計からは外れますが、削除した事実と内容は「訂正・削除履歴」に残ります。"
        : "この仕訳を削除します。元に戻せません。",
      { title: "仕訳の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" },
    );
    if (!ok) return;
    await repo.deleteEntry(db, entryId, reason);
    bump();
    toast("仕訳を削除しました");
    onDeleted?.();
  };

  // ⌘/Ctrl + Enter でどこからでも登録
  const onFormKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isComposing(e)) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      setTimeout(submit, 0);
    }
  };
  const nav = enterToNext(submit);

  return (
    <div className="voucher" data-navgroup onKeyDown={onFormKey}>
      <div className="voucher-top">
        <label className="field-inline">
          <span>日付</span>
          <DateInput value={date} onChange={setDate} year={year} onKeyDown={nav} autoFocus={!entryId} aria-label="日付" />
        </label>
        <span className="voucher-year">{year}年</span>
        {entryId && <span className="voucher-no">伝票 No.{entryId}</span>}
      </div>

      <div className="table-wrap">
        <table className="ledger voucher-table">
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: 84 }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: 84 }} />
            <col />
            <col style={{ width: 40 }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th className="dr">借方科目</th>
              <th className="dr num">借方金額</th>
              <th className="tax-th">税区分</th>
              <th className="cr">貸方科目</th>
              <th className="cr num">貸方金額</th>
              <th className="tax-th">税区分</th>
              <th>摘要</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="row-no">{i + 1}</td>
                <td><AccountWithSub accountId={r.debitAccountId} subId={r.debitSubId} onAccount={(v) => update(i, { debitAccountId: v })} onSub={(v) => update(i, { debitSubId: v })} onKeyDown={nav} label={`${i + 1}行目 借方科目`} /></td>
                <td><AmountInput value={r.debitAmount} onChange={(v) => update(i, { debitAmount: v })} onKeyDown={nav} aria-label={`${i + 1}行目 借方金額`} /></td>
                <td><TaxSelect label={`${i + 1}行目 借方税区分`} /></td>
                <td><AccountWithSub accountId={r.creditAccountId} subId={r.creditSubId} onAccount={(v) => update(i, { creditAccountId: v })} onSub={(v) => update(i, { creditSubId: v })} onKeyDown={nav} label={`${i + 1}行目 貸方科目`} /></td>
                <td><AmountInput value={r.creditAmount} onChange={(v) => update(i, { creditAmount: v })} onKeyDown={nav} aria-label={`${i + 1}行目 貸方金額`} /></td>
                <td><TaxSelect label={`${i + 1}行目 貸方税区分`} /></td>
                <td><MemoInput value={r.memo} onChange={(v) => update(i, { memo: v })} onKeyDown={nav} aria-label={`${i + 1}行目 摘要`} /></td>
                <td>
                  <button className="icon-btn subtle" tabIndex={-1} onClick={() => removeRow(i)} aria-label={`${i + 1}行目を消す`}>
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="total-label">借方合計</td>
              <td className="num">{yen(check.debitTotal)}</td>
              <td />
              <td className="total-label">貸方合計</td>
              <td className="num">{yen(check.creditTotal)}</td>
              <td />
              <td className={diff === 0 ? "balance-ok" : "balance-ng"}>
                {diff === 0 ? (check.debitTotal > 0 ? "貸借一致" : "") : `差額 ${yen(Math.abs(diff))}`}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {entryId && strict && (
        <label className="reason-field">
          <span>訂正・削除の理由（任意・履歴に残ります）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：金額の入力誤り" maxLength={100} />
        </label>
      )}

      {errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="voucher-actions">
        <button className="btn ghost" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
          <Plus size={16} /> 行を追加
        </button>
        <div className="spacer" />
        {entryId && (
          <button className="btn danger-ghost" onClick={remove}>
            <Trash2 size={16} /> 削除
          </button>
        )}
        {onCancel && <button className="btn ghost" onClick={onCancel}>閉じる</button>}
        <button className="btn primary" onClick={submit} disabled={saving}>
          <Save size={16} /> {entryId ? "更新する" : "登録する"}
          <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  );
};
