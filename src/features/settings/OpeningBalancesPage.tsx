/**
 * 期首残高の設定
 * 開業した年や、他のソフトから乗り換えた年は、1月1日時点の残高をここで入れます。
 * 補助科目がある科目は、補助科目ごとに入れます（科目の金額は合計で表示）。
 * 2年目以降は「事業者設定」の繰越処理で自動的に作られます。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Save, Calculator } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { AmountInput } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { openingDifference } from "../../lib/accounting";
import { enterToNext } from "../../lib/keyboard";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import { subKey, type Account, type OpeningBalances, type SubOpeningBalances } from "../../lib/types";
import * as repo from "../../db/repo";

export const OpeningBalancesPage = () => {
  const { db, year, accounts, subAccounts, bump } = useAppContext();
  const { subOpening, loading } = useYearData();
  const toast = useToast();
  const [values, setValues] = useState<SubOpeningBalances>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!loading) {
      setValues(subOpening);
      setDirty(false);
    }
  }, [subOpening, loading]);

  const set = (key: string, v: number | null) => {
    setValues((s) => ({ ...s, [key]: v ?? 0 }));
    setDirty(true);
  };

  /** 科目ごとの合計 */
  const byAccount = useMemo(() => {
    const out: OpeningBalances = {};
    for (const [k, v] of Object.entries(values)) {
      const acc = Number(k.split(":")[0]);
      out[acc] = (out[acc] ?? 0) + v;
    }
    return out;
  }, [values]);

  const subsOf = (a: Account) =>
    subAccounts.filter((s) => s.account_id === a.id && (s.is_active || values[subKey(a.id, s.id)]));

  const left = accounts.filter((a) => a.category === "asset");
  const right = accounts.filter((a) => a.category === "liability" || a.category === "equity");
  const diff = openingDifference(accounts, byAccount);
  const capital = accounts.find((a) => a.code === CODE.CAPITAL)!;

  const fillCapital = () => {
    const k = subKey(capital.id, null);
    set(k, (values[k] ?? 0) + diff.difference);
  };

  const save = async () => {
    try {
      await repo.saveOpening(db, year, values);
      bump();
      setDirty(false);
      toast(`${year}年の期首残高を保存しました`);
    } catch (e) {
      toast(`保存できませんでした：${String(e)}`, "error");
    }
  };

  const nav = enterToNext();
  const column = (title: string, items: Account[], total: number) => (
    <table className="ledger opening-table">
      <thead>
        <tr><th>{title}</th><th className="num">金額</th></tr>
      </thead>
      <tbody>
        {items.filter((a) => a.is_active || byAccount[a.id]).map((a) => {
          const subs = subsOf(a);
          const note = (a.code === CODE.OWNER_DRAW || a.code === CODE.OWNER_LOAN) && <span className="hint">通常は 0</span>;
          if (subs.length === 0) {
            const k = subKey(a.id, null);
            return (
              <tr key={a.id}>
                <td>{a.name}{note}</td>
                <td><AmountInput value={values[k] || null} onChange={(v) => set(k, v)} onKeyDown={nav} aria-label={a.name} /></td>
              </tr>
            );
          }
          const rows = [
            ...subs.map((sb) => ({ key: subKey(a.id, sb.id), label: sb.name })),
            { key: subKey(a.id, null), label: "補助なし" },
          ];
          return (
            <Fragment key={a.id}>
              <tr className="opening-parent">
                <td>{a.name}</td>
                <td className="num">{yen(byAccount[a.id] ?? 0)}</td>
              </tr>
              {rows.map((r) => (
                <tr key={r.key} className="opening-sub">
                  <td className="indent">{r.label}</td>
                  <td><AmountInput value={values[r.key] || null} onChange={(v) => set(r.key, v)} onKeyDown={nav} aria-label={`${a.name} ${r.label}`} /></td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr><td>合計</td><td className="num">{yen(total)}</td></tr>
      </tfoot>
    </table>
  );

  return (
    <div className="page">
      <PageHeader title="期首残高" note={`${year}年1月1日時点の残高です。資産の合計と、負債・資本の合計を一致させます。`}>
        <button className="btn ghost" onClick={fillCapital} disabled={diff.difference === 0}>
          <Calculator size={16} /> 差額を元入金にする
        </button>
        <button className="btn primary" onClick={save} disabled={!dirty}>
          <Save size={16} /> 保存する
        </button>
      </PageHeader>

      <div className={`balance-banner ${diff.difference === 0 ? "ok" : "ng"}`} role="status">
        {diff.difference === 0
          ? "貸借が一致しています"
          : `資産が ${yen(Math.abs(diff.difference))} 円${diff.difference > 0 ? "多い" : "少ない"}状態です`}
      </div>

      <section className="sheet">
        <div className="opening-grid" data-navgroup>
          {column("資産", left, diff.debit)}
          {column("負債・資本", right, diff.credit)}
        </div>
      </section>
    </div>
  );
};
