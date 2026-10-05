/**
 * 仕訳の訂正画面に出す「証憑」欄
 * 1つの仕訳に複数の証憑、1つの証憑を複数の仕訳にひも付けられる
 */
import { useEffect, useState } from "react";
import { FilePlus2, Link2, Paperclip, X } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { EvidenceAddModal, EvidenceModal, EvidencePickerModal } from "./EvidenceModals";
import { yen } from "../../lib/format";
import type { Evidence, JournalEntry } from "../../lib/types";
import * as repo from "../../db/repo";

export const EntryEvidenceSection = ({ entry }: { entry: JournalEntry }) => {
  const { db, bump, dataVersion } = useAppContext();
  const toast = useToast();
  const [list, setList] = useState<Evidence[]>([]);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const readOnly = entry.is_deleted === 1;
  const amount = entry.lines.filter((l) => l.side === "debit").reduce((t, l) => t + l.amount, 0);

  useEffect(() => {
    repo.getEntryEvidences(db, entry.id).then(setList).catch(console.error);
  }, [db, entry.id, dataVersion]);

  const unlink = async (id: number) => {
    try {
      await repo.unlinkEvidence(db, id, entry.id);
      bump();
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <section className="history-section entry-evidence">
      <div className="entry-evidence-head">
        <h3 className="sub-h"><Paperclip size={14} /> 証憑（{list.filter((e) => !e.is_void).length}件）</h3>
        {!readOnly && (
          <>
            <button className="btn ghost sm" onClick={() => setAdding(true)}><FilePlus2 size={14} /> 取り込んでひも付ける</button>
            <button className="btn ghost sm" onClick={() => setPicking(true)}><Link2 size={14} /> 登録済みから選ぶ</button>
          </>
        )}
      </div>
      {list.length > 0 && (
        <table className="ledger compact">
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className={`clickable${e.is_void ? " deleted" : ""}`} onClick={() => setViewing(e.id)} title="クリックで表示">
                <td style={{ width: 60 }}>No.{e.id}</td>
                <td style={{ width: 100 }}>{e.txn_date.replace(/-/g, "/")}</td>
                <td style={{ width: 70 }}>{e.doc_type}</td>
                <td>{e.counterparty}{e.is_void ? <span className="badge badge-delete" style={{ marginLeft: 6 }}>無効</span> : null}</td>
                <td className="num" style={{ width: 110 }}>{yen(e.amount)}</td>
                <td style={{ width: 36 }}>
                  {!readOnly && !e.is_void && (
                    <button className="icon-btn" onClick={(ev) => { ev.stopPropagation(); unlink(e.id); }} aria-label="ひも付けを外す" title="ひも付けを外す"><X size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <EvidenceAddModal
          defaults={{ txn_date: entry.date, amount }}
          onClose={() => setAdding(false)}
          onAdded={(id) => repo.linkEvidence(db, id, entry.id)}
        />
      )}
      {picking && <EvidencePickerModal entryId={entry.id} date={entry.date} amount={amount} onClose={() => setPicking(false)} />}
      {viewing !== null && <EvidenceModal evidenceId={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
};
