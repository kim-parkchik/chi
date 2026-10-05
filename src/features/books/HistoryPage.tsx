/**
 * 訂正・削除履歴
 * すべての仕訳について「いつ・何を・どう変えたか（消したか）」を新しい順に一覧します。
 * 履歴はデータベース側で書き換え・削除ができないようにしてあります。
 */
import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { ACTION_LABEL, SnapshotTable } from "./HistoryView";
import type { HistoryAction, HistoryRecord, MasterHistoryRecord } from "../../lib/types";
import { yen } from "../../lib/format";
import * as repo from "../../db/repo";

type Filter = "all" | HistoryAction | "changes";

export const HistoryPage = () => {
  const { db, dataVersion, settings } = useAppContext();
  const toast = useToast();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("changes");
  const [entryNo, setEntryNo] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [kind, setKind] = useState<"entries" | "masters">("entries");
  const [masters, setMasters] = useState<MasterHistoryRecord[]>([]);

  useEffect(() => {
    repo.getHistory(db).then(setRecords).catch(console.error);
    repo.getMasterHistory(db).then(setMasters).catch(console.error);
  }, [db, dataVersion]);

  /** 訂正の比較元（同じ仕訳の1つ前の版） */
  const prevOf = useMemo(() => {
    const map = new Map<string, HistoryRecord>();
    for (const r of records) map.set(`${r.entry_id}:${r.revision}`, r);
    return (r: HistoryRecord) => map.get(`${r.entry_id}:${r.revision - 1}`);
  }, [records]);

  const shown = records.filter((r) => {
    if (entryNo && String(r.entry_id) !== entryNo.trim()) return false;
    if (filter === "all") return true;
    if (filter === "changes") return r.action !== "create";
    return r.action === filter;
  });

  const counts = {
    update: records.filter((r) => r.action === "update").length,
    delete: records.filter((r) => r.action === "delete").length,
  };

  const exportCsv = async () => {
    const esc = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
    const header = ["記録日時", "伝票No", "版", "操作", "理由", "日付", "借貸", "科目", "補助科目", "金額", "摘要"];
    const body = shown.flatMap((r) =>
      r.snapshot.lines.map((l) =>
        [r.recorded_at, r.entry_id, r.revision, ACTION_LABEL[r.action], r.reason, r.snapshot.date,
          l.side === "debit" ? "借方" : "貸方", l.account, l.sub, l.amount, l.memo].map(esc).join(","),
      ),
    );
    const path = await save({
      defaultPath: `訂正削除履歴_${settings.business_name || "帳簿"}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      await writeTextFile(path, "\uFEFF" + [header.map(esc).join(","), ...body].join("\r\n"));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="訂正・削除履歴"
        note="仕訳・勘定科目・期首残高を変更するたびに記録されます。この履歴は変更も削除もできません。"
      >
        {kind === "entries" && (
          <button className="btn ghost" onClick={exportCsv} disabled={shown.length === 0}>
            <Download size={16} /> CSV 書き出し
          </button>
        )}
      </PageHeader>

      <div className="kind-tabs" role="tablist">
        <button role="tab" aria-selected={kind === "entries"} className={kind === "entries" ? "on" : ""} onClick={() => setKind("entries")}>仕訳</button>
        <button role="tab" aria-selected={kind === "masters"} className={kind === "masters" ? "on" : ""} onClick={() => setKind("masters")}>
          勘定科目・期首残高（{masters.length}）
        </button>
      </div>

      {kind === "masters" ? <MasterHistoryTable records={masters} /> : <>
      <div className="filters">
        <div className="seg" role="tablist">
          {([
            ["changes", "訂正と削除"],
            ["update", `訂正（${counts.update}）`],
            ["delete", `削除（${counts.delete}）`],
            ["all", "登録も含む"],
          ] as [Filter, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <span>No.</span>
          <input value={entryNo} onChange={(e) => setEntryNo(e.target.value.replace(/\D/g, ""))} placeholder="伝票番号で絞る" style={{ width: 120 }} />
        </label>
        <span className="filter-count">{shown.length} 件</span>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {shown.length === 0 ? (
            <p className="empty-note">
              {filter === "changes" ? "まだ訂正・削除された仕訳はありません。" : "該当する履歴はありません。"}
            </p>
          ) : (
            <table className="ledger history-table">
              <colgroup>
                <col style={{ width: 170 }} />
                <col style={{ width: 64 }} />
                <col style={{ width: 70 }} />
                <col />
              </colgroup>
              <thead>
                <tr><th>記録日時</th><th className="num">No.</th><th>操作</th><th>内容</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEditing(r.entry_id)}>
                    <td className="muted">{r.recorded_at}</td>
                    <td className="num">{r.entry_id}</td>
                    <td>
                      <span className={`badge badge-${r.action}`}>{ACTION_LABEL[r.action]}</span>
                      <div className="muted small">第{r.revision}版</div>
                    </td>
                    <td><div className="history-content">
                      {r.reason && <div className="history-reason">理由：{r.reason}</div>}
                      {r.action === "update" && prevOf(r) && (
                        <div className="snap-before">
                          <span className="snap-tag">訂正前</span>
                          <SnapshotTable snap={prevOf(r)!.snapshot} />
                        </div>
                      )}
                      <div className="snap-after">
                        {r.action === "update" && <span className="snap-tag">訂正後</span>}
                        {r.action === "delete" && <span className="snap-tag">削除した内容</span>}
                        <SnapshotTable snap={r.snapshot} compare={r.action === "update" ? prevOf(r)?.snapshot : undefined} />
                      </div>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      </>}

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};

// ────────────────────────────────────────────
// 勘定科目・補助科目・期首残高の変更履歴
// ────────────────────────────────────────────
const TARGET_LABEL: Record<MasterHistoryRecord["target_type"], string> = { account: "勘定科目", sub: "補助科目", opening: "期首残高", homeuse: "家事按分" };
const MASTER_ACTION: Record<MasterHistoryRecord["action"], string> = {
  create: "追加", rename: "名前変更", hide: "非表示", show: "再表示", delete: "削除", change: "変更",
};

const MasterHistoryTable = ({ records }: { records: MasterHistoryRecord[] }) => {
  const detail = (r: MasterHistoryRecord) => {
    if (r.target_type === "opening") return `${yen(Number(r.old_value))} → ${yen(Number(r.new_value))}`;
    if (r.action === "rename" || r.action === "change") return `${r.old_value} → ${r.new_value}`;
    if (r.action === "create") return r.new_value;
    return "";
  };
  return (
    <section className="sheet sheet-fill">
      <div className="table-wrap scroll-y">
        {records.length === 0 ? (
          <p className="empty-note">まだ変更はありません。</p>
        ) : (
          <table className="ledger">
            <colgroup>
              <col style={{ width: 170 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: "26%" }} />
              <col />
            </colgroup>
            <thead>
              <tr><th>記録日時</th><th>年度</th><th>対象</th><th>操作</th><th>名称</th><th>内容</th></tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.recorded_at}</td>
                  <td>{r.fiscal_year}</td>
                  <td>{TARGET_LABEL[r.target_type]}</td>
                  <td><span className={`badge badge-${r.action === "delete" || r.action === "hide" ? "delete" : r.action === "create" || r.action === "show" ? "create" : "update"}`}>{MASTER_ACTION[r.action]}</span></td>
                  <td>{r.label}</td>
                  <td>{detail(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
