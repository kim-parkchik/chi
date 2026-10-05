import { useEffect, useState } from "react";
import { Modal } from "../../components/Modal";
import { VoucherForm } from "./VoucherForm";
import { EntryHistoryList } from "../books/HistoryView";
import { useAppContext } from "../../context/AppContext";
import { linesToRows } from "../../lib/accounting";
import type { HistoryRecord, JournalEntry } from "../../lib/types";
import * as repo from "../../db/repo";

/** 既存の仕訳を振替伝票の形で開いて訂正・削除する。下に履歴を表示 */
export const EntryEditModal = ({ entryId, onClose }: { entryId: number; onClose: () => void }) => {
  const { db, strict } = useAppContext();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    repo.getEntry(db, entryId).then(setEntry).catch(console.error);
    repo.getHistory(db, entryId).then(setHistory).catch(console.error);
  }, [db, entryId]);

  const deleted = entry?.is_deleted === 1;

  return (
    <Modal title={deleted ? `削除済みの仕訳（No.${entryId}）` : strict ? "仕訳の訂正" : "仕訳の修正"} onClose={onClose} width={1080}>
      {!entry ? (
        <p className="muted">読み込んでいます…</p>
      ) : deleted ? (
        <p className="notice">この仕訳は削除されています。削除済みの仕訳は変更できません。経緯は下の履歴で確認できます。</p>
      ) : (
        <VoucherForm
          entryId={entry.id}
          initialDate={entry.date}
          initialRows={linesToRows(entry.lines)}
          onSaved={onClose}
          onDeleted={onClose}
          onCancel={onClose}
        />
      )}

      {strict && history.length > 0 && (
        <section className="history-section">
          <button className="link-btn" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory || deleted}>
            {showHistory || deleted ? "▾" : "▸"} この仕訳の履歴（{history.length}件
            {history.length > 1 ? `・訂正 ${history.filter((h) => h.action === "update").length}回` : ""}）
          </button>
          {(showHistory || deleted) && <EntryHistoryList records={history} />}
        </section>
      )}
    </Modal>
  );
};
