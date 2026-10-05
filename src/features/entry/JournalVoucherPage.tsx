import { useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { VoucherForm } from "./VoucherForm";
import { useAppContext } from "../../context/AppContext";
import { defaultDateInYear } from "../../lib/format";

/** 振替伝票（新規入力） */
export const JournalVoucherPage = () => {
  const { year } = useAppContext();
  // 登録後もフォームを作り直して、日付だけ引き継ぐ
  const [key, setKey] = useState(0);
  const [date, setDate] = useState(defaultDateInYear(year));

  return (
    <div className="page">
      <PageHeader
        title="振替伝票"
        note="複数の科目にまたがる取引もこちらで入力します。Enter で次の欄へ、⌘＋Enter で登録。"
      />
      <section className="sheet">
        <VoucherForm
          key={`${year}-${key}`}
          initialDate={date.startsWith(`${year}-`) ? date : defaultDateInYear(year)}
          onSaved={(d) => {
            setDate(d);
            setKey((k) => k + 1);
          }}
        />
      </section>
    </div>
  );
};
