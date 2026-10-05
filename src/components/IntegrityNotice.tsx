/**
 * 帳簿を開いたときの改ざんの確認（厳密モード）
 * 証憑ファイルの中身までは見ない軽い確認だけを行い、問題があれば画面上部で知らせる
 */
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import * as repo from "../db/repo";

export const IntegrityNotice = ({ goHistory }: { goHistory: () => void }) => {
  const { db, strict } = useAppContext();
  const [count, setCount] = useState({ errors: 0, warns: 0 });

  useEffect(() => {
    if (!strict) return;
    repo.verifyIntegrity(db)
      .then((r) => setCount({
        errors: r.issues.filter((i) => i.level === "error").length,
        warns: r.issues.filter((i) => i.level === "warn").length,
      }))
      .catch(console.error);
  }, [db, strict]);

  if (count.errors === 0 && count.warns === 0) return null;
  return (
    <div className="year-notice">
      <div className={`year-notice-row ${count.errors ? "danger" : "warn"}`}>
        <ShieldAlert size={15} />
        <span>
          {count.errors
            ? `帳簿ファイルが、ソフトを通さずに変更された可能性があります（${count.errors}件）。`
            : `確認が必要な記録があります（${count.warns}件）。`}
        </span>
        <button className="btn ghost sm" onClick={goHistory}>詳しく見る（訂正・削除履歴）</button>
      </div>
    </div>
  );
};
