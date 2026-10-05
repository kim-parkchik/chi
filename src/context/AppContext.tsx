import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type Database from "../db/connection";
import type { Account, Counterparty, User, FiscalClosing, HomeUseRate, OpeningBalances, Settings, SubAccount, SubOpeningBalances } from "../lib/types";
import { toAccountMap, yearEnd, yearStart, type AccountMap, type FlatLine } from "../lib/accounting";
import { closingOf, expectedNextOpening, openingMismatches, type OpeningMismatch } from "../lib/closing";
import * as repo from "../db/repo";

interface AppContextValue {
  db: Database;
  filePath: string;
  settings: Settings;
  /** 表示中の会計年度 */
  year: number;
  accounts: Account[];
  /** 入力候補に出す科目（非表示にしたものを除く） */
  activeAccounts: Account[];
  accountMap: AccountMap;
  /** 補助科目（全件） */
  subAccounts: SubAccount[];
  subMap: Map<number, SubAccount>;
  /** 科目ID → その科目の使える補助科目 */
  activeSubsOf: (accountId: number | null) => SubAccount[];
  /** 「普通預金（A銀行）」のような表示名 */
  labelOf: (accountId: number, subId?: number | null) => string;
  memoSuggestions: string[];
  /** その年度の家事按分の設定 */
  homeUseRates: HomeUseRate[];
  /** 科目の按分設定（按分しない科目は undefined） */
  homeUseOf: (accountId: number | null) => HomeUseRate | undefined;
  reloadHomeUse: () => Promise<void>;
  /** 操作している人 */
  currentUser: User;
  /** ユーザー（全員。非表示も含む） */
  users: User[];
  reloadUsers: () => Promise<void>;
  /** 取引先（全件。非表示のものも含む） */
  counterparties: Counterparty[];
  reloadCounterparties: () => Promise<void>;
  /** 締め済みの年度 */
  closings: FiscalClosing[];
  /** 表示中の年度が締め済みか */
  isClosed: boolean;
  /** その日付が締め済みの年度に入っているか */
  isDateClosed: (date: string) => boolean;
  /** 厳密モード（電子帳簿保存法対応）か */
  strict: boolean;
  /** データ更新の合図。仕訳を保存したら bump() を呼ぶ */
  dataVersion: number;
  bump: () => void;
  reloadSettings: () => Promise<void>;
  reloadAccounts: () => Promise<void>;
}

const Ctx = createContext<AppContextValue | null>(null);

export const useAppContext = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider の外で useAppContext が呼ばれました");
  return v;
};

interface Props {
  db: Database;
  filePath: string;
  initialSettings: Settings;
  initialAccounts: Account[];
  initialSubs: SubAccount[];
  user: User;
  children: ReactNode;
}

export const AppProvider = ({ db, filePath, initialSettings, initialAccounts, initialSubs, user, children }: Props) => {
  const [users, setUsers] = useState<User[]>([user]);
  const reloadUsers = useCallback(async () => setUsers(await repo.getUsers(db)), [db]);
  useEffect(() => {
    reloadUsers().catch(console.error);
  }, [reloadUsers]);
  // 名前を変えたときなどは一覧の方が新しい
  const currentUser = users.find((u) => u.id === user.id) ?? user;
  const [settings, setSettings] = useState(initialSettings);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [subAccounts, setSubAccounts] = useState(initialSubs);
  const [dataVersion, setDataVersion] = useState(0);
  const [memoSuggestions, setMemoSuggestions] = useState<string[]>([]);

  const bump = useCallback(() => setDataVersion((v) => v + 1), []);
  const reloadSettings = useCallback(async () => setSettings(await repo.getSettings(db)), [db]);
  // 科目と補助科目はいつも一緒に読み直す
  // 名前は年度ごとに変わりうるので、年度を切り替えたら読み直す
  const year = settings.fiscal_year;
  const reloadAccounts = useCallback(async () => {
    const [a, s] = await Promise.all([repo.getAccounts(db, year), repo.getSubAccounts(db, year)]);
    setAccounts(a);
    setSubAccounts(s);
  }, [db, year]);

  useEffect(() => {
    reloadAccounts().catch(console.error);
  }, [reloadAccounts]);

  const [homeUseRates, setHomeUseRates] = useState<HomeUseRate[]>([]);
  const reloadHomeUse = useCallback(async () => setHomeUseRates(await repo.getHomeUseRates(db, year)), [db, year]);
  useEffect(() => {
    reloadHomeUse().catch(console.error);
  }, [reloadHomeUse]);

  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const reloadCounterparties = useCallback(async () => setCounterparties(await repo.getCounterparties(db)), [db]);
  useEffect(() => {
    reloadCounterparties().catch(console.error);
  }, [reloadCounterparties]);

  // 締めは繰越・解除のたびに変わるので、データ更新の合図（bump）で読み直す
  const [closings, setClosings] = useState<FiscalClosing[]>([]);
  useEffect(() => {
    repo.getClosings(db).then(setClosings).catch(console.error);
  }, [db, dataVersion]);

  useEffect(() => {
    repo.getMemoSuggestions(db).then(setMemoSuggestions).catch(console.error);
  }, [db, dataVersion]);

  const value = useMemo<AppContextValue>(() => {
    const accountMap = toAccountMap(accounts);
    const subMap = new Map(subAccounts.map((s) => [s.id, s]));
    return {
      db,
      filePath,
      settings,
      year: settings.fiscal_year,
      strict: settings.e_book_mode === "strict",
      accounts,
      activeAccounts: accounts.filter((a) => a.is_active),
      accountMap,
      subAccounts,
      subMap,
      activeSubsOf: (id) => (id ? subAccounts.filter((s) => s.account_id === id && s.is_active) : []),
      labelOf: (id, subId) => {
        const name = accountMap.get(id)?.name ?? "";
        const sub = subId ? subMap.get(subId)?.name : "";
        return sub ? `${name}（${sub}）` : name;
      },
      memoSuggestions,
      homeUseRates,
      homeUseOf: (id) => (id ? homeUseRates.find((r) => r.account_id === id && r.rate < 100) : undefined),
      reloadHomeUse,
      currentUser,
      users,
      reloadUsers,
      counterparties,
      reloadCounterparties,
      closings,
      isClosed: closings.some((c) => c.fiscal_year === settings.fiscal_year),
      isDateClosed: (date) => !!closingOf(closings, date),
      dataVersion,
      bump,
      reloadSettings,
      reloadAccounts,
    };
  }, [db, filePath, settings, accounts, subAccounts, memoSuggestions, homeUseRates, reloadHomeUse, currentUser, users, reloadUsers, counterparties, reloadCounterparties, closings, dataVersion, bump, reloadSettings, reloadAccounts]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 表示中の年度の仕訳明細と期首残高を読み込む */
export const useYearData = () => {
  const { db, year, dataVersion } = useAppContext();
  const [lines, setLines] = useState<FlatLine[]>([]);
  const [opening, setOpening] = useState<OpeningBalances>({});
  const [subOpening, setSubOpening] = useState<SubOpeningBalances>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([repo.getLines(db, yearStart(year), yearEnd(year)), repo.getOpening(db, year)])
      .then(([l, o]) => {
        if (!alive) return;
        setLines(l);
        setOpening(o.byAccount);
        setSubOpening(o.bySub);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);

  return { lines, opening, subOpening, loading };
};

export interface CarryForwardCheck {
  /** 繰越元の年度 */
  from: number;
  /** 繰越先の年度 */
  to: number;
  mismatches: OpeningMismatch[];
}

/**
 * 表示中の年度の前後で、期首残高が前年の期末残高（繰越額）とずれていないかを調べる。
 *  - 前年 → 今年：今年の期首残高が、前年の帳簿を直したあとの繰越額と合っているか
 *  - 今年 → 翌年：今年の帳簿を直して、翌年の期首残高とずれていないか
 * 繰越元にデータが無い年度（最初の年度の期首を手入力した場合など）は調べない
 */
export const useCarryForwardCheck = () => {
  const { db, year, accounts, dataVersion } = useAppContext();
  const [checks, setChecks] = useState<CarryForwardCheck[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: CarryForwardCheck[] = [];
      for (const from of [year - 1, year]) {
        const to = from + 1;
        if (!(await repo.hasOpening(db, to))) continue;
        const [lines, op, next] = await Promise.all([
          repo.getLines(db, yearStart(from), yearEnd(from)),
          repo.getOpening(db, from),
          repo.getOpening(db, to),
        ]);
        if (lines.length === 0 && Object.keys(op.bySub).length === 0) continue;
        const mismatches = openingMismatches(expectedNextOpening(accounts, op.byAccount, op.bySub, lines), next.bySub);
        if (mismatches.length > 0) out.push({ from, to, mismatches });
      }
      if (alive) setChecks(out);
    })().catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, accounts, dataVersion]);

  return checks;
};
