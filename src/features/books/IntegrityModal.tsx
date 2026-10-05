/**
 * 改ざんの確認（厳密モード）
 *  - 記録の連鎖・今の中身・証憑ファイルを確かめる
 *  - 今の「確認コード」を表示・書き出す（ファイルの外に控えてもらう。有料のタイムスタンプを付けてもよい）
 *  - 控えておいた確認コードが、今の連鎖の中にあるかを確かめる
 */
import { useEffect, useState } from "react";
import { Copy, FileDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { useAppContext } from "../../context/AppContext";
import * as repo from "../../db/repo";

/** 確認コードを書き出す内容（タイムスタンプを付ける対象にもなる） */
export const anchorText = (p: { business: string; file: string; head: { id?: number; row_hash: string; recorded_at: string }; label?: string }) =>
  [
    "chi 確認コード",
    p.label ? `対象：${p.label}` : "",
    `屋号：${p.business}`,
    `帳簿ファイル：${p.file}`,
    p.head.id ? `記録の連鎖：No.${p.head.id}（${p.head.recorded_at}）` : `記録日時：${p.head.recorded_at}`,
    `確認コード：${repo.anchorCode(p.head.row_hash)}`,
    `連鎖の先頭（SHA-256）：${p.head.row_hash}`,
    "",
    "このファイルは帳簿ファイルとは別の場所に保管してください。",
    "あとで chi の「改ざんの確認」に確認コードを入れると、この時点から帳簿が作り直されていないかを確かめられます。",
  ].filter((x) => x !== "").join("\r\n") + "\r\n";

export const saveAnchorFile = async (text: string, defaultName: string) => {
  const path = await save({ defaultPath: defaultName, filters: [{ name: "テキスト", extensions: ["txt"] }] });
  if (!path) return false;
  await writeTextFile(path, text);
  return true;
};

export const IntegrityModal = ({ onClose }: { onClose: () => void }) => {
  const { db, settings, filePath } = useAppContext();
  const toast = useToast();
  const [report, setReport] = useState<repo.IntegrityReport | null>(null);
  const [code, setCode] = useState("");
  const [anchorResult, setAnchorResult] = useState<string | null>(null);

  useEffect(() => {
    repo.verifyIntegrity(db, { files: true }).then(setReport).catch((e) => toast(`確認できませんでした：${String(e)}`, "error"));
  }, [db, toast]);

  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const errors = report?.issues.filter((i) => i.level === "error") ?? [];
  const warns = report?.issues.filter((i) => i.level === "warn") ?? [];

  const checkAnchor = async () => {
    try {
      const hit = await repo.findAnchor(db, code);
      setAnchorResult(hit
        ? `見つかりました。記録の連鎖 No.${hit.id}（${hit.recorded_at}）です。控えた時点から、それより前の記録は作り直されていません。`
        : "見つかりません。控えた時点より後に、帳簿が作り直された可能性があります（コードの写し間違いでないかも確かめてください）。");
    } catch (e) {
      setAnchorResult(String(e).replace(/^Error: /, ""));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("コピーしました");
    } catch {
      toast("コピーできませんでした", "error");
    }
  };

  return (
    <Modal title="改ざんの確認" onClose={onClose} width={760}>
      {!report ? <p className="muted">確かめています…</p> : (
        <div className="settings-form">
          {errors.length === 0 && warns.length === 0 ? (
            <p className="balance-banner ok"><ShieldCheck size={15} /> 問題は見つかりませんでした（記録 {report.length}件・証憑ファイルを確認）。</p>
          ) : (
            <>
              {errors.length > 0 && <p className="balance-banner ng"><ShieldAlert size={15} /> 改ざんの疑いがあります（{errors.length}件）</p>}
              <ul className="check-list">
                {errors.map((i, n) => <li key={`e${n}`}>{i.message}</li>)}
                {warns.map((i, n) => <li key={`w${n}`} className="warn-text">{i.message}</li>)}
              </ul>
            </>
          )}
          <p className="prose">
            帳簿ファイルは、ソフトを通さずに書き換えること自体は防げません。ここでは、履歴の書き換え・削除や、履歴を残さない変更を
            「記録の連鎖」で見つけます。ただし、連鎖をまるごと作り直されると中だけでは見抜けないため、下の確認コードをファイルの外に控えておいてください。
          </p>

          {report.head && (
            <>
              <h3 className="sub-h">今の確認コード</h3>
              <div className="anchor-box">
                <code className="anchor-code">{repo.anchorCode(report.head.row_hash)}</code>
                <span className="muted">記録の連鎖 No.{report.head.id}（{report.head.recorded_at}）</span>
                <button className="btn ghost sm" onClick={() => copy(repo.anchorCode(report.head!.row_hash))}><Copy size={14} /> コピー</button>
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    const ok = await saveAnchorFile(anchorText({ business: settings.business_name, file: fileName, head: report.head! }), `確認コード_${settings.business_name || "帳簿"}_${report.head!.recorded_at.slice(0, 10)}.txt`);
                    if (ok) toast("書き出しました");
                  }}
                ><FileDown size={14} /> 書き出す</button>
              </div>
              <p className="field-note">書き出したファイルに有料のタイムスタンプを付けておくと、いつの時点の帳簿かを第三者に示せます。</p>
            </>
          )}

          <h3 className="sub-h">控えておいた確認コードを確かめる</h3>
          <form className="anchor-check" onSubmit={(e) => { e.preventDefault(); checkAnchor(); }}>
            <input className="input mono" value={code} onChange={(e) => { setCode(e.target.value); setAnchorResult(null); }} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
            <button className="btn primary" type="submit" disabled={!code.trim()}>確かめる</button>
          </form>
          {anchorResult && <p className="prose">{anchorResult}</p>}
        </div>
      )}
    </Modal>
  );
};
