/**
 * ホーム
 * 今年の数字をひと目で確認し、よく使う入力画面へすぐ移れるようにします。
 */
import { useMemo } from "react";
import { BookOpen, FileText, TriangleAlert } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { buildMonthly, closingBalances, groupByEntry, openingDifference, summarizeIncome } from "../../lib/accounting";
import { shortDate, yen } from "../../lib/format";
import type { Page } from "../../App";

export const DashboardPage = ({ go }: { go: (p: Page) => void }) => {
  const { year, accounts, accountMap, settings } = useAppContext();
  const { lines, opening } = useYearData();

  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const pl = summarizeIncome(accounts, end);
  const monthly = useMemo(() => buildMonthly(accounts, lines, year), [accounts, lines, year]);
  const peak = Math.max(1, ...monthly.map((m) => Math.max(m.revenue, m.costs)));
  const money = accounts.filter((a) => ["101", "102", "103", "104"].includes(a.code) && (a.is_active || end.get(a.id)));
  const recent = useMemo(() => {
    const groups = [...groupByEntry(lines).values()];
    return groups.sort((a, b) => (a[0].date === b[0].date ? b[0].entry_id - a[0].entry_id : a[0].date < b[0].date ? 1 : -1)).slice(0, 8);
  }, [lines]);
  const openingOff = openingDifference(accounts, opening).difference !== 0;

  return (
    <div className="page">
      <div className="home-head">
        <div>
          <h1>{settings.business_name || "帳簿"}</h1>
          <p className="page-note">{year}年の帳簿　仕訳 {groupByEntry(lines).size} 件</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => go("cashbook")}><BookOpen size={16} /> 帳簿に入力する</button>
          <button className="btn ghost" onClick={() => go("voucher")}><FileText size={16} /> 振替伝票</button>
        </div>
      </div>

      {openingOff && (
        <button className="warn-box clickable" onClick={() => go("opening")}>
          <TriangleAlert size={16} /> 期首残高の貸借が一致していません。期首残高を確認してください。
        </button>
      )}

      <section className="figures" aria-label="今年の集計">
        <div className="figure">
          <span className="figure-label">売上（収入）</span>
          <span className="figure-value">{yen(pl.revenue)}<small>円</small></span>
        </div>
        <div className="figure">
          <span className="figure-label">経費・原価</span>
          <span className="figure-value">{yen(pl.cogs + pl.expenses + pl.special)}<small>円</small></span>
        </div>
        <div className="figure figure-main">
          <span className="figure-label">所得（控除前）</span>
          <span className={`figure-value${pl.income < 0 ? " negative" : ""}`}>{yen(pl.income)}<small>円</small></span>
        </div>
        {money.map((a) => (
          <div key={a.id} className="figure figure-small">
            <span className="figure-label">{a.name}残高</span>
            <span className={`figure-value${(end.get(a.id) ?? 0) < 0 ? " negative" : ""}`}>{yen(end.get(a.id) ?? 0)}<small>円</small></span>
          </div>
        ))}
      </section>

      <div className="home-grid">
        <section className="sheet">
          <h2 className="sheet-h">月別の推移</h2>
          <table className="ledger monthly-table">
            <thead>
              <tr><th>月</th><th className="num">売上</th><th className="num">経費・原価</th><th className="num">所得</th><th className="bar-col" aria-hidden /></tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}月</td>
                  <td className="num">{yen(m.revenue, { blankZero: true })}</td>
                  <td className="num">{yen(m.costs, { blankZero: true })}</td>
                  <td className={`num${m.income < 0 ? " negative" : ""}`}>{yen(m.income, { blankZero: true })}</td>
                  <td className="bar-col" aria-hidden>
                    <span className="bar bar-rev" style={{ width: `${(m.revenue / peak) * 100}%` }} />
                    <span className="bar bar-cost" style={{ width: `${(Math.max(0, m.costs) / peak) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="legend"><span className="sw sw-rev" />売上　<span className="sw sw-cost" />経費・原価</p>
        </section>

        <section className="sheet">
          <h2 className="sheet-h">最近の仕訳</h2>
          {recent.length === 0 ? (
            <div className="empty">
              <p>まだ仕訳がありません。</p>
              <p className="muted">最初は「期首残高」で手元の現金と預金の残高を入れ、そのあと帳簿入力から始めるのがおすすめです。</p>
              <button className="btn ghost" onClick={() => go("opening")}>期首残高を入れる</button>
            </div>
          ) : (
            <ul className="recent">
              {recent.map((ls) => {
                const dr = ls.filter((l) => l.side === "debit");
                const cr = ls.filter((l) => l.side === "credit");
                const name = (xs: typeof ls) => (new Set(xs.map((x) => x.account_id)).size > 1 ? "諸口" : accountMap.get(xs[0]?.account_id)?.name);
                const amount = dr.reduce((s, l) => s + l.amount, 0);
                return (
                  <li key={ls[0].entry_id}>
                    <span className="recent-date">{shortDate(ls[0].date)}</span>
                    <span className="recent-accts">{name(dr)} / {name(cr)}</span>
                    <span className="recent-memo">{ls[0].memo || ls[0].description}</span>
                    <span className="num">{yen(amount)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
