/**
 * 証憑の登録・訂正フォーム
 * 取引年月日・取引金額・取引先は検索要件の項目なので必須
 */
import { useEffect, useId, useState } from "react";
import { FileUp, Save } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { EVIDENCE_DOC_TYPES, EVIDENCE_MAIN_FORMATS } from "../../constants/evidence";
import { MAX_EVIDENCE_BYTES } from "../../constants/appConfig";
import { formatBytes, sha256Hex, validateEvidenceFile, validateEvidenceMeta } from "../../lib/evidence";
import type { EvidenceMeta } from "../../lib/types";
import * as repo from "../../db/repo";

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

interface Props {
  initial: EvidenceMeta;
  /** 新規登録（ファイルを選ぶ欄を出す） */
  withFile: boolean;
  /** 訂正の理由を聞く（厳密モードの訂正） */
  askReason?: boolean;
  submitLabel: string;
  onSubmit: (meta: EvidenceMeta, file: PickedFile | null, reason: string) => Promise<void>;
  onCancel?: () => void;
}

export const EvidenceForm = ({ initial, withFile, askReason, submitLabel, onSubmit, onCancel }: Props) => {
  const { db, year, counterparties } = useAppContext();
  const [m, setM] = useState<EvidenceMeta>(initial);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dupOf, setDupOf] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();
  const set = <K extends keyof EvidenceMeta>(k: K, v: EvidenceMeta[K]) => setM((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    repo.getEvidenceCounterparties(db).then(setSuggestions).catch(console.error);
  }, [db]);

  const pick = async (f: File | undefined) => {
    setError("");
    setFile(null);
    setDupOf([]);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const err = validateEvidenceFile(bytes, f.name);
    if (err) return setError(err);
    setFile({ name: f.name, bytes });
    setDupOf(await repo.findEvidenceByHash(db, await sha256Hex(bytes)));
  };

  const submit = async () => {
    setError("");
    if (withFile && !file) return setError("ファイルを選んでください");
    const err = validateEvidenceMeta(m);
    if (err) return setError(err);
    if (askReason && !reason.trim()) return setError("訂正の理由を入れてください");
    setBusy(true);
    try {
      await onSubmit(m, file, reason);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {withFile && (
        <label className="field">
          <span>ファイル（{EVIDENCE_MAIN_FORMATS}。{formatBytes(MAX_EVIDENCE_BYTES)} まで。受け取ったファイルのまま保存します）</span>
          <input className="input file-input" type="file" onChange={(e) => pick(e.target.files?.[0])} />
          {file && <span className="field-note"><FileUp size={13} /> {file.name}（{formatBytes(file.bytes.length)}）</span>}
          {dupOf.length > 0 && (
            <span className="field-note warn-text">同じ中身のファイルが登録済みです（No.{dupOf.join("・")}）。二重に登録していないか確認してください。</span>
          )}
        </label>
      )}
      <div className="field-row">
        <label className="field">
          <span>書類の種類</span>
          <select className="input" value={m.doc_type} onChange={(e) => set("doc_type", e.target.value)}>
            {EVIDENCE_DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field">
          <span>取引年月日</span>
          <FullDateInput value={m.txn_date} onChange={(v) => set("txn_date", v)} year={year} aria-label="取引年月日" />
        </label>
        <label className="field">
          <span>取引金額（円）</span>
          <AmountInput value={m.amount} onChange={(v) => set("amount", v ?? 0)} aria-label="取引金額" />
        </label>
      </div>
      <label className="field">
        <span>取引先</span>
        <input className="input" list={listId} value={m.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="例：株式会社〇〇" maxLength={60} />
        <datalist id={listId}>
          {[...new Set([...counterparties.filter((c) => c.is_active).map((c) => c.name), ...suggestions])].map((s) => <option key={s} value={s} />)}
        </datalist>
        <span className="field-note">取引先一覧の名前と同じにすると、取引先（登録番号など）とつながります。</span>
      </label>
      <label className="field">
        <span>メモ（任意）</span>
        <input className="input" value={m.memo} onChange={(e) => set("memo", e.target.value)} maxLength={200} placeholder="例：1月分の外注費" />
      </label>
      {askReason && (
        <label className="field">
          <span>訂正の理由（必須・履歴に残ります）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="例：金額の入力ミス" />
        </label>
      )}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="voucher-actions">
        <div className="spacer" />
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>やめる</button>}
        <button className="btn primary" type="submit" disabled={busy}>
          <Save size={16} /> {submitLabel}
        </button>
      </div>
    </form>
  );
};
