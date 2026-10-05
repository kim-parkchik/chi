const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

interface Props {
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
}

/** 月の範囲選択（1月〜12月） */
export const MonthRange = ({ from, to, onChange }: Props) => (
  <div className="month-range">
    <select value={from} onChange={(e) => onChange(Number(e.target.value), Math.max(Number(e.target.value), to))} aria-label="開始月">
      {MONTHS.map((m) => <option key={m} value={m}>{m}月</option>)}
    </select>
    <span>〜</span>
    <select value={to} onChange={(e) => onChange(Math.min(from, Number(e.target.value)), Number(e.target.value))} aria-label="終了月">
      {MONTHS.map((m) => <option key={m} value={m}>{m}月</option>)}
    </select>
    <button className="link-btn" onClick={() => onChange(1, 12)}>通期</button>
  </div>
);

/** 単月 or 全期間の切り替え（帳簿用） */
export const MonthTabs = ({ value, onChange }: { value: number; onChange: (m: number) => void }) => (
  <div className="month-tabs" role="tablist">
    <button role="tab" aria-selected={value === 0} className={value === 0 ? "on" : ""} onClick={() => onChange(0)}>全期間</button>
    {MONTHS.map((m) => (
      <button key={m} role="tab" aria-selected={value === m} className={value === m ? "on" : ""} onClick={() => onChange(m)}>
        {m}
      </button>
    ))}
  </div>
);
