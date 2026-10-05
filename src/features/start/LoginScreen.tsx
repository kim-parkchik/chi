/**
 * ユーザーを選ぶ（帳簿を開いたとき・ユーザーを切り替えたとき）
 * ユーザーが1人だけで、パスワードもなければ、この画面は出さずに自動で選ぶ（App.tsx の UserGate）
 */
import { useState } from "react";
import { KeyRound, LogIn, UserRound } from "lucide-react";
import type Database from "../../db/connection";
import type { User } from "../../lib/types";
import { Logo } from "./StartScreen";
import * as repo from "../../db/repo";

interface Props {
  db: Database;
  users: User[];
  businessName: string;
  onLogin: (user: User) => void;
  onBack: () => void;
}

export const LoginScreen = ({ db, users, businessName, onLogin, onBack }: Props) => {
  const active = users.filter((u) => u.is_active);
  const [selected, setSelected] = useState<User | null>(active.length === 1 ? active[0] : null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const login = async (u: User, pw: string) => {
    setBusy(true);
    setError("");
    try {
      if (await repo.checkLogin(db, u.id, pw)) onLogin(u);
      else setError("パスワードが違います");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="start">
      <div className="start-card login-card">
        <Logo size={56} />
        <h1 className="start-title">{businessName}</h1>
        <p className="start-sub">使う人を選んでください。登録・訂正などの操作は、選んだ人の名前で記録されます。</p>
        <ul className="user-list">
          {active.map((u) => (
            <li key={u.id}>
              <button
                className={`user-pick${selected?.id === u.id ? " on" : ""}`}
                onClick={() => {
                  setSelected(u);
                  setPassword("");
                  setError("");
                  if (!u.has_password) login(u, "");
                }}
                disabled={busy}
              >
                <UserRound size={18} /> <span>{u.name}</span> {u.has_password ? <KeyRound size={14} className="muted" aria-label="パスワードあり" /> : null}
              </button>
            </li>
          ))}
        </ul>
        {selected?.has_password ? (
          <form className="login-form" onSubmit={(e) => { e.preventDefault(); login(selected, password); }}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`${selected.name} のパスワード`} autoFocus />
            <button className="btn primary" type="submit" disabled={busy || !password}><LogIn size={16} /> はじめる</button>
          </form>
        ) : null}
        {error && <p className="notice" role="alert">{error}</p>}
        <button className="link-btn" onClick={onBack}>帳簿を閉じる</button>
      </div>
    </div>
  );
};
