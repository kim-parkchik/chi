/**
 * 家事按分
 *  - 科目ごとに「事業で使っている割合」と方式を決める
 *    入力時：帳簿入力で支払いを入れた時点で、事業分と事業主貸に分ける
 *    年末一括：支払いは全額を経費で入れておき、年末にまとめて家事分を事業主貸へ振り替える
 *  - 割合はその年度から適用。前の年度の設定は残る（根拠のメモも残せる）
 */
import { useEffect, useMemo, useState } from "react";
import { Save, Wand2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { yearEndRows } from "../../lib/homeUse";
import { yearEnd } from "../../lib/accounting";
import { yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import type { HomeUseMethod, JournalLine } from "../../lib/types";
import * as repo from "../../db/repo";

interface Draft {
  rate: string;
  method: HomeUseMethod;
  basis: string;
}

/** 按分の対象にしやすい科目（よく按分するもの）。他の経費科目も設定できる */
const COMMON = ["地代家賃", "水道光熱費", "通信費", "車両費", "損害保険料", "減価償却費"];

export const HomeUsePage = () => {
  const { db, year, accounts, homeUseRates, reloadHomeUse, bump, strict, dataVersion, isClosed } = useAppContext();
  const { lines } = useYearData();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [runId, setRunId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    const d: Record<number, Draft> = {};
    for (const r of homeUseRates) d[r.account_id] = { rate: String(r.rate), method: r.method, basis: r.basis };
    setDrafts(d);
  }, [homeUseRates]);

  useEffect(() => {
    repo.getHomeUseRun(db, year).then(setRunId).catch(console.error);
  }, [db, year, dataVersion]);

  const expenses = accounts.filter((a) => a.category === "expense");
  const shown = expenses.filter(
    (a) => showAll || COMMON.includes(a.name) || homeUseRates.some((r) => r.account_id === a.id),
  );

  const saved = (id: number) => homeUseRates.find((r) => r.account_id === id);
  const draftOf = (id: number): Draft => drafts[id] ?? { rate: "100", method: "yearend", basis: "" };
  const dirty = (id: number) => {
    const s = saved(id);
    const d = draftOf(id);
    return s ? String(s.rate) !== d.rate || s.method !== d.method || s.basis !== d.basis : d.rate !== "100" || d.basis !== "";
  };
  const set = (id: number, patch: Partial<Draft>) => setDrafts((x) => ({ ...x, [id]: { ...draftOf(id), ...patch } }));

  const saveRow = async (id: number) => {
    const d = draftOf(id);
    const rate = Number(d.rate);
    if (!Number.isInteger(rate) || rate < 0 || rate > 100) return toast("割合は 0〜100 の整数で入れてください", "error");
    try {
      await repo.saveHomeUseRate(db, year, { account_id: id, rate, method: d.method, basis: d.basis });
    } catch (e) {
      return toast(`保存できませんでした：${String(e)}`, "error");
    }
    await reloadHomeUse();
    toast(`${year}年からの按分を保存しました`);
  };

  // ── 年末一括の振替 ──
  const rows = useMemo(() => yearEndRows(accounts, lines, homeUseRates, runId ?? undefined), [accounts, lines, homeUseRates, runId]);
  const privateTotal = rows.reduce((s, r) => s + r.private, 0);

  const runYearEnd = async () => {
    const draw = accounts.find((a) => a.code === CODE.OWNER_DRAW)!;
    const targets = rows.filter((r) => r.private > 0);
    if (targets.length === 0) return;
    const ok = await ask(
      `${year}年12月31日付で、家事分 ${yen(privateTotal)} 円を事業主貸へ振り替える仕訳を${runId ? "作り直します" : "作ります"}。`,
      { title: "家事按分の振替", okLabel: runId ? "作り直す" : "作成する", cancelLabel: "やめる" },
    );
    if (!ok) return;
    const memo = `家事按分（年末振替）`;
    const lines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: draw.id, sub_account_id: null, amount: privateTotal, memo },
      ...targets.map((r, i) => ({
        row_no: i + 1, side: "credit" as const, account_id: r.account.id, sub_account_id: null, amount: r.private,
        memo: `${memo} ${r.account.name} 家事分 ${100 - r.rate.rate}%`,
      })),
    ];
    try {
      await repo.saveHomeUseRunEntry(db, year, yearEnd(year), lines, runId ?? null);
      bump();
      toast("家事按分の振替仕訳を作成しました");
    } catch (e) {
      toast(`作成できませんでした：${String(e)}`, "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="家事按分"
        note={`事業とプライベートの両方で使っている費用の、事業で使っている割合を決めます。${year}年から適用され、前の年度の設定はそのまま残ります。${strict ? "変更は履歴に記録されます。" : ""}`}
      />

      <section className="sheet">
        <h2 className="sheet-h">科目ごとの按分</h2>
        <div className="table-wrap">
          <table className="ledger homeuse-table">
            <colgroup>
              <col style={{ width: "16%" }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 150 }} />
              <col />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr><th>科目</th><th className="num">事業の割合</th><th>方式</th><th>根拠（あとで見返すためのメモ）</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((a) => {
                const d = draftOf(a.id);
                const s = saved(a.id);
                return (
                  <tr key={a.id} className={s && s.rate < 100 ? "homeuse-on" : ""}>
                    <td>
                      {a.name}
                      {s && s.from_year < year && <span className="hint">{s.from_year}年から</span>}
                    </td>
                    <td>
                      <div className="rate-input">
                        <input className="input" inputMode="numeric" value={d.rate} onChange={(e) => set(a.id, { rate: e.target.value.replace(/\D/g, "").slice(0, 3) })} aria-label={`${a.name}の事業割合`} />
                        <span>%</span>
                      </div>
                    </td>
                    <td>
                      <select className="input" value={d.method} onChange={(e) => set(a.id, { method: e.target.value as HomeUseMethod })} aria-label={`${a.name}の按分方式`}>
                        <option value="yearend">年末にまとめて</option>
                        <option value="entry">入力のたびに</option>
                      </select>
                    </td>
                    <td>
                      <input className="input" value={d.basis} onChange={(e) => set(a.id, { basis: e.target.value })} placeholder="例：床面積 20㎡ ／ 60㎡、使用時間 1日8時間 など" maxLength={100} />
                    </td>
                    <td>
                      <button className="btn ghost small-btn" disabled={isClosed || !dirty(a.id)} onClick={() => saveRow(a.id)}><Save size={14} /> 保存</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> ほかの経費科目も表示
        </label>
        <p className="field-note" style={{ marginTop: 8 }}>
          100% は按分しない（全額事業）という意味です。「入力のたびに」にした科目は、帳簿入力で支払いを入れると自動で事業分と事業主貸に分かれます。
          端数は事業分を切り捨てます。
        </p>
      </section>

      <section className="sheet">
        <div className="sheet-title">
          <h2 className="sheet-h" style={{ margin: 0 }}>年末の振替（{year}年）</h2>
          {runId && <button className="link-btn" onClick={() => setViewing(runId)}>作成済みの仕訳（No.{runId}）を見る</button>}
        </div>
        {rows.length === 0 ? (
          <p className="muted">「年末にまとめて」で按分する科目はありません。</p>
        ) : (
          <>
            <table className="ledger">
              <thead>
                <tr><th>科目</th><th className="num">事業の割合</th><th className="num">年間の計上額</th><th className="num">事業分</th><th className="num">家事分（事業主貸へ）</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.account.id}>
                    <td>{r.account.name}</td>
                    <td className="num">{r.rate.rate}%</td>
                    <td className="num">{yen(r.total)}</td>
                    <td className="num">{yen(r.business)}</td>
                    <td className="num">{yen(r.private)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={4} className="total-label">家事分の合計</td><td className="num">{yen(privateTotal)}</td></tr>
              </tfoot>
            </table>
            <div className="voucher-actions" style={{ marginTop: 12 }}>
              <p className="field-note">
                12月31日付で「事業主貸 ／ 各科目」の仕訳を1本作ります。年の途中でも作成でき、あとで「作り直す」と同じ仕訳が最新の金額に訂正されます。
              </p>
              <div className="spacer" />
              <button className="btn primary" onClick={runYearEnd} disabled={isClosed || privateTotal === 0}>
                <Wand2 size={16} /> {runId ? "振替仕訳を作り直す" : "振替仕訳を作成する"}
              </button>
            </div>
          </>
        )}
      </section>

      {viewing && <EntryEditModal entryId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};
