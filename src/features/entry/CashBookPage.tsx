/**
 * 帳簿入力（現金出納帳・預金出納帳など）
 * 1つの科目から見た「入金・出金」で入力する、いちばん手軽な入力画面です。
 * 入力した行は「この科目 ⇔ 相手科目」の2行の仕訳として保存されます。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { MonthTabs } from "../../components/MonthRange";
import { AccountWithSub, AmountInput, DateInput, MemoInput, TaxSelect } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "./EntryEditModal";
import { buildLedger, monthStart } from "../../lib/accounting";
import { enterToNext } from "../../lib/keyboard";
import { defaultDateInYear, shortDate, yen } from "../../lib/format";
import { CASHBOOK_CODES, CODE, isBalanceSheet } from "../../constants/accounts";
import * as repo from "../../db/repo";
import { subKey, type JournalLine } from "../../lib/types";
import { splitByRate } from "../../lib/homeUse";

/** 科目ごとの列見出し（一般的な出納帳に合わせる） */
const columnLabels = (code: string, normal: "debit" | "credit") => {
  if (code === "101") return { dr: "入金", cr: "出金" };
  if (["102", "103", "104"].includes(code)) return { dr: "預入", cr: "引出" };
  return normal === "debit" ? { dr: "増加", cr: "減少" } : { dr: "減少", cr: "増加" };
};

export const CashBookPage = () => {
  const { db, year, accounts, activeAccounts, accountMap, bump, activeSubsOf, labelOf, subMap, homeUseOf } = useAppContext();
  const { lines, opening, subOpening, loading } = useYearData();
  const toast = useToast();

  const cashId = accounts.find((a) => a.code === CODE.CASH)?.id ?? accounts[0].id;
  const [accountId, setAccountId] = useState(cashId);
  const [month, setMonth] = useState(0);
  /** 補助科目の帳簿：undefined = 全体、null = 補助なし、数値 = その補助 */
  const [bookSub, setBookSub] = useState<number | null | undefined>(undefined);
  const bookSubs = activeSubsOf(accountId);
  const selectAccount = (id: number) => {
    setAccountId(id);
    setBookSub(undefined);
  };
  const [editing, setEditing] = useState<number | null>(null);

  const account = accountMap.get(accountId)!;
  const labels = columnLabels(account.code, account.normal_side);
  const quick = activeAccounts.filter((a) => CASHBOOK_CODES.includes(a.code));
  const others = activeAccounts.filter((a) => isBalanceSheet(a.category) && !CASHBOOK_CODES.includes(a.code));

  // ── 表示する行 ──
  const { carried, rows } = useMemo(() => {
    const base = bookSub === undefined ? opening[account.id] ?? 0 : subOpening[subKey(account.id, bookSub)] ?? 0;
    const all = buildLedger(account, base, lines, accountMap, bookSub);
    if (month === 0) return { carried: base, rows: all };
    const start = monthStart(year, month);
    const prefix = all.filter((r) => r.date < start);
    const carried = prefix.length ? prefix[prefix.length - 1].balance : base;
    return { carried, rows: all.filter((r) => r.date.slice(5, 7) === String(month).padStart(2, "0")) };
  }, [account, opening, subOpening, lines, accountMap, month, year, bookSub]);

  const totals = rows.reduce((t, r) => ({ dr: t.dr + r.debit, cr: t.cr + r.credit }), { dr: 0, cr: 0 });

  // ── 入力行 ──
  const firstDate = () =>
    month === 0 ? defaultDateInYear(year) : `${year}-${String(month).padStart(2, "0")}-01`;
  const [date, setDate] = useState(firstDate());
  const [counterId, setCounterId] = useState<number | null>(null);
  const [counterSubId, setCounterSubId] = useState<number | null>(null);
  const [memo, setMemo] = useState("");
  const [dr, setDr] = useState<number | null>(null);
  const [cr, setCr] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!date.startsWith(`${year}-`)) setDate(firstDate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const inputRowRef = useRef<HTMLTableRowElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, accountId, month]);

  const save = async () => {
    setError("");
    if (!counterId) return setError("相手科目を選んでください");
    if (counterId === accountId) return setError("相手科目に同じ科目は使えません");
    if ((dr ?? 0) > 0 && (cr ?? 0) > 0) return setError(`${labels.dr}と${labels.cr}はどちらか一方に入力してください`);
    const amount = (dr ?? 0) || (cr ?? 0);
    if (amount <= 0) return setError("金額を入力してください");

    const isDebit = (dr ?? 0) > 0;
    const ownSub = typeof bookSub === "number" ? bookSub : null;
    const m = memo.trim();
    // この帳簿の科目側には、選んでいる補助科目をつける（全体表示のときは補助なし）
    const lines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: isDebit ? accountId : counterId, sub_account_id: isDebit ? ownSub : counterSubId, amount, memo: m },
      { row_no: 1, side: "credit", account_id: isDebit ? counterId : accountId, sub_account_id: isDebit ? counterSubId : ownSub, amount, memo: m },
    ];
    // 家事按分（入力のたびに）：支払った経費を、事業分と事業主貸に分ける
    if (split) {
      lines[0] = { ...lines[0], amount: split.business };
      lines.push({ row_no: 2, side: "debit", account_id: drawId, sub_account_id: null, amount: split.private, memo: m ? `${m}（家事分）` : "家事分" });
    }
    try {
      await repo.createEntry(db, date, lines);
      bump();
      toast("登録しました");
      setCounterId(null);
      setCounterSubId(null);
      setMemo("");
      setDr(null);
      setCr(null);
      // 続けて入力できるよう日付欄に戻る（日付は前回の値を残す）
      requestAnimationFrame(() => {
        const first = inputRowRef.current?.querySelector<HTMLInputElement>("[data-nav]");
        first?.focus();
        first?.select();
      });
    } catch (e) {
      toast(`登録できませんでした：${String(e)}`, "error");
    }
  };
  const nav = enterToNext(save);

  // 家事按分の対象か（出金で、相手が「入力のたびに」按分する経費科目のとき）
  const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)!.id;
  const hu = homeUseOf(counterId);
  const split =
    hu && hu.method === "entry" && (cr ?? 0) > 0 && !(dr ?? 0) && accountMap.get(counterId!)?.category === "expense"
      ? splitByRate(cr ?? 0, hu.rate)
      : null;

  return (
    <div className="page">
      <PageHeader title="帳簿入力" note="出納帳の形で入力します。日付は 4/15・0415・15（当月）のように打てます。">
        <MonthTabs value={month} onChange={setMonth} />
      </PageHeader>

      <div className="book-picker" role="tablist" aria-label="帳簿">
        {quick.map((a) => (
          <button key={a.id} role="tab" aria-selected={a.id === accountId} className={a.id === accountId ? "on" : ""} onClick={() => selectAccount(a.id)}>
            {a.name}
          </button>
        ))}
        <select
          className="book-other"
          value={others.some((a) => a.id === accountId) ? accountId : ""}
          onChange={(e) => e.target.value && selectAccount(Number(e.target.value))}
          aria-label="その他の科目"
        >
          <option value="">その他の科目…</option>
          {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      <section className="sheet sheet-fill">
        {bookSubs.length > 0 && (
          <div className="sub-picker" role="tablist" aria-label="補助科目">
            <span className="sub-picker-label">補助科目</span>
            <button role="tab" aria-selected={bookSub === undefined} className={bookSub === undefined ? "on" : ""} onClick={() => setBookSub(undefined)}>全体</button>
            {bookSubs.map((sb) => (
              <button key={sb.id} role="tab" aria-selected={bookSub === sb.id} className={bookSub === sb.id ? "on" : ""} onClick={() => setBookSub(sb.id)}>{sb.name}</button>
            ))}
            <button role="tab" aria-selected={bookSub === null} className={bookSub === null ? "on" : ""} onClick={() => setBookSub(null)}>補助なし</button>
          </div>
        )}
        <div className="table-wrap scroll-y" ref={scrollRef}>
          <table className="ledger book-table">
            <colgroup>
              <col style={{ width: 72 }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: 84 }} />
              <col />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>日付</th>
                <th>相手科目</th>
                <th className="tax-th">税区分</th>
                <th>摘要</th>
                <th className="num dr">{labels.dr}</th>
                <th className="num cr">{labels.cr}</th>
                <th className="num">残高</th>
              </tr>
            </thead>
            <tbody>
              <tr className="carried">
                <td />
                <td colSpan={5}>{month === 0 ? "前期より繰越" : "前月より繰越"}</td>
                <td className="num">{yen(carried)}</td>
              </tr>
              {rows.map((r, i) => (
                <tr key={`${r.entry_id}-${i}`} className="clickable" onClick={() => setEditing(r.entry_id)} title="クリックで修正">
                  <td>{shortDate(r.date)}</td>
                  <td>{r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter}</td>
                  <td className="tax-cell">対象外</td>
                  <td className="memo">
                    {bookSub === undefined && r.subId && <span className="sub-tag">{subMap.get(r.subId)?.name}</span>}
                    {r.memo}
                  </td>
                  <td className="num">{yen(r.debit, { blankZero: true })}</td>
                  <td className="num">{yen(r.credit, { blankZero: true })}</td>
                  <td className={`num${r.balance < 0 ? " negative" : ""}`}>{yen(r.balance)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr className="empty-row"><td colSpan={7}>まだ取引がありません。下の行から入力を始めてください。</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-wrap input-dock" data-navgroup>
          <table className="ledger book-table">
            <colgroup>
              <col style={{ width: 72 }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: 84 }} />
              <col />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <tbody>
              <tr ref={inputRowRef} className="input-row">
                <td><DateInput value={date} onChange={setDate} year={year} onKeyDown={nav} aria-label="日付" /></td>
                <td><AccountWithSub accountId={counterId} subId={counterSubId} onAccount={(v) => { setCounterId(v); setCounterSubId(null); }} onSub={setCounterSubId} onKeyDown={nav} label="相手科目" /></td>
                <td><TaxSelect label="税区分" /></td>
                <td><MemoInput value={memo} onChange={setMemo} onKeyDown={nav} aria-label="摘要" /></td>
                <td><AmountInput value={dr} onChange={setDr} onKeyDown={nav} aria-label={labels.dr} /></td>
                <td><AmountInput value={cr} onChange={setCr} onKeyDown={nav} aria-label={labels.cr} /></td>
                <td>
                  <button className="btn primary block" onClick={save}>
                    <CornerDownLeft size={15} /> 登録
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="dock-foot">
            <span className="form-error-inline" role="alert">
              {error ||
                (split ? (
                  <span className="homeuse-hint">家事按分 {hu!.rate}%：事業分 {yen(split.business)} ／ 事業主貸 {yen(split.private)} に分けて登録します</span>
                ) : bookSubs.length > 0 && bookSub === undefined ? (
                  <span className="muted">全体表示で入力すると「補助なし」で登録されます</span>
                ) : "")}
            </span>
            <span className="dock-totals">
              {month === 0 ? "期間" : `${month}月`}合計　{labels.dr} <b>{yen(totals.dr)}</b>　{labels.cr} <b>{yen(totals.cr)}</b>
            </span>
          </div>
        </div>
      </section>

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};
