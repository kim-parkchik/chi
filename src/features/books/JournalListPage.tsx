/**
 * 仕訳日記帳
 * すべての仕訳を日付順に表示します。行をクリックすると修正できます。
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { MonthRange } from "../../components/MonthRange";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { groupByEntry, monthEnd, monthStart, yearEnd, yearStart, type FlatLine } from "../../lib/accounting";
import { parseAmount, shortDate, yen } from "../../lib/format";
import * as repo from "../../db/repo";

interface DisplayRow {
  entryId: number;
  date: string;
  first: boolean;
  span: number;
  dr?: FlatLine;
  cr?: FlatLine;
  memo: string;
  deleted: boolean;
}

export const JournalListPage = () => {
  const { db, year, accountMap, activeAccounts, settings, labelOf, subMap, dataVersion, strict } = useAppContext();
  const { lines: activeLines } = useYearData();
  const [showDeleted, setShowDeleted] = useState(false);
  const [allLines, setAllLines] = useState<FlatLine[] | null>(null);
  const [minAmt, setMinAmt] = useState("");
  const [maxAmt, setMaxAmt] = useState("");

  // 削除済みも表示するときだけ、削除済みを含めて読み直す
  useEffect(() => {
    if (!showDeleted) return setAllLines(null);
    repo.getLines(db, yearStart(year), yearEnd(year), true).then(setAllLines).catch(console.error);
  }, [db, year, showDeleted, dataVersion]);
  const lines = allLines ?? activeLines;
  const toast = useToast();
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(12);
  const [accountId, setAccountId] = useState(0);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<number | null>(null);

  const rows = useMemo(() => {
    const start = monthStart(year, from);
    const end = monthEnd(year, to);
    const grouped = groupByEntry(lines.filter((l) => l.date >= start && l.date <= end));
    const query = q.trim();
    const lo = parseAmount(minAmt);
    const hi = parseAmount(maxAmt);
    const out: DisplayRow[] = [];
    for (const [entryId, ls] of grouped) {
      if (accountId && !ls.some((l) => l.account_id === accountId)) continue;
      if (query) {
        const hay = ls
          .map((l) => `${l.memo} ${accountMap.get(l.account_id)?.name ?? ""} ${l.sub_account_id ? subMap.get(l.sub_account_id)?.name ?? "" : ""} ${l.amount}`)
          .join(" ");
        if (!hay.includes(query)) continue;
      }
      // 金額の範囲（仕訳の合計金額で判定）
      const total = ls.filter((l) => l.side === "debit").reduce((t, l) => t + l.amount, 0);
      if (lo != null && total < lo) continue;
      if (hi != null && total > hi) continue;
      // 振替伝票の行番号ごとに「借方｜貸方」を横に並べる
      const byRow = new Map<number, { dr?: FlatLine; cr?: FlatLine }>();
      for (const l of ls) {
        const r = byRow.get(l.row_no) ?? {};
        if (l.side === "debit") r.dr = l;
        else r.cr = l;
        byRow.set(l.row_no, r);
      }
      const pairs = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
      pairs.forEach(([, p], i) =>
        out.push({
          entryId,
          date: ls[0].date,
          first: i === 0,
          span: pairs.length,
          dr: p.dr,
          cr: p.cr,
          memo: p.dr?.memo || p.cr?.memo || "",
          deleted: ls[0].is_deleted === 1,
        }),
      );
    }
    return out;
  }, [lines, year, from, to, accountId, q, accountMap, subMap, minAmt, maxAmt]);

  const total = rows.filter((r) => !r.deleted).reduce((s, r) => s + (r.dr?.amount ?? 0), 0);
  const entryCount = rows.filter((r) => r.first && !r.deleted).length;
  const name = (l?: FlatLine) => (l ? labelOf(l.account_id, l.sub_account_id) : "");

  const exportCsv = async () => {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const header = ["伝票No", "日付", "借方科目", "借方補助", "借方金額", "貸方科目", "貸方補助", "貸方金額", "摘要", "状態"];
    const sub = (l?: FlatLine) => (l?.sub_account_id ? subMap.get(l.sub_account_id)?.name ?? "" : "");
    const body = rows.map((r) =>
      [r.entryId, r.date, r.dr ? accountMap.get(r.dr.account_id)?.name ?? "" : "", sub(r.dr), r.dr?.amount ?? "",
        r.cr ? accountMap.get(r.cr.account_id)?.name ?? "" : "", sub(r.cr), r.cr?.amount ?? "", r.memo, r.deleted ? "削除済み" : ""]
        .map(esc)
        .join(","),
    );
    const path = await save({
      defaultPath: `仕訳日記帳_${settings.business_name || "帳簿"}_${year}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      // Excel で文字化けしないよう BOM をつける
      await writeTextFile(path, "\uFEFF" + [header.map(esc).join(","), ...body].join("\r\n"));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  return (
    <div className="page">
      <PageHeader title="仕訳日記帳" note="行をクリックすると訂正・削除できます。日付・金額・取引先（補助科目）を組み合わせて検索できます。">
        <button className="btn ghost" onClick={exportCsv} disabled={rows.length === 0}>
          <Download size={16} /> CSV 書き出し
        </button>
      </PageHeader>

      <div className="filters">
        <MonthRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} aria-label="科目で絞り込み">
          <option value={0}>すべての科目</option>
          {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="摘要・科目・取引先で探す" />
        </label>
        <div className="amount-range">
          <input className="input" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} placeholder="金額 下限" inputMode="numeric" aria-label="金額の下限" />
          <span>〜</span>
          <input className="input" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="上限" inputMode="numeric" aria-label="金額の上限" />
        </div>
        {strict && (
          <label className="check">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> 削除済みも表示
          </label>
        )}
        <span className="filter-count">{entryCount} 件</span>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          <table className="ledger journal-table">
            <colgroup>
              <col style={{ width: 64 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "11%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>日付</th>
                <th className="num">No.</th>
                <th className="dr">借方科目</th>
                <th className="num dr">借方金額</th>
                <th className="cr">貸方科目</th>
                <th className="num cr">貸方金額</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.entryId}-${i}`}
                  className={`clickable${r.first ? " entry-first" : ""}${r.deleted ? " deleted" : ""}`}
                  onClick={() => setEditing(r.entryId)}
                >
                  <td>{r.first ? shortDate(r.date) : ""}</td>
                  <td className="num muted">{r.first ? r.entryId : ""}</td>
                  <td>{name(r.dr)}</td>
                  <td className="num">{r.dr ? yen(r.dr.amount) : ""}</td>
                  <td>{name(r.cr)}</td>
                  <td className="num">{r.cr ? yen(r.cr.amount) : ""}</td>
                  <td className="memo">
                    {r.first && r.deleted && <span className="badge badge-delete">削除済み</span>}
                    {r.first && !r.deleted && (r.dr?.revision ?? r.cr?.revision ?? 1) > 1 && <span className="badge badge-update">訂正あり</span>}
                    {r.memo}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr className="empty-row"><td colSpan={7}>条件に合う仕訳はありません。</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="total-label">合計</td>
                <td className="num">{yen(total)}</td>
                <td />
                <td className="num">{yen(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};
