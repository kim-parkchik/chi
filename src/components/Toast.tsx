import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CircleCheck, CircleAlert } from "lucide-react";

type Kind = "ok" | "error";
interface ToastItem { id: number; kind: Kind; text: string }

const ToastCtx = createContext<(text: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((text: string, kind: Kind = "ok") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.filter((x) => x.kind === "error").slice(-1), { id, kind, text }]); // 成功通知は最新1件だけ
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "ok" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
};
