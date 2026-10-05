import { useEffect, useState, type ReactNode } from "react";
import type Database from "./db/connection";
import { exists } from "@tauri-apps/plugin-fs";
import {
  House, BookOpen, FileText, ScrollText, BookText, Scale, FileSpreadsheet, Landmark, Tags, Settings as SettingsIcon, LogOut, History, ShieldCheck, Percent, Paperclip, Building2, Users, UserRound, Repeat,
} from "lucide-react";
import { AppProvider, useAppContext } from "./context/AppContext";
import { openDatabase, pruneBackups, pickExistingFile, pickNewFile, pushRecentFile, removeRecentFile } from "./db/database";
import * as repo from "./db/repo";
import type { Account, Settings, SubAccount, User } from "./lib/types";
import { useToast } from "./components/Toast";
import { StartScreen, Logo } from "./features/start/StartScreen";
import { DashboardPage } from "./features/home/DashboardPage";
import { CashBookPage } from "./features/entry/CashBookPage";
import { JournalVoucherPage } from "./features/entry/JournalVoucherPage";
import { JournalListPage } from "./features/books/JournalListPage";
import { GeneralLedgerPage } from "./features/books/GeneralLedgerPage";
import { HistoryPage } from "./features/books/HistoryPage";
import { EvidencePage } from "./features/evidence/EvidencePage";
import { TrialBalancePage } from "./features/reports/TrialBalancePage";
import { StatementsPage } from "./features/reports/StatementsPage";
import { HomeUsePage } from "./features/reports/HomeUsePage";
import { OpeningBalancesPage } from "./features/settings/OpeningBalancesPage";
import { AccountsPage } from "./features/settings/AccountsPage";
import { CounterpartiesPage } from "./features/settings/CounterpartiesPage";
import { BusinessSettingsPage } from "./features/settings/BusinessSettingsPage";
import { SetupScreen } from "./features/start/SetupScreen";
import { LoginScreen } from "./features/start/LoginScreen";
import { UsersPage } from "./features/settings/UsersPage";
import { YearNotice } from "./components/YearNotice";
import { IntegrityNotice } from "./components/IntegrityNotice";

export type Page =
  | "home" | "cashbook" | "voucher" | "journal" | "ledger" | "evidence" | "history" | "trial" | "homeuse" | "statements" | "opening" | "accounts" | "counterparties" | "users" | "settings";

const NAV: { group: string; items: { id: Page; label: string; icon: ReactNode }[] }[] = [
  { group: "", items: [{ id: "home", label: "ホーム", icon: <House size={17} /> }] },
  {
    group: "入力",
    items: [
      { id: "cashbook", label: "帳簿入力", icon: <BookOpen size={17} /> },
      { id: "voucher", label: "振替伝票", icon: <FileText size={17} /> },
    ],
  },
  {
    group: "帳簿",
    items: [
      { id: "journal", label: "仕訳日記帳", icon: <ScrollText size={17} /> },
      { id: "ledger", label: "総勘定元帳", icon: <BookText size={17} /> },
      { id: "evidence", label: "証憑", icon: <Paperclip size={17} /> },
      { id: "history", label: "訂正・削除履歴", icon: <History size={17} /> },
    ],
  },
  {
    group: "集計",
    items: [
      { id: "trial", label: "残高試算表", icon: <Scale size={17} /> },
      { id: "homeuse", label: "家事按分", icon: <Percent size={17} /> },
      { id: "statements", label: "決算書", icon: <FileSpreadsheet size={17} /> },
    ],
  },
  {
    group: "設定",
    items: [
      { id: "opening", label: "期首残高", icon: <Landmark size={17} /> },
      { id: "accounts", label: "勘定科目", icon: <Tags size={17} /> },
      { id: "counterparties", label: "取引先", icon: <Building2 size={17} /> },
      { id: "users", label: "ユーザー", icon: <Users size={17} /> },
      { id: "settings", label: "事業者設定", icon: <SettingsIcon size={17} /> },
    ],
  },
];

interface Session {
  db: Database;
  path: string;
  settings: Settings;
  accounts: Account[];
  subs: SubAccount[];
  /** 操作している人（選ぶまでは null） */
  user: User | null;
  /** 前回、保存の途中で止まって取り消された操作 */
  interrupted: string[];
}

export default function App() {
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (path: string, isNew = false) => {
    setBusy(true);
    try {
      if (!isNew && !(await exists(path))) {
        removeRecentFile(path);
        toast("ファイルが見つかりません。移動または削除された可能性があります。", "error");
        return;
      }
      const { db, triggersBefore } = await openDatabase(path);
      repo.setActor(null);
      await repo.checkTriggers(db, triggersBefore);
      await repo.initChain(db);
      const interrupted = await repo.checkInterrupted(db);
      await repo.initClosings(db);
      try {
        await pruneBackups(path, await repo.getBackupGenerations(db));
      } catch (e) {
        console.warn("バックアップの整理に失敗しました", e);
      }
      const settings = await repo.getSettings(db);
      const [accounts, subs] = await Promise.all([
        repo.getAccounts(db, settings.fiscal_year),
        repo.getSubAccounts(db, settings.fiscal_year),
      ]);
      pushRecentFile(path);
      setSession({ db, path, settings, accounts, subs, user: null, interrupted });
    } catch (e) {
      console.error(e);
      toast(`帳簿を開けませんでした：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <StartScreen
        busy={busy}
        onCreate={async () => {
          const p = await pickNewFile();
          if (p) await load(p, true);
        }}
        onOpen={async () => {
          const p = await pickExistingFile();
          if (p) await load(p);
        }}
        onOpenPath={(p) => load(p)}
      />
    );
  }

  const close = async () => {
    try {
      if (session.user) await repo.logAccess(session.db, session.user.id, "logout");
      repo.setActor(null);
      await session.db.close();
    } catch {
      /* すでに閉じていれば無視 */
    }
    setSession(null);
  };

  // 新しい帳簿（または保存方式が未設定の帳簿）は、まず初期設定
  if (!session.settings.business_name || !session.settings.e_book_mode) {
    return (
      <SetupScreen
        db={session.db}
        settings={session.settings}
        onDone={(settings) => setSession({ ...session, settings })}
        onBack={close}
      />
    );
  }

  // 使う人を選ぶ（1人だけでパスワードもなければ自動）
  if (!session.user) {
    return (
      <UserGate
        db={session.db}
        settings={session.settings}
        onLogin={async (user) => {
          repo.setActor(user.id);
          await repo.logAccess(session.db, user.id, "login");
          setSession({ ...session, user });
        }}
        onBack={close}
      />
    );
  }

  const switchUser = async () => {
    if (session.user) await repo.logAccess(session.db, session.user.id, "logout");
    repo.setActor(null);
    setSession({ ...session, user: null, interrupted: [] });
  };

  return (
    <AppProvider key={session.path} db={session.db} filePath={session.path} initialSettings={session.settings} initialAccounts={session.accounts} initialSubs={session.subs} user={session.user}>
      <Shell onClose={close} onSwitchUser={switchUser} interrupted={session.interrupted} />
    </AppProvider>
  );
}

/** ユーザーがいなければ最初の1人を作り、1人だけでパスワードもなければそのまま選ぶ。それ以外は選ぶ画面 */
const UserGate = ({ db, settings, onLogin, onBack }: {
  db: Database;
  settings: Settings;
  onLogin: (u: User) => void;
  onBack: () => void;
}) => {
  const [users, setUsers] = useState<User[] | null>(null);
  useEffect(() => {
    (async () => {
      await repo.ensureUsers(db, settings.owner_name);
      const list = await repo.getUsers(db);
      const active = list.filter((u) => u.is_active);
      if (active.length === 1 && !active[0].has_password) onLogin(active[0]);
      else setUsers(list);
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);
  if (!users) return null;
  return <LoginScreen db={db} users={users} businessName={settings.business_name} onLogin={onLogin} onBack={onBack} />;
};

const Shell = ({ onClose, onSwitchUser, interrupted }: { onClose: () => void; onSwitchUser: () => void; interrupted: string[] }) => {
  const { db, settings, year, filePath, reloadSettings, dataVersion, strict, currentUser, users } = useAppContext();
  const [showInterrupted, setShowInterrupted] = useState(interrupted.length > 0);
  const [page, setPage] = useState<Page>("home");
  const [years, setYears] = useState<number[]>([year]);

  useEffect(() => {
    repo.getYears(db, year).then(setYears).catch(console.error);
  }, [db, year, dataVersion]);

  const switchYear = async (y: number) => {
    await repo.saveSettings(db, { ...settings, fiscal_year: y });
    await reloadSettings();
  };

  const fileName = filePath.split(/[\\/]/).pop();
  const current = NAV.flatMap((g) => g.items).find((i) => i.id === page)!;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="メニュー">
        <div className="brand">
          <Logo size={30} />
          <div className="brand-text">
            <strong>{settings.business_name}</strong>
            <span>{settings.owner_name}</span>
          </div>
        </div>
        {strict && (
          <div className="mode-badge" title="電子帳簿保存法（優良な電子帳簿）に対応した保存方式です">
            <ShieldCheck size={13} /> 電子帳簿保存法 対応
          </div>
        )}
        {NAV.map((g) => (
          <div key={g.group || "top"} className="nav-group">
            {g.group && <div className="nav-label">{g.group}</div>}
            {g.items.filter((i) => strict || i.id !== "history").map((i) => (
              <button key={i.id} className={`nav-item${page === i.id ? " on" : ""}`} onClick={() => setPage(i.id)} aria-current={page === i.id ? "page" : undefined}>
                {i.icon}
                <span>{i.label}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="nav-foot">
          <div className="nav-user" title="操作はこの人の名前で記録されます">
            <UserRound size={15} /> <strong>{currentUser.name}</strong>
          </div>
          {users.filter((u) => u.is_active).length > 1 || currentUser.has_password ? (
            <button className="nav-item" onClick={onSwitchUser}>
              <Repeat size={17} />
              <span>ユーザーの切り替え</span>
            </button>
          ) : null}
          <button className="nav-item" onClick={onClose}>
            <LogOut size={17} />
            <span>帳簿を閉じる</span>
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{current.label}</span>
          <div className="topbar-right">
            <span className="file-name" title={filePath}>{fileName}</span>
            <label className="year-pick">
              <span className="sr-only">会計年度</span>
              <select value={year} onChange={(e) => switchYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}年</option>)}
              </select>
            </label>
          </div>
        </header>
        {showInterrupted && (
          <div className="year-notice">
            <div className="year-notice-row warn">
              <span>
                前回、次の保存が完了しないままソフトが止まりました。書きかけの内容は取り消されているので、必要なら入力し直してください：
                {interrupted.join("、")}
              </span>
              <button className="btn ghost sm" onClick={() => setShowInterrupted(false)}>閉じる</button>
            </div>
          </div>
        )}
        <IntegrityNotice goHistory={() => setPage("history")} />
        <YearNotice goSettings={() => setPage("settings")} switchYear={switchYear} />
        <main className="content">
          {page === "home" && <DashboardPage go={setPage} />}
          {page === "cashbook" && <CashBookPage />}
          {page === "voucher" && <JournalVoucherPage />}
          {page === "journal" && <JournalListPage />}
          {page === "ledger" && <GeneralLedgerPage />}
          {page === "evidence" && <EvidencePage />}
          {page === "history" && <HistoryPage />}
          {page === "trial" && <TrialBalancePage />}
          {page === "homeuse" && <HomeUsePage />}
          {page === "statements" && <StatementsPage />}
          {page === "opening" && <OpeningBalancesPage />}
          {page === "accounts" && <AccountsPage />}
          {page === "counterparties" && <CounterpartiesPage />}
          {page === "users" && <UsersPage />}
          {page === "settings" && <BusinessSettingsPage />}
        </main>
      </div>
    </div>
  );
};
