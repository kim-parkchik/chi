/**
 * 画面上部のお知らせ
 *  - 表示中の年度が締め済み
 *  - 期首残高が前年の繰越額とずれている（前の年度を直したあと、繰越をやり直していない）
 */
import { Lock, TriangleAlert } from "lucide-react";
import { useAppContext, useCarryForwardCheck } from "../context/AppContext";

interface Props {
  goSettings: () => void;
  switchYear: (y: number) => void;
}

export const YearNotice = ({ goSettings, switchYear }: Props) => {
  const { year, isClosed, labelOf } = useAppContext();
  const checks = useCarryForwardCheck();

  const names = (keys: string[]) => {
    const list = keys.map((k) => {
      const [acc, sub] = k.split(":").map(Number);
      return labelOf(acc, sub || null);
    });
    return list.length > 3 ? `${list.slice(0, 3).join("、")} ほか${list.length - 3}件` : list.join("、");
  };

  if (!isClosed && checks.length === 0) return null;
  return (
    <div className="year-notice">
      {isClosed && (
        <div className="year-notice-row closed">
          <Lock size={15} />
          <span>{year}年は締め済みです。仕訳・期首残高・家事按分は変更できません。</span>
          <button className="btn ghost sm" onClick={goSettings}>締めの解除（事業者設定）</button>
        </div>
      )}
      {checks.map((c) => (
        <div key={c.from} className="year-notice-row warn">
          <TriangleAlert size={15} />
          <span>
            {c.to}年の期首残高が、{c.from}年の期末残高と一致しません（{names(c.mismatches.map((m) => m.key))}）。
            {c.from}年の帳簿を直した場合は、繰越をやり直してください。
          </span>
          {c.from === year
            ? <button className="btn ghost sm" onClick={goSettings}>繰越へ（事業者設定）</button>
            : <button className="btn ghost sm" onClick={() => switchYear(c.from)}>{c.from}年に切り替える</button>}
        </div>
      ))}
    </div>
  );
};
