/**
 * 事業者設定 と 年度の繰越
 */
import { useEffect, useState, type ReactNode } from "react";
import { Save, ArrowRightLeft, Lock, LockOpen, FileDown } from "lucide-react";
import { anchorText, saveAnchorFile } from "../books/IntegrityModal";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { carryForwardWithSubs, closingBalances, subClosingBalances, summarizeIncome } from "../../lib/accounting";
import { subKey } from "../../lib/types";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import type { FilingType, Settings } from "../../lib/types";
import * as repo from "../../db/repo";
import { MODE_LABEL } from "../start/SetupScreen";
import { APP_DIR_NAME, BACKUP_DIR_NAME, EXT_BACKUP, MAX_BACKUP_GENERATIONS } from "../../constants/appConfig";
import { TAX_METHOD_OPTIONS, TAX_STATUS_OPTIONS } from "../../constants/tax";
import type { TaxMethod, TaxStatus } from "../../lib/types";

export const FILING_LABEL: Record<FilingType, string> = {
  blue65: "青色申告（65万円控除）",
  blue55: "青色申告（55万円控除）",
  blue10: "青色申告（10万円控除）",
  white: "白色申告",
};

export const SettingsForm = ({ initial, onSubmit, submitLabel, extra }: {
  initial: Settings;
  onSubmit: (s: Settings) => Promise<void>;
  submitLabel: string;
  /** 送信ボタンの直前に差し込む欄（初期設定の保存方式など） */
  extra?: ReactNode;
}) => {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(s);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>屋号</span>
        <input className="input" value={s.business_name} onChange={(e) => set("business_name", e.target.value)} placeholder="例：山田デザイン事務所" required />
      </label>
      <label className="field">
        <span>氏名</span>
        <input className="input" value={s.owner_name} onChange={(e) => set("owner_name", e.target.value)} placeholder="例：山田 太郎" />
      </label>
      <label className="field">
        <span>業種</span>
        <input className="input" value={s.industry} onChange={(e) => set("industry", e.target.value)} placeholder="例：デザイン業" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>会計年度</span>
          <input className="input" type="number" min={2000} max={2100} value={s.fiscal_year} onChange={(e) => set("fiscal_year", Number(e.target.value))} />
        </label>
        <label className="field">
          <span>申告の種類</span>
          <select className="input" value={s.filing_type} onChange={(e) => set("filing_type", e.target.value as FilingType)}>
            {Object.entries(FILING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="tax-fieldset">
        <legend>消費税</legend>
        <div className="field-row">
          <label className="field">
            <span>課税区分</span>
            <select className="input" value={s.tax_status} onChange={(e) => set("tax_status", e.target.value as TaxStatus)}>
              {TAX_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={!o.enabled}>{o.label}{o.enabled ? "" : "（準備中）"}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>経理方式</span>
            <select className="input" value={s.tax_method} onChange={(e) => set("tax_method", e.target.value as TaxMethod)} disabled={s.tax_status === "exempt"}>
              {TAX_METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={!o.enabled}>{o.label}{o.enabled ? "" : "（準備中）"}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-note">いまは免税事業者（税込経理）のみ対応しています。課税事業者向けの機能は今後追加します。</p>
      </fieldset>
      {extra}
      <div>
        <button className="btn primary" type="submit" disabled={busy}>
          <Save size={16} /> {submitLabel}
        </button>
      </div>
    </form>
  );
};

export const BusinessSettingsPage = () => {
  const { db, settings, year, accounts, closings, reloadSettings, bump } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();

  const end = closingBalances(accounts, opening, lines);
  const income = summarizeIncome(accounts, end).income;
  const next = carryForwardWithSubs(accounts, end, subClosingBalances(accounts, subOpening, lines));
  const capital = accounts.find((a) => a.code === CODE.CAPITAL)!;

  const runCarryForward = async () => {
    const nextYear = year + 1;
    if (closings.some((c) => c.fiscal_year === nextYear)) {
      toast(`${nextYear}年は締め済みのため、期首残高を書き換えられません。先に${nextYear}年の締めを解除してください。`, "error");
      return;
    }
    const exists = await repo.hasOpening(db, nextYear);
    const ok = await ask(
      (exists
        ? `${nextYear}年の期首残高はすでにあります。${year}年末の残高で上書きして、${nextYear}年に切り替えますか？`
        : `${year}年末の残高を ${nextYear}年の期首残高として繰り越し、${nextYear}年に切り替えます。`) +
        `\n繰り越すと ${year}年は締め済みになります。`,
      { title: "繰越処理", kind: exists ? "warning" : "info", okLabel: "繰り越す", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      // 期首残高の保存と締めを1つのトランザクションで（途中で失敗したら両方取り消す）
      await repo.carryForward(db, year, next);
    } catch (e) {
      toast(`繰り越せませんでした：${String(e)}`, "error");
      return;
    }
    await repo.saveSettings(db, { ...settings, fiscal_year: nextYear });
    await reloadSettings();
    bump();
    toast(`${nextYear}年に繰り越しました`);
  };

  return (
    <div className="page">
      <PageHeader title="事業者設定" />
      <div className="settings-layout">
        <section className="sheet">
          <h2 className="sheet-h">事業者の情報</h2>
          <SettingsForm
            key={JSON.stringify(settings)}
            initial={settings}
            submitLabel="保存する"
            onSubmit={async (s) => {
              await repo.saveSettings(db, s);
              await reloadSettings();
              toast("設定を保存しました");
            }}
          />
        </section>

        <section className="sheet">
          <h2 className="sheet-h">帳簿の保存方式</h2>
          <p className="mode-current">
            {settings.e_book_mode ? MODE_LABEL[settings.e_book_mode] : "未設定"}
          </p>
          <p className="prose">
            {settings.e_book_mode === "strict"
              ? "仕訳・勘定科目・期首残高の訂正と削除は「訂正・削除履歴」に記録されます。この方式は帳簿を作成したときに決めたもので、変更できません。"
              : "履歴を残さない方式です。この方式は帳簿を作成したときに決めたもので、変更できません。電子帳簿保存法に対応したい場合は、新しい帳簿を作成してください。"}
          </p>

          <h2 className="sheet-h">翌年への繰越</h2>
          <p className="prose">
            {year}年の帳簿を締めて、12月31日の残高を {year + 1}年1月1日の期首残高にします。
            事業主貸・事業主借は元入金に振り替えて 0 に戻します。補助科目ごとの残高も引き継ぎます。
            繰り越すと {year}年は締め済みになります。繰越は何度でもやり直せます。
          </p>
          <dl className="kv">
            <dt>{year}年の所得金額（控除前）</dt><dd className="num">{yen(income)}</dd>
            <dt>{year + 1}年の元入金</dt><dd className="num">{yen(next[subKey(capital.id, null)] ?? 0)}</dd>
          </dl>
          <button className="btn primary" onClick={runCarryForward}>
            <ArrowRightLeft size={16} /> {year + 1}年へ繰り越す
          </button>
        </section>

        <ClosingSection />
        <BackupSection />
      </div>
    </div>
  );
};

/**
 * 年度の締め
 *  - 繰越した年度は自動で締め済みになる。締め済みの年度は、仕訳・期首残高・家事按分を変更できない
 *  - 直すときは「締めを解除」を明示的に押す（厳密モードでは理由が必須で、履歴に残る）
 *  - 直し終えたら「締める」を押す。繰越をやり直したときも自動で締め直す
 */
const ClosingSection = () => {
  const { db, year, strict, closings, dataVersion, bump, settings, filePath } = useAppContext();
  const toast = useToast();
  const [years, setYears] = useState<number[]>([]);
  const [reopening, setReopening] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    repo.getYears(db, year).then(setYears).catch(console.error);
  }, [db, year, dataVersion]);

  const all = [...new Set([...years, ...closings.map((c) => c.fiscal_year)])].sort((a, b) => b - a);
  const closingOfYear = (y: number) => closings.find((c) => c.fiscal_year === y);

  const close = async (y: number) => {
    try {
      await repo.closeYear(db, y, "手動で締め");
      bump();
      toast(`${y}年を締めました`);
    } catch (e) {
      toast(`締められませんでした：${String(e)}`, "error");
    }
  };

  const reopen = async (y: number, why: string) => {
    try {
      await repo.reopenYear(db, y, why);
      setReopening(null);
      setReason("");
      bump();
      toast(`${y}年の締めを解除しました。直し終えたら、もう一度締めてください`);
    } catch (e) {
      toast(`解除できませんでした：${String(e)}`, "error");
    }
  };

  const startReopen = async (y: number) => {
    if (strict) {
      setReason("");
      setReopening(y);
      return;
    }
    const ok = await ask(`${y}年の締めを解除して、変更できる状態にします。`, {
      title: "締めの解除", kind: "warning", okLabel: "解除する", cancelLabel: "やめる",
    });
    if (ok) await reopen(y, "");
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">年度の締め</h2>
      <p className="prose">
        締め済みの年度は、仕訳・期首残高・家事按分を変更できません。繰り越した年度は自動で締め済みになります。
        直すときは締めを解除し、直し終えたらもう一度締めてください。翌年の期首残高とずれた場合は、画面上部でお知らせします。
        {strict && "締めと解除は「訂正・削除履歴」に記録されます（解除には理由が必要です）。締めたときの確認コードは、決算書の控えなど帳簿ファイルの外に残しておいてください（改ざんの確認に使います）。"}
      </p>
      <table className="ledger closing-table">
        <thead>
          <tr><th>年度</th><th>状態</th><th>締めた日時</th>{strict && <th>確認コード</th>}<th></th></tr>
        </thead>
        <tbody>
          {all.map((y) => {
            const c = closingOfYear(y);
            return (
              <tr key={y}>
                <td>{y}年{y === year && <span className="hint">表示中</span>}</td>
                <td>{c ? <span className="status-closed"><Lock size={13} /> 締め済み</span> : <span className="status-open">未締め</span>}</td>
                <td className="muted">{c?.closed_at ?? ""}</td>
                {strict && (
                  <td>
                    {c?.chain_head && (
                      <span className="anchor-cell">
                        <code className="mono">{repo.anchorCode(c.chain_head)}</code>
                        <button
                          className="icon-btn"
                          title="確認コードを書き出す"
                          aria-label={`${y}年の確認コードを書き出す`}
                          onClick={async () => {
                            const head = { row_hash: c.chain_head, recorded_at: c.closed_at };
                            const text = anchorText({ business: settings.business_name, file: filePath.split(/[\\/]/).pop() ?? "", head, label: `${y}年の締め` });
                            if (await saveAnchorFile(text, `確認コード_${settings.business_name || "帳簿"}_${y}年締め.txt`)) toast("書き出しました");
                          }}
                        ><FileDown size={14} /></button>
                      </span>
                    )}
                  </td>
                )}
                <td>
                  {c
                    ? <button className="btn ghost sm" onClick={() => startReopen(y)}><LockOpen size={14} /> 締めを解除</button>
                    : <button className="btn ghost sm" onClick={() => close(y)}><Lock size={14} /> 締める</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {reopening !== null && (
        <Modal title={`${reopening}年の締めを解除`} onClose={() => setReopening(null)} width={520}>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              reopen(reopening, reason);
            }}
          >
            <p className="prose">
              解除すると、{reopening}年の仕訳・期首残高・家事按分を変更できるようになります。
              解除したことと理由は「訂正・削除履歴」に記録されます。
            </p>
            <label className="field">
              <span>解除の理由（必須）</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：12月分の売上の計上漏れを追加するため" autoFocus maxLength={200} />
            </label>
            <div>
              <button className="btn primary" type="submit" disabled={!reason.trim()}>
                <LockOpen size={16} /> 解除する
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
};

/** バックアップの世代数（帳簿を開くたびにバックアップを作り、古いものから消す） */
const BackupSection = () => {
  const { db } = useAppContext();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    repo.getBackupGenerations(db).then((n) => {
      setSaved(n);
      setValue(String(n));
    }).catch(console.error);
  }, [db]);

  const save = async () => {
    try {
      await repo.setBackupGenerations(db, Number(value));
      setSaved(Number(value));
      toast("バックアップの世代数を保存しました。次に帳簿を開いたときから適用されます");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">バックアップ</h2>
      <p className="prose">
        帳簿を開くたびに、書類フォルダの「{APP_DIR_NAME}/{BACKUP_DIR_NAME}」へ丸ごと複製（.{EXT_BACKUP}）を作ります。
        決めた世代数を超えたら、古いものから消します。
      </p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field">
          <span>残す世代数（1〜{MAX_BACKUP_GENERATIONS}）</span>
          <input className="input" type="number" min={1} max={MAX_BACKUP_GENERATIONS} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn primary" type="submit" disabled={saved === null || String(saved) === value}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>
    </section>
  );
};
