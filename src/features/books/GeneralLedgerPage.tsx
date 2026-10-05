/**
 * 総勘定元帳
 * 左で科目を選び、右でその科目の動きと残高を確認します。
 */
import { useMemo, useState } from "react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { MonthRange } from "../../components/MonthRange";
import { EntryEditModal } from "../entry/EntryEditModal";
import { buildLedger, closingBalances, monthEnd, monthStart } from "../../lib/accounting";
import { shortDate, yen } from "../../lib/format";
import { CATEGORY_LABEL, isBalanceSheet } from "../../constants/accounts";
import { subKey, type AccountCategory } from "../../lib/types";

const ORDER: AccountCategory[] = ["asset", "liability", "equity", "revenue", "cogs", "expense", "special"];

export const GeneralLedgerPage = () => {
  const { year, accounts, accountMap, subAccounts, labelOf, subMap } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const [accountId, setAccountIdRaw] = useState(accounts[0].id);
  const [sub, setSub] = useState<number | null | undefined>(undefined);
  const setAccountId = (id: number) => {
    setAccountIdRaw(id);
    setSub(undefined);
  };
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(12);
  const [editing, setEditing] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  const balances = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const used = useMemo(() => new Set(lines.map((l) => l.account_id)), [lines]);

  const account = accountMap.get(accountId)!;
  const subs = subAccounts.filter((x) => x.account_id === accountId);
  const base = !isBalanceSheet(account.category)
    ? 0
    : sub === undefined
      ? opening[account.id] ?? 0
      : subOpening[subKey(account.id, sub)] ?? 0;

  const { carried, rows } = useMemo(() => {
    const all = buildLedger(account, base, lines, accountMap, sub);
    const start = monthStart(year, from);
    const end = monthEnd(year, to);
    const prefix = all.filter((r) => r.date < start);
    return {
      carried: prefix.length ? prefix[prefix.length - 1].balance : base,
      rows: all.filter((r) => r.date >= start && r.date <= end),
    };
  }, [account, base, lines, accountMap, year, from, to, sub]);

  const sum = rows.reduce((t, r) => ({ dr: t.dr + r.debit, cr: t.cr + r.credit }), { dr: 0, cr: 0 });

  // 残高か動きがある科目だけ（「すべて表示」で全科目）
  const visible = accounts.filter(
    (a) => showAll || a.id === accountId || used.has(a.id) || (balances.get(a.id) ?? 0) !== 0,
  );

  return (
    <div className="page">
      <PageHeader title="総勘定元帳">
        <MonthRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      </PageHeader>

      <div className="split">
        <aside className="account-rail" aria-label="勘定科目">
          {ORDER.map((cat) => {
            const items = visible.filter((a) => a.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="rail-group">
                <div className="rail-cat">{CATEGORY_LABEL[cat]}</div>
                {items.map((a) => (
                  <button key={a.id} className={`rail-item${a.id === accountId ? " on" : ""}`} onClick={() => setAccountId(a.id)}>
                    <span>{a.name}</span>
                    <span className="num">{yen(balances.get(a.id) ?? 0)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          <label className="rail-toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 動きのない科目も表示
          </label>
        </aside>

        <section className="sheet sheet-fill">
          <div className="sheet-title">
            <h2>{account.name}</h2>
            <span className="muted">{account.code}・{CATEGORY_LABEL[account.category]}</span>
          </div>
          {subs.length > 0 && (
            <div className="sub-picker" role="tablist" aria-label="補助科目">
              <span className="sub-picker-label">補助科目</span>
              <button role="tab" aria-selected={sub === undefined} className={sub === undefined ? "on" : ""} onClick={() => setSub(undefined)}>全体</button>
              {subs.map((x) => (
                <button key={x.id} role="tab" aria-selected={sub === x.id} className={sub === x.id ? "on" : ""} onClick={() => setSub(x.id)}>{x.name}</button>
              ))}
              <button role="tab" aria-selected={sub === null} className={sub === null ? "on" : ""} onClick={() => setSub(null)}>補助なし</button>
            </div>
          )}
          <div className="table-wrap scroll-y">
            <table className="ledger">
              <colgroup>
                <col style={{ width: 64 }} />
                <col style={{ width: "17%" }} />
                <col />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "15%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>相手科目</th>
                  <th>摘要</th>
                  <th className="num dr">借方</th>
                  <th className="num cr">貸方</th>
                  <th className="num">残高</th>
                </tr>
              </thead>
              <tbody>
                <tr className="carried">
                  <td />
                  <td colSpan={4}>{from === 1 ? "前期より繰越" : "前月より繰越"}</td>
                  <td className="num">{yen(carried)}</td>
                </tr>
                {rows.map((r, i) => (
                  <tr key={`${r.entry_id}-${i}`} className="clickable" onClick={() => setEditing(r.entry_id)}>
                    <td>{shortDate(r.date)}</td>
                    <td>{r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter}</td>
                    <td className="memo">
                      {sub === undefined && r.subId && <span className="sub-tag">{subMap.get(r.subId)?.name}</span>}
                      {r.memo}
                    </td>
                    <td className="num">{yen(r.debit, { blankZero: true })}</td>
                    <td className="num">{yen(r.credit, { blankZero: true })}</td>
                    <td className={`num${r.balance < 0 ? " negative" : ""}`}>{yen(r.balance)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr className="empty-row"><td colSpan={6}>この期間の動きはありません。</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="total-label">期間合計</td>
                  <td className="num">{yen(sum.dr)}</td>
                  <td className="num">{yen(sum.cr)}</td>
                  <td className="num">{yen(rows.length ? rows[rows.length - 1].balance : carried)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </div>

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};
