/**
 * 証憑の一覧
 * 取引年月日・取引金額（範囲指定）と取引先を組み合わせて検索できる（電子取引データの検索要件）
 */
import { useEffect, useMemo, useState } from "react";
import { Download, FilePlus2, FolderDown, Search, ShieldCheck } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { FullDateInput } from "../../components/Inputs";
import { EvidenceAddModal, EvidenceModal } from "./EvidenceModals";
import { EntryEditModal } from "../entry/EntryEditModal";
import { evidenceCsv, exportAll } from "./evidenceIO";
import { EVIDENCE_DOC_TYPES } from "../../constants/evidence";
import { filterEvidences } from "../../lib/evidence";
import { yearEnd, yearStart } from "../../lib/accounting";
import { parseAmount, yen } from "../../lib/format";
import type { Evidence } from "../../lib/types";
import * as repo from "../../db/repo";

export const EvidencePage = () => {
  const { db, year, settings, dataVersion, strict, counterparties } = useAppContext();
  const toast = useToast();
  const [all, setAll] = useState<Evidence[]>([]);
  const [dateFrom, setDateFrom] = useState(yearStart(year));
  const [dateTo, setDateTo] = useState(yearEnd(year));
  const [minAmt, setMinAmt] = useState("");
  const [maxAmt, setMaxAmt] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [docType, setDocType] = useState("");
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [check, setCheck] = useState<repo.EvidenceCheckResult[] | null>(null);

  useEffect(() => {
    repo.getEvidences(db).then(setAll).catch(console.error);
  }, [db, dataVersion]);

  // 年度を切り替えたら、日付の範囲もその年度にする
  useEffect(() => {
    setDateFrom(yearStart(year));
    setDateTo(yearEnd(year));
  }, [year]);

  const list = useMemo(
    () => filterEvidences(all, {
      dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
      amountMin: parseAmount(minAmt), amountMax: parseAmount(maxAmt),
      counterparty, docType, unlinkedOnly, includeVoid,
    }),
    [all, dateFrom, dateTo, minAmt, maxAmt, counterparty, docType, unlinkedOnly, includeVoid],
  );
  const total = list.filter((e) => !e.is_void).reduce((t, e) => t + e.amount, 0);

  const exportCsv = async () => {
    const path = await save({ defaultPath: `証憑一覧_${settings.business_name || "帳簿"}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, evidenceCsv(list, counterparties));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const exportFiles = async () => {
    try {
      const n = await exportAll(db, list, counterparties);
      if (n !== null) toast(`${n}件のファイルと一覧（CSV）を書き出しました`);
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const verify = async () => {
    try {
      setCheck(await repo.verifyEvidences(db));
    } catch (e) {
      toast(`確認できませんでした：${String(e)}`, "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="証憑"
        note="受け取った請求書・領収書などのファイルを保存し、仕訳とひも付けます。取引年月日・金額・取引先を組み合わせて検索できます。"
      >
        <button className="btn ghost" onClick={verify} disabled={all.length === 0}><ShieldCheck size={16} /> 改ざんの確認</button>
        <button className="btn ghost" onClick={exportCsv} disabled={list.length === 0}><Download size={16} /> CSV</button>
        <button className="btn ghost" onClick={exportFiles} disabled={list.length === 0}><FolderDown size={16} /> ファイルを書き出す</button>
        <button className="btn primary" onClick={() => setAdding(true)}><FilePlus2 size={16} /> 取り込む</button>
      </PageHeader>

      <div className="filters">
        <span className="filter-label">取引年月日</span>
        <FullDateInput value={dateFrom} onChange={setDateFrom} year={year} aria-label="取引年月日（から）" />
        <span>〜</span>
        <FullDateInput value={dateTo} onChange={setDateTo} year={year} aria-label="取引年月日（まで）" />
        <span className="filter-label">金額</span>
        <input className="input amount-filter" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} placeholder="下限" inputMode="numeric" aria-label="金額の下限" />
        <span>〜</span>
        <input className="input amount-filter" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="上限" inputMode="numeric" aria-label="金額の上限" />
        <label className="search">
          <Search size={15} />
          <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="取引先" aria-label="取引先" />
        </label>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="書類の種類">
          <option value="">すべての書類</option>
          {EVIDENCE_DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} /> 仕訳にひも付いていないもの</label>
        <label className="check"><input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} /> {strict ? "無効も表示" : "（削除したものは残りません）"}</label>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {list.length === 0 ? (
            <p className="empty-note">{all.length === 0 ? "まだ証憑がありません。「取り込む」から追加してください。" : "条件に合う証憑がありません。"}</p>
          ) : (
            <table className="ledger">
              <colgroup>
                <col style={{ width: 56 }} /><col style={{ width: 104 }} /><col style={{ width: 70 }} /><col />
                <col style={{ width: 120 }} /><col style={{ width: "22%" }} /><col style={{ width: 110 }} />
              </colgroup>
              <thead>
                <tr><th>No</th><th>取引年月日</th><th>書類</th><th>取引先</th><th className="num">取引金額</th><th>ファイル</th><th>伝票No</th></tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className={`clickable${e.is_void ? " deleted" : ""}`} onClick={() => setViewing(e.id)} title="クリックで表示">
                    <td>{e.id}</td>
                    <td>{e.txn_date.replace(/-/g, "/")}</td>
                    <td>{e.doc_type}</td>
                    <td>{e.is_void ? <span className="badge badge-delete">無効</span> : null}{e.counterparty}</td>
                    <td className="num">{yen(e.amount)}</td>
                    <td className="muted ellipsis" title={e.file_name}>{e.file_name}</td>
                    <td>{e.entry_ids.length ? e.entry_ids.join("・") : <span className="muted">未</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="dock-foot">
          <span />
          <span className="dock-totals">{list.length}件　合計 <b>{yen(total)}</b></span>
        </div>
      </section>

      {adding && <EvidenceAddModal onClose={() => setAdding(false)} onAdded={() => {}} />}
      {viewing !== null && <EvidenceModal evidenceId={viewing} onClose={() => setViewing(null)} onOpenEntry={setOpenEntry} />}
      {openEntry !== null && <EntryEditModal entryId={openEntry} onClose={() => setOpenEntry(null)} />}
      {check && (
        <Modal title="改ざんの確認" onClose={() => setCheck(null)} width={640}>
          <p className="prose">
            保存しているファイルの中身からハッシュ（SHA-256）を計算し、登録したときの記録{strict ? "と、書き換えられない履歴の両方" : ""}と照らし合わせました。
          </p>
          {check.every((c) => c.status === "ok") ? (
            <p className="balance-banner ok">{check.length}件すべて、登録したときのまま変わっていません。</p>
          ) : (
            <>
              <p className="balance-banner ng">{check.filter((c) => c.status !== "ok").length}件で、登録したときの記録と一致しませんでした。</p>
              <ul className="check-list">
                {check.filter((c) => c.status !== "ok").map((c) => <li key={c.id}>No.{c.id}：{c.detail}</li>)}
              </ul>
            </>
          )}
        </Modal>
      )}
    </div>
  );
};
