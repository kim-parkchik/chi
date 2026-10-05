/**
 * 残高試算表（貸借対照表 / 損益計算書）
 */
import { Fragment, useMemo, useState } from "react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { MonthRange } from "../../components/MonthRange";
import {
  buildTrialBalance, monthEnd, monthStart, subTrialRow, summarizeIncome, yearStart, type TrialBalanceRow,
} from "../../lib/accounting";
import { yen } from "../../lib/format";
import { BS_CATEGORIES, CATEGORY_LABEL, PL_CATEGORIES } from "../../constants/accounts";
import type { AccountCategory } from "../../lib/types";

type View = "bs" | "pl";

export const TrialBalancePage = () => {
  const { year, accounts, subAccounts } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const [showSubs, setShowSubs] = useState(true);
  const [view, setView] = useState<View>("bs");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(12);
  const [hideZero, setHideZero] = useState(true);

  const rows = useMemo(
    () => buildTrialBalance(accounts, opening, lines, yearStart(year), monthStart(year, from), monthEnd(year, to)),
    [accounts, opening, lines, year, from, to],
  );

  const toBalances = (pick: (r: TrialBalanceRow) => number) => new Map(rows.map((r) => [r.account.id, pick(r)]));
  const incomeCarried = summarizeIncome(accounts, toBalances((r) => r.carried)).income;
  const incomeEnd = summarizeIncome(accounts, toBalances((r) => r.balance)).income;
  const incomeDuring = incomeEnd - incomeCarried;

  const cats: AccountCategory[] = view === "bs" ? BS_CATEGORIES : PL_CATEGORIES;
  const isEmpty = (r: TrialBalanceRow) => r.carried === 0 && r.debit === 0 && r.credit === 0 && r.balance === 0;

  const subtotal = (cat: AccountCategory) =>
    rows
      .filter((r) => r.account.category === cat)
      .reduce(
        (t, r) => {
          // 期末商品棚卸高は原価のマイナスとして集計
          const sign = cat === "cogs" && r.account.normal_side === "credit" ? -1 : 1;
          return {
            carried: t.carried + sign * r.carried,
            debit: t.debit + r.debit,
            credit: t.credit + r.credit,
            balance: t.balance + sign * r.balance,
          };
        },
        { carried: 0, debit: 0, credit: 0, balance: 0 },
      );

  return (
    <div className="page">
      <PageHeader title="残高試算表">
        <MonthRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      </PageHeader>

      <div className="filters">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === "bs"} className={view === "bs" ? "on" : ""} onClick={() => setView("bs")}>貸借対照表</button>
          <button role="tab" aria-selected={view === "pl"} className={view === "pl" ? "on" : ""} onClick={() => setView("pl")}>損益計算書</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} /> 金額のない科目を隠す
        </label>
        <label className="check">
          <input type="checkbox" checked={showSubs} onChange={(e) => setShowSubs(e.target.checked)} /> 補助科目の内訳も表示
        </label>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          <table className="ledger tb-table">
            <colgroup>
              <col />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>勘定科目</th>
                <th className="num">{from === 1 ? "前期繰越" : "前月繰越"}</th>
                <th className="num dr">借方</th>
                <th className="num cr">貸方</th>
                <th className="num">{to}月末残高</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((cat) => {
                const items = rows.filter((r) => r.account.category === cat && !(hideZero && isEmpty(r)));
                const st = subtotal(cat);
                return (
                  <Fragment key={cat}>
                    <tr className="cat-row"><td colSpan={5}>{CATEGORY_LABEL[cat]}</td></tr>
                    {items.map((r) => {
                      const subs = showSubs ? subAccounts.filter((x) => x.account_id === r.account.id) : [];
                      const subRows = subs.length === 0 ? [] : [
                        ...subs.map((x) => ({ label: x.name, row: subTrialRow(r.account, x.id, subOpening, lines, yearStart(year), monthStart(year, from), monthEnd(year, to)) })),
                        { label: "補助なし", row: subTrialRow(r.account, null, subOpening, lines, yearStart(year), monthStart(year, from), monthEnd(year, to)) },
                      ].filter((x) => !(hideZero && isEmpty(x.row)));
                      return (
                        <Fragment key={r.account.id}>
                          <tr>
                            <td className="indent">{r.account.name}</td>
                            <td className="num">{yen(r.carried)}</td>
                            <td className="num">{yen(r.debit, { blankZero: true })}</td>
                            <td className="num">{yen(r.credit, { blankZero: true })}</td>
                            <td className={`num${r.balance < 0 ? " negative" : ""}`}>{yen(r.balance)}</td>
                          </tr>
                          {subRows.map((x) => (
                            <tr key={x.label} className="sub-row">
                              <td className="indent2">{x.label}</td>
                              <td className="num">{yen(x.row.carried)}</td>
                              <td className="num">{yen(x.row.debit, { blankZero: true })}</td>
                              <td className="num">{yen(x.row.credit, { blankZero: true })}</td>
                              <td className={`num${x.row.balance < 0 ? " negative" : ""}`}>{yen(x.row.balance)}</td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                    <tr className="subtotal">
                      <td>{CATEGORY_LABEL[cat]}合計</td>
                      <td className="num">{yen(st.carried)}</td>
                      <td className="num">{yen(st.debit)}</td>
                      <td className="num">{yen(st.credit)}</td>
                      <td className="num">{yen(st.balance)}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="grand">
                <td>{view === "bs" ? "所得金額（当期の利益）" : "青色申告特別控除前の所得金額"}</td>
                <td className="num">{yen(incomeCarried)}</td>
                <td colSpan={2} className="num muted">期間中 {yen(incomeDuring)}</td>
                <td className={`num${incomeEnd < 0 ? " negative" : ""}`}>{yen(incomeEnd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
};
