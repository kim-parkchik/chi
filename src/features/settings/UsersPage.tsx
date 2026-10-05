/**
 * ユーザーの管理
 *  - 権限はまだ分けない（全員が同じ操作をできる）。誰が操作したかを記録するためのもの
 *  - パスワードは任意。設定した人は、帳簿を開くときにパスワードが要る
 *  - 履歴に名前が残るので削除はできない（非表示にはできる）
 */
import { useState } from "react";
import { KeyRound, Pencil, Plus } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { validatePassword } from "../../lib/password";
import type { User } from "../../lib/types";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const UsersPage = () => {
  const { db, users, reloadUsers, currentUser, strict } = useAppContext();
  const toast = useToast();
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [pwFor, setPwFor] = useState<User | null>(null);

  const toggle = async (u: User, active: boolean) => {
    try {
      await repo.setUserActive(db, u.id, active);
      await reloadUsers();
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="ユーザー"
        note={`この帳簿を使う人です。登録・訂正・削除などの操作は、操作した人の名前で記録されます${strict ? "（訂正・削除履歴に表示）" : "（仕訳・証憑の登録者・更新者）"}。今は全員が同じ操作をできます。`}
      >
        <button className="btn primary" onClick={() => setEditing("new")}><Plus size={16} /> ユーザーを追加</button>
      </PageHeader>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          <table className="ledger">
            <colgroup>
              <col style={{ width: 56 }} /><col /><col style={{ width: 140 }} /><col style={{ width: 180 }} /><col style={{ width: 240 }} />
            </colgroup>
            <thead>
              <tr><th>使う</th><th>名前</th><th>パスワード</th><th>追加した日時</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "inactive"}>
                  <td>
                    <input type="checkbox" checked={!!u.is_active} disabled={u.id === currentUser.id} onChange={(e) => toggle(u, e.target.checked)} aria-label={`${u.name}を使う`} />
                  </td>
                  <td>{u.name}{u.id === currentUser.id && <span className="custom-tag">使用中</span>}</td>
                  <td className="muted">{u.has_password ? "あり" : "なし"}</td>
                  <td className="muted">{u.created_at}</td>
                  <td className="row-actions">
                    <button className="link-btn" onClick={() => setEditing(u)}><Pencil size={14} /> 名前</button>
                    <button className="link-btn" onClick={() => setPwFor(u)}><KeyRound size={14} /> パスワード</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="field-note">
        パスワードは帳簿ファイルの中にハッシュ（元に戻せない形）で保存します。ただし帳簿ファイルを直接書き換えれば外せるため、成りすましを完全には防げません。
      </p>

      {editing && <UserForm target={editing} onClose={() => setEditing(null)} />}
      {pwFor && <PasswordForm user={pwFor} onClose={() => setPwFor(null)} />}
    </div>
  );
};

const UserForm = ({ target, onClose }: { target: User | "new"; onClose: () => void }) => {
  const { db, users, reloadUsers } = useAppContext();
  const toast = useToast();
  const isNew = target === "new";
  const [name, setName] = useState(isNew ? "" : target.name);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    const err = repo.validateUserName(users, name, isNew ? undefined : target.id) ?? (isNew && password ? validatePassword(password) : null);
    if (err) return setError(err);
    try {
      if (isNew) await repo.createUser(db, name, password);
      else await repo.renameUser(db, target.id, name);
      await reloadUsers();
      toast(isNew ? "ユーザーを追加しました" : "名前を変更しました");
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Modal title={isNew ? "ユーザーの追加" : "名前の変更"} onClose={onClose} width={480}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>名前</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoFocus placeholder="例：山田" />
        </label>
        {isNew && (
          <label className="field">
            <span>パスワード（任意・4文字以上）</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {!isNew && <p className="field-note">名前を変えると、これまでの記録の表示も新しい名前になります。</p>}
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

const PasswordForm = ({ user, onClose }: { user: User; onClose: () => void }) => {
  const { db, reloadUsers } = useAppContext();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const submit = async (remove: boolean) => {
    setError("");
    if (!remove) {
      const pe = validatePassword(next);
      if (pe) return setError(pe);
      if (next !== confirm) return setError("確認のパスワードが一致しません");
    }
    try {
      await repo.setUserPassword(db, user.id, current, remove ? "" : next);
      await reloadUsers();
      toast(remove ? "パスワードをなくしました" : "パスワードを設定しました");
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Modal title={`${user.name} のパスワード`} onClose={onClose} width={480}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        {user.has_password ? (
          <label className="field">
            <span>今のパスワード</span>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus autoComplete="current-password" />
          </label>
        ) : null}
        <label className="field">
          <span>新しいパスワード（4文字以上）</span>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus={!user.has_password} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>新しいパスワード（確認）</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          {user.has_password ? <button type="button" className="btn danger-ghost" onClick={() => submit(true)} disabled={!current}>パスワードをなくす</button> : null}
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit">設定する</button>
        </div>
      </form>
    </Modal>
  );
};
