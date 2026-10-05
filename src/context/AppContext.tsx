import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type Database from "@tauri-apps/plugin-sql";
import type { Account, HomeUseRate, OpeningBalances, Settings, SubAccount, SubOpeningBalances } from "../lib/types";
import { toAccountMap, yearEnd, yearStart, type AccountMap, type FlatLine } from "../lib/accounting";
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
  children: ReactNode;
}

export const AppProvider = ({ db, filePath, initialSettings, initialAccounts, initialSubs, children }: Props) => {
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
      dataVersion,
      bump,
      reloadSettings,
      reloadAccounts,
    };
  }, [db, filePath, settings, accounts, subAccounts, memoSuggestions, homeUseRates, reloadHomeUse, dataVersion, bump, reloadSettings, reloadAccounts]);

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
