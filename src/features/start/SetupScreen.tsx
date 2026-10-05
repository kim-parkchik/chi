/**
 * 新しい帳簿の初期設定
 *  - 事業者の情報（あとから変更できる）
 *  - 電子帳簿保存法モード（あとから変更できない）
 */
import { useState } from "react";
import { ShieldCheck, NotebookPen } from "lucide-react";
import type Database from "../../db/connection";
import { Logo } from "./StartScreen";
import { SettingsForm } from "../settings/BusinessSettingsPage";
import type { EBookMode, Settings } from "../../lib/types";
import * as repo from "../../db/repo";

export const MODE_LABEL: Record<EBookMode, string> = {
  strict: "電子帳簿保存法に対応（優良な電子帳簿）",
  standard: "通常",
};

interface Props {
  db: Database;
  settings: Settings;
  onDone: (s: Settings) => void;
  onBack: () => void;
}

export const SetupScreen = ({ db, settings, onDone, onBack }: Props) => {
  const [mode, setMode] = useState<EBookMode>(settings.e_book_mode ?? "strict");
  const needsInfo = !settings.business_name;
  const needsMode = !settings.e_book_mode;

  const finish = async (s: Settings) => {
    if (needsInfo) await repo.saveSettings(db, s);
    if (needsMode) {
      await repo.setEBookMode(db, mode);
      await repo.initChain(db); // 厳密モードなら、ここから記録の連鎖を始める
    }
    onDone(await repo.getSettings(db));
  };

  const modePicker = (
    <fieldset className="mode-picker">
      <legend>帳簿の保存方式<span className="mode-warn">あとから変更できません</span></legend>
      <label className={`mode-card${mode === "strict" ? " on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "strict"} onChange={() => setMode("strict")} />
        <ShieldCheck size={22} />
        <div>
          <strong>{MODE_LABEL.strict}<span className="rec">おすすめ</span></strong>
          <p>仕訳・勘定科目・期首残高の訂正や削除をすべて履歴に残します。削除した仕訳も「削除済み」として記録され、消えません。勘定科目の名前を変えても、過去の年度は元の名前のままです。</p>
        </div>
      </label>
      <label className={`mode-card${mode === "standard" ? " on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "standard"} onChange={() => setMode("standard")} />
        <NotebookPen size={22} />
        <div>
          <strong>{MODE_LABEL.standard}</strong>
          <p>履歴を残しません。削除した仕訳は完全に消え、科目名の変更はすべての年度に反映されます。練習用や、とりあえず試したいとき向けです。</p>
        </div>
      </label>
    </fieldset>
  );

  return (
    <div className="start">
      <div className="start-card setup-card">
        <Logo size={64} />
        <h1 className="start-title">はじめに</h1>
        <p className="start-sub">
          {needsInfo ? "帳簿の持ち主の情報と、保存方式を決めてください。事業者の情報はあとから「事業者設定」で変えられます。" : "この帳簿の保存方式を決めてください。"}
        </p>
        {needsInfo ? (
          <SettingsForm initial={settings} submitLabel="帳簿をはじめる" onSubmit={finish} extra={modePicker} />
        ) : (
          <>
            {modePicker}
            <button className="btn primary" onClick={() => finish(settings)}>この方式で決定する</button>
          </>
        )}
        <button className="link-btn" onClick={onBack}>戻る</button>
      </div>
    </div>
  );
};
