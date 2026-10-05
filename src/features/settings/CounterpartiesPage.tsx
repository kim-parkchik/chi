/**
 * 取引先の管理（任意で使う）
 *  - 仕訳1件に1つ、証憑にも付けられる。補助科目とは別（同じ相手が複数の科目に出てくるため）
 *  - 適格請求書発行事業者の登録番号（T + 13桁）を持てる
 *  - 使った取引先は削除できない（非表示にはできる）。厳密モードでは変更を履歴に残す
 */
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { normName, validateCounterparty, type CounterpartyInput } from "../../lib/counterparty";
import type { Counterparty } from "../../lib/types";
import * as repo from "../../db/repo";

export const CounterpartiesPage = () => {
  const { db, counterparties, reloadCounterparties, strict, dataVersion } = useAppContext();
  const toast = useToast();
  const [editing, setEditing] = useState<Counterparty | "new" | null>(null);
  const [q, setQ] = useState("");
  const [usage, setUsage] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    Promise.all(counterparties.map(async (c) => [c.id, await repo.counterpartyUsage(db, c.id)] as const))
      .then((xs) => setUsage(new Map(xs)))
      .catch(console.error);
  }, [db, counterparties, dataVersion]);

  const shown = useMemo(() => {
    const n = normName(q);
    return n ? counterparties.filter((c) => normName(`${c.name}${c.kana}${c.invoice_no}`).includes(n)) : counterparties;
  }, [counterparties, q]);

  const toggle = async (c: Counterparty, active: boolean) => {
    await repo.setCounterpartyActive(db, c.id, active);
    await reloadCounterparties();
  };

  const remove = async (c: Counterparty) => {
    if (!(await ask(`「${c.name}」を削除します。`, { title: "取引先の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    try {
      await repo.deleteCounterparty(db, c.id);
      await reloadCounterparties();
      toast("取引先を削除しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="取引先"
        note={`使うかどうかは任意です。仕訳（振替伝票・仕訳の訂正）と証憑に付けると、取引先で検索できます。チェックを外した取引先は入力候補に出なくなります。${strict ? "変更はすべて履歴に記録されます。" : ""}`}
      >
        <button className="btn primary" onClick={() => setEditing("new")}><Plus size={16} /> 取引先を追加</button>
      </PageHeader>

      <div className="filters">
        <label className="search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前・よみ・登録番号で探す" />
        </label>
        <span className="filter-count">{counterparties.length} 件</span>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {shown.length === 0 ? (
            <p className="empty-note">{counterparties.length === 0 ? "まだ取引先がありません。" : "条件に合う取引先がありません。"}</p>
          ) : (
            <table className="ledger">
              <colgroup>
                <col style={{ width: 56 }} /><col /><col style={{ width: "18%" }} /><col style={{ width: 160 }} />
                <col style={{ width: "20%" }} /><col style={{ width: 70 }} /><col style={{ width: 150 }} />
              </colgroup>
              <thead>
                <tr><th>使う</th><th>取引先名</th><th>よみ</th><th>登録番号</th><th>メモ</th><th className="num">使用</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className={c.is_active ? "" : "inactive"}>
                    <td><input type="checkbox" checked={!!c.is_active} onChange={(e) => toggle(c, e.target.checked)} aria-label={`${c.name}を使う`} /></td>
                    <td>{c.name}</td>
                    <td className="muted">{c.kana}</td>
                    <td className="mono">{c.invoice_no}</td>
                    <td className="muted ellipsis" title={c.memo}>{c.memo}</td>
                    <td className="num muted">{usage.get(c.id) ?? ""}</td>
                    <td className="row-actions">
                      <button className="link-btn" onClick={() => setEditing(c)}><Pencil size={14} /> 編集</button>
                      {!usage.get(c.id) && <button className="link-btn danger" onClick={() => remove(c)}><Trash2 size={14} /> 削除</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editing && <CounterpartyForm target={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};

const CounterpartyForm = ({ target, onClose }: { target: Counterparty | "new"; onClose: () => void }) => {
  const { db, counterparties, reloadCounterparties } = useAppContext();
  const toast = useToast();
  const isNew = target === "new";
  const [d, setD] = useState<CounterpartyInput>(
    isNew ? { name: "", kana: "", invoice_no: "", memo: "" } : { name: target.name, kana: target.kana, invoice_no: target.invoice_no, memo: target.memo },
  );
  const [error, setError] = useState("");
  const set = <K extends keyof CounterpartyInput>(k: K, v: string) => setD((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    const err = validateCounterparty(counterparties, d, isNew ? undefined : target.id);
    if (err) return setError(err);
    try {
      if (isNew) await repo.createCounterparty(db, d);
      else await repo.updateCounterparty(db, target.id, d);
      await reloadCounterparties();
      toast(isNew ? "取引先を追加しました" : "取引先を更新しました");
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };

  return (
    <Modal title={isNew ? "取引先の追加" : "取引先の編集"} onClose={onClose} width={560}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field-row">
          <label className="field">
            <span>取引先名</span>
            <input className="input" value={d.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={60} placeholder="例：株式会社〇〇" />
          </label>
          <label className="field">
            <span>よみ（任意）</span>
            <input className="input" value={d.kana} onChange={(e) => set("kana", e.target.value)} maxLength={60} placeholder="例：まるまる" />
          </label>
        </div>
        <label className="field">
          <span>適格請求書発行事業者の登録番号（任意）</span>
          <input className="input mono" value={d.invoice_no} onChange={(e) => set("invoice_no", e.target.value)} placeholder="T1234567890123" maxLength={20} />
        </label>
        <label className="field">
          <span>メモ（任意）</span>
          <input className="input" value={d.memo} onChange={(e) => set("memo", e.target.value)} maxLength={200} />
        </label>
        {!isNew && <p className="field-note">名前を変えると、過去の仕訳の表示も新しい名前になります（履歴の写しには記録した時点の名前が残ります）。</p>}
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit">{isNew ? "追加する" : "保存する"}</button>
        </div>
      </form>
    </Modal>
  );
};
