/**
 * 証憑の詳細・登録・選択のモーダル
 */
import { useEffect, useMemo, useState } from "react";
import { Ban, Download, Link2, Pencil, Search, Trash2, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { useAppContext } from "../../context/AppContext";
import { EvidenceForm } from "./EvidenceForm";
import { EvidencePreview } from "./EvidencePreview";
import { exportOne } from "./evidenceIO";
import { EVIDENCE_DOC_TYPES, EVIDENCE_KIND_LABEL } from "../../constants/evidence";
import { filterEvidences, formatBytes, rankCandidates } from "../../lib/evidence";
import { defaultDateInYear, longDate, yen } from "../../lib/format";
import type { Evidence, EvidenceAction, EvidenceHistoryRecord, EvidenceMeta } from "../../lib/types";
import * as repo from "../../db/repo";

export const EVIDENCE_ACTION_LABEL: Record<EvidenceAction, string> = {
  create: "登録", update: "訂正", void: "無効", link: "ひも付け", unlink: "ひも付け解除",
};
export const evidenceActionBadge = (a: EvidenceAction) => (a === "void" || a === "unlink" ? "delete" : a === "update" ? "update" : "create");

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

// ────────────────────────────────────────────
// 新しく取り込む
// ────────────────────────────────────────────
export const EvidenceAddModal = ({ defaults, onClose, onAdded }: {
  defaults?: Partial<EvidenceMeta>;
  onClose: () => void;
  onAdded: (id: number) => Promise<void> | void;
}) => {
  const { db, year, bump } = useAppContext();
  const toast = useToast();
  const initial: EvidenceMeta = {
    doc_type: defaults?.doc_type ?? EVIDENCE_DOC_TYPES[0], txn_date: defaults?.txn_date ?? defaultDateInYear(year),
    amount: defaults?.amount ?? 0, counterparty: defaults?.counterparty ?? "", memo: defaults?.memo ?? "",
  };
  return (
    <Modal title="証憑を取り込む" onClose={onClose} width={640}>
      <p className="prose">
        メールなどで受け取った請求書・領収書（電子取引データ）を取り込みます。取り込んだファイルはあとから差し替えられません。
        取引年月日・取引金額・取引先は、あとで探すための項目です（{year}年以外の日付も入れられます）。
      </p>
      <EvidenceForm
        initial={initial}
        withFile
        submitLabel="取り込む"
        onCancel={onClose}
        onSubmit={async (meta, file) => {
          const id = await repo.createEvidence(db, meta, file!);
          await onAdded(id);
          bump();
          toast(`証憑 No.${id} を取り込みました`);
          onClose();
        }}
      />
    </Modal>
  );
};

// ────────────────────────────────────────────
// 登録済みの証憑から選んでひも付ける
// ────────────────────────────────────────────
export const EvidencePickerModal = ({ entryId, date, amount, onClose }: {
  entryId: number;
  date: string;
  amount: number;
  onClose: () => void;
}) => {
  const { db, bump, dataVersion } = useAppContext();
  const toast = useToast();
  const [all, setAll] = useState<Evidence[]>([]);
  const [q, setQ] = useState("");
  const [unlinkedOnly, setUnlinkedOnly] = useState(true);

  useEffect(() => {
    repo.getEvidences(db).then(setAll).catch(console.error);
  }, [db, dataVersion]);

  const list = useMemo(
    () => rankCandidates(filterEvidences(all, { counterparty: q, unlinkedOnly }), date, amount).filter((e) => !e.entry_ids.includes(entryId)),
    [all, q, unlinkedOnly, date, amount, entryId],
  );

  const link = async (id: number) => {
    try {
      await repo.linkEvidence(db, id, entryId);
      bump();
      toast(`証憑 No.${id} をひも付けました`);
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  return (
    <Modal title={`伝票 No.${entryId} にひも付ける証憑を選ぶ`} onClose={onClose} width={860}>
      <div className="filters">
        <label className="search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="取引先で探す" autoFocus />
        </label>
        <label className="check"><input type="checkbox" checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} /> ひも付いていないものだけ</label>
        <span className="muted">金額が同じもの → 日付が近いものの順</span>
      </div>
      <div className="table-wrap scroll-y picker-list">
        {list.length === 0 ? <p className="empty-note">候補がありません。</p> : (
          <table className="ledger">
            <thead><tr><th>No</th><th>取引年月日</th><th>書類</th><th>取引先</th><th className="num">金額</th><th></th></tr></thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={e.amount === amount ? "match" : ""}>
                  <td>{e.id}</td>
                  <td>{e.txn_date.replace(/-/g, "/")}</td>
                  <td>{e.doc_type}</td>
                  <td>{e.counterparty}</td>
                  <td className="num">{yen(e.amount)}</td>
                  <td><button className="btn ghost sm" onClick={() => link(e.id)}><Link2 size={14} /> ひも付ける</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
};

// ────────────────────────────────────────────
// 詳細（表示・訂正・無効・ひも付けの解除・書き出し）
// ────────────────────────────────────────────
export const EvidenceModal = ({ evidenceId, onClose, onOpenEntry }: {
  evidenceId: number;
  onClose: () => void;
  /** 伝票番号を押したとき（仕訳を開く） */
  onOpenEntry?: (entryId: number) => void;
}) => {
  const { db, strict, bump, dataVersion, counterparties } = useAppContext();
  const toast = useToast();
  const [ev, setEv] = useState<Evidence | null>(null);
  const [history, setHistory] = useState<EvidenceHistoryRecord[]>([]);
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  useEffect(() => {
    repo.getEvidence(db, evidenceId).then(setEv).catch(console.error);
    if (strict) repo.getEvidenceHistory(db, evidenceId).then(setHistory).catch(console.error);
  }, [db, evidenceId, strict, dataVersion]);

  if (!ev) return <Modal title={`証憑 No.${evidenceId}`} onClose={onClose}><p className="muted">読み込んでいます…</p></Modal>;
  const isVoid = ev.is_void === 1;

  const unlink = async (entryId: number) => {
    try {
      await repo.unlinkEvidence(db, ev.id, entryId);
      bump();
      toast(`伝票 No.${entryId} とのひも付けを外しました`);
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const doVoid = async () => {
    if (strict && !voidReason.trim()) return toast("無効にする理由を入れてください", "error");
    if (!strict) {
      const ok = await ask("この証憑を削除します。元に戻せません。", { title: "証憑の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" });
      if (!ok) return;
    }
    try {
      await repo.voidEvidence(db, ev.id, voidReason);
      bump();
      toast(strict ? "証憑を無効にしました" : "証憑を削除しました");
      if (!strict) onClose();
      setVoiding(false);
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const doExport = async () => {
    try {
      if (await exportOne(db, ev)) toast("書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${errText(e)}`, "error");
    }
  };

  return (
    <Modal title={`証憑 No.${ev.id}${isVoid ? "（無効）" : ""}`} onClose={onClose} width={1180}>
      <div className="evidence-detail">
        <EvidencePreview evidence={ev} />
        <div className="evidence-side">
          {isVoid && <p className="notice">この証憑は {ev.voided_at} に無効にされました。内容と履歴は残っていますが、変更できません。</p>}
          {editing ? (
            <EvidenceForm
              initial={ev}
              withFile={false}
              askReason={strict}
              submitLabel="訂正する"
              onCancel={() => setEditing(false)}
              onSubmit={async (meta, _f, reason) => {
                await repo.updateEvidence(db, ev.id, meta, reason);
                bump();
                setEditing(false);
                toast("証憑を訂正しました");
              }}
            />
          ) : (
            <dl className="kv evidence-kv">
              <dt>区分</dt><dd>{EVIDENCE_KIND_LABEL[ev.kind]}</dd>
              <dt>書類</dt><dd>{ev.doc_type}</dd>
              <dt>取引年月日</dt><dd>{longDate(ev.txn_date)}</dd>
              <dt>取引金額</dt><dd className="num">{yen(ev.amount)} 円</dd>
              <dt>取引先</dt><dd>{ev.counterparty}</dd>
              {(() => {
                const inv = counterparties.find((c) => c.id === ev.counterparty_id)?.invoice_no;
                return inv ? <><dt>登録番号</dt><dd className="mono">{inv}</dd></> : null;
              })()}
              {ev.memo && <><dt>メモ</dt><dd>{ev.memo}</dd></>}
              <dt>ファイル</dt><dd className="wrap">{ev.file_name}（{formatBytes(ev.size)}）</dd>
              <dt>SHA-256</dt><dd className="hash" title={ev.sha256}>{ev.sha256}</dd>
              <dt>登録日時</dt><dd>{ev.created_at}</dd>
              {ev.updated_at !== ev.created_at && <><dt>更新日時</dt><dd>{ev.updated_at}</dd></>}
            </dl>
          )}

          <h3 className="sub-h">ひも付いている仕訳</h3>
          {ev.entry_ids.length === 0 ? <p className="muted">まだありません。仕訳の訂正画面からひも付けられます。</p> : (
            <ul className="link-chips">
              {ev.entry_ids.map((id) => (
                <li key={id}>
                  {onOpenEntry ? <button className="link-btn" onClick={() => onOpenEntry(id)}>伝票 No.{id}</button> : <span>伝票 No.{id}</span>}
                  {!isVoid && <button className="icon-btn" onClick={() => unlink(id)} aria-label={`伝票 No.${id} とのひも付けを外す`} title="ひも付けを外す"><X size={14} /></button>}
                </li>
              ))}
            </ul>
          )}

          {!editing && (
            <div className="voucher-actions">
              <button className="btn ghost" onClick={doExport}><Download size={16} /> 書き出す</button>
              <div className="spacer" />
              {!isVoid && <button className="btn ghost" onClick={() => setEditing(true)}><Pencil size={16} /> 訂正</button>}
              {!isVoid && (strict
                ? <button className="btn danger-ghost" onClick={() => setVoiding((v) => !v)}><Ban size={16} /> 無効にする</button>
                : <button className="btn danger-ghost" onClick={doVoid}><Trash2 size={16} /> 削除</button>)}
            </div>
          )}
          {voiding && !isVoid && (
            <form className="void-form" onSubmit={(e) => { e.preventDefault(); doVoid(); }}>
              <p className="prose">無効にすると、検索や仕訳のひも付けの対象から外れます。ファイルと履歴は残り、元には戻せません。</p>
              <input className="input" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="無効にする理由（例：二重に取り込んだため）" autoFocus maxLength={200} />
              <button className="btn danger-ghost" type="submit" disabled={!voidReason.trim()}><Ban size={16} /> 無効にする</button>
            </form>
          )}

          {strict && history.length > 0 && (
            <>
              <h3 className="sub-h">履歴</h3>
              <ol className="evidence-history">
                {[...history].reverse().map((h) => (
                  <li key={h.id}>
                    <span className={`badge badge-${evidenceActionBadge(h.action)}`}>{EVIDENCE_ACTION_LABEL[h.action]}</span>
                    <span className="muted">{h.recorded_at}</span>
                    {h.user_name && <span>{h.user_name}</span>}
                    <span>{h.snapshot.txn_date.replace(/-/g, "/")}・{yen(h.snapshot.amount)}円・{h.snapshot.counterparty}</span>
                    {h.reason && <span className="history-reason">{h.action === "link" || h.action === "unlink" ? h.reason : `理由：${h.reason}`}</span>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
