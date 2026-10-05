/**
 * 決算書（青色申告決算書の 損益計算書・貸借対照表 に近い形）
 */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { closingBalances, summarizeBalanceSheet, summarizeIncome } from "../../lib/accounting";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";
import type { Account, FilingType } from "../../lib/types";

/** 青色申告特別控除の上限（目安） */
const DEDUCTION_LIMIT: Record<FilingType, number> = { blue65: 650_000, blue55: 550_000, blue10: 100_000, white: 0 };

type Tab = "pl" | "bs";

const Line = ({ label, value, strong, indent }: { label: string; value: number | null; strong?: boolean; indent?: boolean }) => (
  <tr className={strong ? "st-strong" : ""}>
    <td className={indent ? "indent" : ""}>{label}</td>
    <td className={`num${value != null && value < 0 ? " negative" : ""}`}>{value == null ? "" : yen(value)}</td>
  </tr>
);

export const StatementsPage = () => {
  const { year, accounts, settings, closings, strict } = useAppContext();
  // 締めたときの確認コード（厳密モード）。印刷した決算書が、帳簿ファイルの外の控えになる
  const closedHead = strict ? closings.find((c) => c.fiscal_year === year)?.chain_head : undefined;
  const { lines, opening } = useYearData();
  const [tab, setTab] = useState<Tab>("pl");

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const pl = summarizeIncome(accounts, end);
  const bs = summarizeBalanceSheet(accounts, end);
  const by = (cat: Account["category"]) => accounts.filter((a) => a.category === cat);
  const val = (a: Account) => end.get(a.id) ?? 0;
  const open = (a: Account) => opening[a.id] ?? 0;

  const limit = DEDUCTION_LIMIT[settings.filing_type];
  const deduction = Math.min(limit, Math.max(0, pl.income));

  const cogs = by("cogs");
  const cogsDebit = cogs.filter((a) => a.normal_side === "debit");
  const cogsCredit = cogs.filter((a) => a.normal_side === "credit");
  const cogsSubtotal = cogsDebit.reduce((s, a) => s + val(a), 0);

  const showRow = (a: Account) => a.is_active || val(a) !== 0 || open(a) !== 0;
  const assets = by("asset").filter(showRow);
  const liabilities = by("liability").filter(showRow);
  const equity = by("equity");
  const openAssetsTotal = assets.reduce((s, a) => s + open(a), 0);
  const openRightTotal = [...liabilities, ...equity].reduce((s, a) => s + open(a), 0);

  return (
    <div className="page">
      <PageHeader title="決算書" note={`${year}年1月1日〜${year}年12月31日`}>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "pl"} className={tab === "pl" ? "on" : ""} onClick={() => setTab("pl")}>損益計算書</button>
          <button role="tab" aria-selected={tab === "bs"} className={tab === "bs" ? "on" : ""} onClick={() => setTab("bs")}>貸借対照表</button>
        </div>
        <button className="btn ghost" onClick={() => window.print()}>
          <Printer size={16} /> 印刷
        </button>
      </PageHeader>

      <section className="sheet statement print-area">
        <header className="statement-head">
          <h2>{tab === "pl" ? "損益計算書" : "貸借対照表"}</h2>
          <p>
            {settings.business_name || "（屋号未設定）"}　{settings.owner_name}
            <br />
            {tab === "pl" ? `自 ${year}年1月1日　至 ${year}年12月31日` : `${year}年12月31日 現在`}
            {closedHead && <><br /><span className="statement-anchor">確認コード {repo.anchorCode(closedHead)}</span></>}
          </p>
        </header>

        {tab === "pl" ? (
          <div className="pl-grid">
            <table className="ledger st-table">
              <tbody>
                <tr className="cat-row"><td colSpan={2}>売上（収入）金額</td></tr>
                {by("revenue").map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="売上（収入）金額 計" value={pl.revenue} strong />

                <tr className="cat-row"><td colSpan={2}>売上原価</td></tr>
                {cogsDebit.map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="小計" value={cogsSubtotal} indent />
                {cogsCredit.map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="差引原価" value={pl.cogs} strong />
                <Line label="差引金額（売上総利益）" value={pl.grossProfit} strong />
              </tbody>
            </table>

            <table className="ledger st-table">
              <tbody>
                <tr className="cat-row"><td colSpan={2}>経費</td></tr>
                {by("expense").filter((a) => a.is_active || val(a) !== 0).map((a) => (
                  <Line key={a.id} label={a.name} value={val(a)} indent />
                ))}
                <Line label="経費 計" value={pl.expenses} strong />
                <Line label="差引金額" value={pl.beforeSpecial} strong />
                {by("special").map((a) => <Line key={a.id} label={a.name} value={val(a)} indent />)}
                <Line label="青色申告特別控除前の所得金額" value={pl.income} strong />
                {settings.filing_type !== "white" && (
                  <>
                    <Line label="青色申告特別控除額（目安）" value={deduction} indent />
                    <Line label="所得金額" value={pl.income - deduction} strong />
                  </>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="bs-grid">
              <table className="ledger st-table bs-table">
                <thead>
                  <tr><th>資産の部</th><th className="num">1月1日（期首）</th><th className="num">12月31日（期末）</th></tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td className="num">{yen(open(a), { blankZero: true })}</td>
                      <td className={`num${val(a) < 0 ? " negative" : ""}`}>{yen(val(a), { blankZero: true })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td>合計</td><td className="num">{yen(openAssetsTotal)}</td><td className="num">{yen(bs.assets)}</td></tr>
                </tfoot>
              </table>

              <table className="ledger st-table bs-table">
                <thead>
                  <tr><th>負債・資本の部</th><th className="num">1月1日（期首）</th><th className="num">12月31日（期末）</th></tr>
                </thead>
                <tbody>
                  {[...liabilities, ...equity].map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td className="num">{yen(open(a), { blankZero: true })}</td>
                      <td className={`num${val(a) < 0 ? " negative" : ""}`}>{yen(val(a), { blankZero: true })}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>青色申告特別控除前の所得金額</td>
                    <td className="num" />
                    <td className={`num${bs.income < 0 ? " negative" : ""}`}>{yen(bs.income)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>合計</td>
                    <td className="num">{yen(openRightTotal)}</td>
                    <td className="num">{yen(bs.liabilities + bs.equity + bs.income)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {bs.difference !== 0 && (
              <p className="warn-box" role="alert">
                資産と負債・資本の合計が {yen(Math.abs(bs.difference))} 円ずれています。「期首残高」の貸借が一致しているか確認してください。
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
};
