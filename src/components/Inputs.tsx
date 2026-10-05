/**
 * 会計入力用の部品
 * どれも「打って Enter」で確定できるよう、テキスト入力ベースで作っています。
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { Account } from "../lib/types";
import { parseAmount, parseDateInput, shortDate, toHalfWidth } from "../lib/format";
import { useAppContext } from "../context/AppContext";
import { TAX_CODES, TAX_DISABLED_NOTE } from "../constants/tax";

type NavProps = {
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
};

// ────────────────────────────────────────────
// 勘定科目
// ────────────────────────────────────────────

/** コード・科目名・よみがなのどれでも探せる */
const resolveAccount = (text: string, accounts: Account[]): Account | null => {
  const s = toHalfWidth(text).trim();
  if (!s) return null;
  const exact = accounts.find((a) => `${a.code} ${a.name}` === s || a.code === s || a.name === s);
  if (exact) return exact;
  const hits = accounts.filter(
    (a) => a.code.startsWith(s) || a.name.startsWith(s) || a.kana.startsWith(s),
  );
  return hits.length === 1 ? hits[0] : null;
};

interface AccountInputProps extends NavProps {
  value: number | null;
  onChange: (id: number | null) => void;
  /** 候補を絞りたいとき（帳簿入力の科目選択など） */
  accounts?: Account[];
}

export const AccountInput = ({ value, onChange, accounts, ...rest }: AccountInputProps) => {
  const { activeAccounts, accountMap } = useAppContext();
  const list = accounts ?? activeAccounts;
  const listId = useId();
  const nameOf = (id: number | null) => (id ? accountMap.get(id)?.name ?? "" : "");
  const [text, setText] = useState(nameOf(value));
  const [focused, setFocused] = useState(false);

  // 外から値が変わったとき（フォームのリセットなど）に表示を合わせる
  useEffect(() => {
    if (!focused) setText(nameOf(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    setFocused(false);
    const hit = resolveAccount(text, list);
    if (hit) {
      setText(hit.name);
      if (hit.id !== value) onChange(hit.id);
    } else if (!text.trim()) {
      if (value !== null) onChange(null);
    } else {
      onChange(null);
    }
  };

  const invalid = !focused && text.trim() !== "" && value === null;

  return (
    <>
      <input
        {...rest}
        data-nav
        className={`input account-input${invalid ? " invalid" : ""}`}
        list={listId}
        value={text}
        placeholder="科目"
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const hit = list.find((a) => `${a.code} ${a.name}` === e.target.value);
          if (hit) {
            setText(hit.name);
            onChange(hit.id);
          }
        }}
        onBlur={commit}
      />
      <datalist id={listId}>
        {list.map((a) => (
          <option key={a.id} value={`${a.code} ${a.name}`} />
        ))}
      </datalist>
    </>
  );
};

// ────────────────────────────────────────────
// 金額
// ────────────────────────────────────────────

interface AmountInputProps extends NavProps {
  value: number | null;
  onChange: (v: number | null) => void;
}

export const AmountInput = ({ value, onChange, ...rest }: AmountInputProps) => {
  const [text, setText] = useState(value == null ? "" : value.toLocaleString("ja-JP"));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value == null ? "" : value.toLocaleString("ja-JP"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      {...rest}
      data-nav
      inputMode="numeric"
      className={`input amount-input${!focused && text && parseAmount(text) == null ? " invalid" : ""}`}
      value={text}
      onFocus={(e) => {
        // 表示中の「3,300」のまま全選択する（カンマ付きでも parseAmount で読める）。
        // ここで値を書き換えたり選択を遅らせたりすると、素早く打った数字が消えるので注意。
        setFocused(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseAmount(e.target.value));
      }}
      onBlur={() => {
        setFocused(false);
        const v = parseAmount(text);
        setText(v == null ? text : v.toLocaleString("ja-JP"));
      }}
    />
  );
};

// ────────────────────────────────────────────
// 日付（4/15・0415・15 などで入力できる）
// ────────────────────────────────────────────

interface DateInputProps extends NavProps {
  value: string;
  onChange: (iso: string) => void;
  year: number;
}

export const DateInput = ({ value, onChange, year, ...rest }: DateInputProps) => {
  const [text, setText] = useState(shortDate(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(shortDate(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const month = Number(value.slice(5, 7)) || 1;
    const iso = parseDateInput(text, year, month);
    if (iso && iso.startsWith(`${year}-`)) {
      setInvalid(false);
      setText(shortDate(iso));
      if (iso !== value) onChange(iso);
    } else {
      setInvalid(true);
    }
  };

  return (
    <input
      {...rest}
      data-nav
      className={`input date-input${invalid ? " invalid" : ""}`}
      value={text}
      title={`${year}年の日付。4/15・0415・15（当月）の形で入力できます`}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
};

// ────────────────────────────────────────────
// 摘要（過去の入力から候補を出す）
// ────────────────────────────────────────────

interface MemoInputProps extends NavProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export const MemoInput = ({ value, onChange, placeholder = "摘要", ...rest }: MemoInputProps) => {
  const { memoSuggestions } = useAppContext();
  const listId = useId();
  return (
    <>
      <input
        {...rest}
        data-nav
        className="input memo-input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {memoSuggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
};

// ────────────────────────────────────────────
// 税区分（免税事業者のあいだは「対象外」で固定・グレー表示）
// ────────────────────────────────────────────

export const TaxSelect = ({ label }: { label: string }) => {
  const { settings } = useAppContext();
  const locked = settings.tax_status === "exempt";
  return (
    <select className="input tax-select" value="none" disabled={locked} title={locked ? TAX_DISABLED_NOTE : undefined} aria-label={label} tabIndex={locked ? -1 : 0} onChange={() => {}}>
      {TAX_CODES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
    </select>
  );
};

// ────────────────────────────────────────────
// 補助科目（科目に補助が無いときは「—」でグレー）
// ────────────────────────────────────────────

interface SubSelectProps {
  accountId: number | null;
  value: number | null;
  onChange: (v: number | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLSelectElement>) => void;
  "aria-label"?: string;
}

export const SubSelect = ({ accountId, value, onChange, onKeyDown, ...rest }: SubSelectProps) => {
  const { activeSubsOf, subMap } = useAppContext();
  const subs = activeSubsOf(accountId);
  // 非表示にした補助が既存仕訳で使われている場合も表示できるようにする
  const current = value ? subMap.get(value) : undefined;
  const options = current && !subs.some((s) => s.id === current.id) ? [current, ...subs] : subs;
  const none = options.length === 0;

  // 科目を変えて、今の補助がその科目のものでなくなったら外す
  useEffect(() => {
    if (value && current && current.account_id !== accountId) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  return (
    <select
      {...rest}
      data-nav={none ? undefined : true}
      className="input sub-select"
      value={value ?? ""}
      disabled={none}
      tabIndex={none ? -1 : 0}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      onKeyDown={onKeyDown}
    >
      <option value="">{none ? "—" : "（なし）"}</option>
      {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
};

/** 科目＋補助科目（補助がある科目を選んだときだけ、下に補助の選択が出る） */
export const AccountWithSub = ({
  accountId, subId, onAccount, onSub, onKeyDown, label, accounts,
}: {
  accountId: number | null;
  subId: number | null;
  onAccount: (id: number | null) => void;
  onSub: (id: number | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  label: string;
  accounts?: Account[];
}) => {
  const { activeSubsOf, subMap } = useAppContext();
  const hasSubs = activeSubsOf(accountId).length > 0 || (subId != null && subMap.get(subId)?.account_id === accountId);
  return (
    <div className="acct-cell">
      <AccountInput value={accountId} onChange={onAccount} onKeyDown={onKeyDown} aria-label={label} accounts={accounts} />
      {hasSubs && <SubSelect accountId={accountId} value={subId} onChange={onSub} onKeyDown={onKeyDown} aria-label={`${label}の補助科目`} />}
    </div>
  );
};
