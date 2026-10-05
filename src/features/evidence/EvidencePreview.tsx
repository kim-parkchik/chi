/**
 * 証憑の中身の表示
 * 保存しているファイルは受け取ったままで、表示のときだけ形式に合わせて見せ方を変える
 *  - PDF：埋め込み表示 ／ 画像：そのまま（HEIC は Mac なら表示できる。表示できない環境では案内を出す）
 *  - CSV・XML など：文字として表示 ／ Excel・Word・ZIP：表示しない（書き出して開く）
 */
import { useEffect, useState } from "react";
import { FileQuestion } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { fileTypeOf } from "../../constants/evidence";
import { decodeText } from "../../lib/evidence";
import type { Evidence } from "../../lib/types";
import * as repo from "../../db/repo";

/** 文字として表示する上限（大きな CSV で画面が重くならないように） */
const MAX_TEXT_CHARS = 200_000;

const CannotShow = ({ label, reason }: { label: string; reason: string }) => (
  <div className="evidence-frame evidence-noview">
    <FileQuestion size={36} />
    <p>{reason}</p>
    <p className="muted">「書き出す」で保存して、{label} を開けるアプリで確認してください。</p>
  </div>
);

export const EvidencePreview = ({ evidence }: { evidence: Pick<Evidence, "id" | "mime" | "file_name"> }) => {
  const { db } = useAppContext();
  const type = fileTypeOf(evidence.mime);
  const kind = type?.preview ?? "none";
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setText(null);
    setError("");
    setImgFailed(false);
    if (kind === "none") return;
    repo.getEvidenceBytes(db, evidence.id)
      .then((bytes) => {
        if (!alive) return;
        if (kind === "text") {
          const t = decodeText(bytes);
          setText(t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n\n…（長いので途中まで表示しています）` : t);
          return;
        }
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: evidence.mime }));
        setUrl(made);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [db, evidence.id, evidence.mime, kind]);

  const label = type?.label ?? "このファイル";
  if (error) return <p className="notice">{error}</p>;
  if (kind === "none") return <CannotShow label={label} reason={`${label} のファイルは画面に表示できません。`} />;
  if (kind === "text") return text === null ? <p className="muted evidence-frame">読み込んでいます…</p> : <pre className="evidence-frame evidence-text">{text}</pre>;
  if (!url) return <p className="muted evidence-frame">読み込んでいます…</p>;
  if (kind === "pdf") return <iframe className="evidence-frame" src={url} title={evidence.file_name} />;
  if (imgFailed) return <CannotShow label={label} reason={`この環境では ${label} の画像を表示できません（保存しているファイルはそのままです）。`} />;
  return (
    <div className="evidence-frame evidence-img-wrap">
      <img src={url} alt={evidence.file_name} onError={() => setImgFailed(true)} />
    </div>
  );
};
