/**
 * 勘定科目・補助科目の管理
 *  - 科目は区分ごとのコード範囲（例：経費は 600〜699）で追加できる
 *  - 初期科目は削除・区分変更できない（決算書の並びと集計が崩れるため）。名前は変えられる
 *  - 追加した科目でも、仕訳や期首残高で使ったものは削除できない（非表示にはできる）
 *  - 補助科目は1科目あたり上限あり
 */
import { Fragment, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, ListTree, Lock } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { CATEGORY_CODE_RANGE, CATEGORY_LABEL, LOCKED_CODES } from "../../constants/accounts";
import { MAX_SUB_ACCOUNTS_PER_ACCOUNT } from "../../constants/appConfig";
import type { Account, AccountCategory } from "../../lib/types";
import * as repo from "../../db/repo";

const CATEGORIES = Object.keys(CATEGORY_LABEL) as AccountCategory[];

export const AccountsPage = () => {
  const { db, accounts, subAccounts, reloadAccounts, strict, year, dataVersion } = useAppContext();
  const toast = useToast();
  // 厳密モードでは、より新しい年度がある状態で過去の年度の名前は変えられない（年度単位で管理）
  const [latestYear, setLatestYear] = useState(year);
  useEffect(() => {
    repo.getYears(db, year).then((ys) => setLatestYear(Math.max(...ys))).catch(console.error);
  }, [db, year, dataVersion]);
  const renameLocked = strict && year < latestYear;
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [subsFor, setSubsFor] = useState<Account | null>(null);
  const [cat, setCat] = useState<AccountCategory | "all">("all");

  const toggle = async (a: Account, active: boolean) => {
    await repo.setAccountActive(db, a.id, active);
    await reloadAccounts();
  };

  const remove = async (a: Account) => {
    if ((await repo.accountUsage(db, a.id)) > 0) {
      toast("この科目は仕訳か期首残高で使われているので削除できません。使わない場合は「使う」のチェックを外してください。", "error");
      return;
    }
    if (!(await ask(`「${a.name}」を削除します。`, { title: "科目の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    await repo.deleteAccount(db, a.id);
    await reloadAccounts();
    toast("科目を削除しました");
  };

  const shownCats = cat === "all" ? CATEGORIES : [cat];

  return (
    <div className="page">
      <PageHeader
        title="勘定科目"
        note={
          strict
            ? `チェックを外した科目は入力候補に出なくなります。名前を変えると ${year}年から新しい名前になり、それより前の年度は元の名前のまま残ります。変更はすべて履歴に記録されます。`
            : "チェックを外した科目は入力候補に出なくなります（過去の仕訳と集計には残ります）。名前の変更はすべての年度に反映されます。"
        }
      >
        <button className="btn primary" onClick={() => setEditing("new")}><Plus size={16} /> 科目を追加</button>
      </PageHeader>

      {renameLocked && (
        <p className="warn-box">
          {year}年より新しい年度（{latestYear}年）があるため、この年度では科目名・補助科目名を変更できません。{latestYear}年に切り替えてから変更してください。
        </p>
      )}

      <div className="filters">
        <select value={cat} onChange={(e) => setCat(e.target.value as AccountCategory | "all")} aria-label="区分で絞り込み">
          <option value="all">すべての区分</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
        <span className="filter-count">{accounts.length} 科目・補助科目 {subAccounts.length} 件</span>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          <table className="ledger accounts-table">
            <colgroup>
              <col style={{ width: 56 }} />
              <col style={{ width: 64 }} />
              <col />
              <col style={{ width: "22%" }} />
              <col style={{ width: 230 }} />
            </colgroup>
            <thead>
              <tr><th>使う</th><th>コード</th><th>科目名</th><th>補助科目</th><th /></tr>
            </thead>
            <tbody>
              {shownCats.map((c) => (
                <Fragment key={c}>
                  <tr className="cat-row">
                    <td colSpan={5}>{CATEGORY_LABEL[c]}<span className="cat-range">コード {CATEGORY_CODE_RANGE[c][0]}〜{CATEGORY_CODE_RANGE[c][1]}</span></td>
                  </tr>
                  {accounts.filter((a) => a.category === c).map((a) => {
                    const locked = LOCKED_CODES.includes(a.code);
                    const subs = subAccounts.filter((s) => s.account_id === a.id);
                    return (
                      <tr key={a.id} className={a.is_active ? "" : "inactive"}>
                        <td>
                          <input type="checkbox" checked={!!a.is_active} disabled={locked} onChange={(e) => toggle(a, e.target.checked)} aria-label={`${a.name}を使う`} />
                        </td>
                        <td className="muted">{a.code}</td>
                        <td>
                          {a.name}
                          {locked && <Lock size={12} className="lock-icon" aria-label="固定の科目" />}
                          {!a.is_system && <span className="custom-tag">追加</span>}
                        </td>
                        <td className="muted">{subs.length ? subs.map((s) => s.name).join("、") : ""}</td>
                        <td className="row-actions">
                          <button className="link-btn" onClick={() => setSubsFor(a)}><ListTree size={14} /> 補助科目</button>
                          {!locked && !renameLocked && <button className="link-btn" onClick={() => setEditing(a)}><Pencil size={14} /> 編集</button>}
                          {!a.is_system && <button className="link-btn danger" onClick={() => remove(a)}><Trash2 size={14} /> 削除</button>}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && <AccountForm target={editing} onClose={() => setEditing(null)} />}
      {subsFor && <SubAccountsModal account={subsFor} renameLocked={renameLocked} onClose={() => setSubsFor(null)} />}
    </div>
  );
};

// ────────────────────────────────────────────
// 科目の追加・編集
// ────────────────────────────────────────────
const AccountForm = ({ target, onClose }: { target: Account | "new"; onClose: () => void }) => {
  const { db, accounts, reloadAccounts, strict, year } = useAppContext();
  const toast = useToast();
  const isNew = target === "new";
  const [category, setCategory] = useState<AccountCategory>(isNew ? "expense" : target.category);
  const [code, setCode] = useState(isNew ? repo.nextAccountCode(accounts, "expense") ?? "" : target.code);
  const [name, setName] = useState(isNew ? "" : target.name);
  const [kana, setKana] = useState(isNew ? "" : target.kana);
  const [error, setError] = useState("");
  const codeLocked = !isNew && target.is_system === 1;

  const changeCategory = (c: AccountCategory) => {
    setCategory(c);
    setCode(repo.nextAccountCode(accounts, c) ?? "");
  };

  const submit = async () => {
    const data = { code, name, kana, category };
    const err = repo.validateAccount(accounts, data, isNew ? undefined : target.id);
    if (err) return setError(err);
    if (isNew && !repo.nextAccountCode(accounts, category)) return setError("この区分のコードがいっぱいです");
    try {
      if (isNew) await repo.createAccount(db, data);
      else await repo.updateAccount(db, target.id, data);
      await reloadAccounts();
      toast(isNew ? "科目を追加しました" : "科目を更新しました");
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title={isNew ? "科目を追加" : "科目を編集"} onClose={onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>区分</span>
          <select className="input" value={category} disabled={!isNew} onChange={(e) => changeCategory(e.target.value as AccountCategory)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          {!isNew && <small className="field-note">区分はあとから変えられません（過去の集計が変わってしまうため）</small>}
        </label>
        <div className="field-row">
          <label className="field" style={{ maxWidth: 120 }}>
            <span>コード</span>
            <input className="input" value={code} disabled={codeLocked} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </label>
          <label className="field">
            <span>科目名</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：サブスク費" autoFocus maxLength={20} />
          </label>
        </div>
        {!isNew && strict && (
          <p className="field-note">名前を変えると {year}年から新しい名前になります。それより前の年度の帳簿は元の名前のまま残り、変更は履歴に記録されます。</p>
        )}
        <label className="field">
          <span>よみがな（入力時の検索に使います）</span>
          <input className="input" value={kana} onChange={(e) => setKana(e.target.value)} placeholder="例：さぶすくひ" />
        </label>
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="submit" className="btn primary">{isNew ? "追加する" : "保存する"}</button>
        </div>
      </form>
    </Modal>
  );
};

// ────────────────────────────────────────────
// 補助科目
// ────────────────────────────────────────────
const SubAccountsModal = ({ account, renameLocked, onClose }: { account: Account; renameLocked: boolean; onClose: () => void }) => {
  const { db, subAccounts, reloadAccounts } = useAppContext();
  const toast = useToast();
  const subs = subAccounts.filter((s) => s.account_id === account.id);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState("");

  const add = async () => {
    const err = repo.validateSub(subAccounts, account.id, newName);
    if (err) return setError(err);
    await repo.createSub(db, account.id, newName);
    await reloadAccounts();
    setNewName("");
    setError("");
  };

  const saveRename = async () => {
    if (!renaming) return;
    const err = repo.validateSub(subAccounts, account.id, renaming.name, renaming.id);
    if (err) return setError(err);
    try {
      await repo.renameSub(db, renaming.id, renaming.name);
    } catch (e) {
      return setError(String(e));
    }
    await reloadAccounts();
    setRenaming(null);
    setError("");
  };

  const remove = async (id: number, name: string) => {
    if ((await repo.subUsage(db, id)) > 0) {
      toast("この補助科目は使われているので削除できません。「使う」のチェックを外してください。", "error");
      return;
    }
    if (!(await ask(`補助科目「${name}」を削除します。`, { title: "補助科目の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    await repo.deleteSub(db, id);
    await reloadAccounts();
  };

  return (
    <Modal title={`${account.name} の補助科目`} onClose={onClose} width={560}>
      <p className="field-note" style={{ marginBottom: 10 }}>
        例：普通預金 → 銀行名、売掛金・売上高 → 取引先名。1科目につき {MAX_SUB_ACCOUNTS_PER_ACCOUNT} 件まで（いま {subs.length} 件）。
      </p>
      <table className="ledger sub-table">
        <colgroup><col style={{ width: 56 }} /><col /><col style={{ width: 150 }} /></colgroup>
        <thead><tr><th>使う</th><th>補助科目名</th><th /></tr></thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id} className={s.is_active ? "" : "inactive"}>
              <td>
                <input type="checkbox" checked={!!s.is_active} onChange={async (e) => { await repo.setSubActive(db, s.id, e.target.checked); await reloadAccounts(); }} aria-label={`${s.name}を使う`} />
              </td>
              <td>
                {renaming?.id === s.id ? (
                  <input className="input" value={renaming.name} autoFocus onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) saveRename(); if (e.key === "Escape") setRenaming(null); }} />
                ) : s.name}
              </td>
              <td className="row-actions">
                {renaming?.id === s.id ? (
                  <button className="link-btn" onClick={saveRename}>保存</button>
                ) : !renameLocked && (
                  <button className="link-btn" onClick={() => setRenaming({ id: s.id, name: s.name })}><Pencil size={14} /> 名前</button>
                )}
                <button className="link-btn danger" onClick={() => remove(s.id, s.name)}><Trash2 size={14} /> 削除</button>
              </td>
            </tr>
          ))}
          {subs.length === 0 && <tr className="empty-row"><td colSpan={3}>補助科目はまだありません。</td></tr>}
        </tbody>
      </table>
      <div className="sub-add">
        <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新しい補助科目名" maxLength={30}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }} />
        <button className="btn primary" onClick={add} disabled={subs.length >= MAX_SUB_ACCOUNTS_PER_ACCOUNT}><Plus size={16} /> 追加</button>
      </div>
      {error && <p className="form-error-inline" role="alert">{error}</p>}
    </Modal>
  );
};
