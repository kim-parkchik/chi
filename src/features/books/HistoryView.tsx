/**
 * 訂正・削除履歴の表示部品（履歴ページと、仕訳の修正画面の両方で使う）
 */
import type { EntrySnapshot, HistoryAction, HistoryRecord } from "../../lib/types";
import { shortDate, yen } from "../../lib/format";

export const ACTION_LABEL: Record<HistoryAction, string> = { create: "登録", update: "訂正", delete: "削除" };

const lineLabel = (l: EntrySnapshot["lines"][number]) => (l.sub ? `${l.account}（${l.sub}）` : l.account);

/** 仕訳の写しを「借方 / 貸方」の小さな表で表示する */
export const SnapshotTable = ({ snap, compare }: { snap: EntrySnapshot; compare?: EntrySnapshot }) => {
  const dr = snap.lines.filter((l) => l.side === "debit");
  const cr = snap.lines.filter((l) => l.side === "credit");
  const n = Math.max(dr.length, cr.length);
  // 前の版と違う箇所に印をつける
  const key = (l?: EntrySnapshot["lines"][number]) => (l ? `${l.side}|${lineLabel(l)}|${l.amount}|${l.memo}` : "");
  const prev = new Set(compare?.lines.map(key));
  const changed = (l?: EntrySnapshot["lines"][number]) => !!compare && !!l && !prev.has(key(l));
  const dateChanged = !!compare && compare.date !== snap.date;

  return (
    <table className="snap-table">
      <tbody>
        {Array.from({ length: n }, (_, i) => (
          <tr key={i}>
            <td className={`snap-date${i === 0 && dateChanged ? " changed" : ""}`}>{i === 0 ? shortDate(snap.date) : ""}</td>
            <td className={changed(dr[i]) ? "changed" : ""}>{dr[i] ? lineLabel(dr[i]) : ""}</td>
            <td className={`num${changed(dr[i]) ? " changed" : ""}`}>{dr[i] ? yen(dr[i].amount) : ""}</td>
            <td className={changed(cr[i]) ? "changed" : ""}>{cr[i] ? lineLabel(cr[i]) : ""}</td>
            <td className={`num${changed(cr[i]) ? " changed" : ""}`}>{cr[i] ? yen(cr[i].amount) : ""}</td>
            <td className="snap-memo">{dr[i]?.memo || cr[i]?.memo || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** 1つの仕訳の履歴を古い順に並べる */
export const EntryHistoryList = ({ records }: { records: HistoryRecord[] }) => {
  const asc = [...records].sort((a, b) => a.revision - b.revision);
  return (
    <ol className="history-list">
      {asc.map((r, i) => (
        <li key={r.id} className={`history-item act-${r.action}`}>
          <div className="history-meta">
            <span className={`badge badge-${r.action}`}>{ACTION_LABEL[r.action]}</span>
            <span>第{r.revision}版</span>
            <span className="muted">{r.recorded_at}</span>
            {r.reason && <span className="history-reason">理由：{r.reason}</span>}
          </div>
          <SnapshotTable snap={r.snapshot} compare={r.action === "update" ? asc[i - 1]?.snapshot : undefined} />
        </li>
      ))}
    </ol>
  );
};
