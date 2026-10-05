/**
 * 事業者設定 と 年度の繰越
 */
import { useState, type ReactNode } from "react";
import { Save, ArrowRightLeft } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { carryForwardWithSubs, closingBalances, subClosingBalances, summarizeIncome } from "../../lib/accounting";
import { subKey } from "../../lib/types";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import type { FilingType, Settings } from "../../lib/types";
import * as repo from "../../db/repo";
import { MODE_LABEL } from "../start/SetupScreen";
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
  const { db, settings, year, accounts, reloadSettings, bump } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();

  const end = closingBalances(accounts, opening, lines);
  const income = summarizeIncome(accounts, end).income;
  const next = carryForwardWithSubs(accounts, end, subClosingBalances(accounts, subOpening, lines));
  const capital = accounts.find((a) => a.code === CODE.CAPITAL)!;

  const runCarryForward = async () => {
    const nextYear = year + 1;
    const exists = await repo.hasOpening(db, nextYear);
    const ok = await ask(
      exists
        ? `${nextYear}年の期首残高はすでにあります。${year}年末の残高で上書きして、${nextYear}年に切り替えますか？`
        : `${year}年末の残高を ${nextYear}年の期首残高として繰り越し、${nextYear}年に切り替えます。`,
      { title: "繰越処理", kind: exists ? "warning" : "info", okLabel: "繰り越す", cancelLabel: "やめる" },
    );
    if (!ok) return;
    await repo.saveOpening(db, nextYear, next, true);
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
            事業主貸・事業主借は元入金に振り替えて 0 に戻します。補助科目ごとの残高も引き継ぎます。何度でもやり直せます。
          </p>
          <dl className="kv">
            <dt>{year}年の所得金額（控除前）</dt><dd className="num">{yen(income)}</dd>
            <dt>{year + 1}年の元入金</dt><dd className="num">{yen(next[subKey(capital.id, null)] ?? 0)}</dd>
          </dl>
          <button className="btn primary" onClick={runCarryForward}>
            <ArrowRightLeft size={16} /> {year + 1}年へ繰り越す
          </button>
        </section>
      </div>
    </div>
  );
};
