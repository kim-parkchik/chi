import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

/** 開いているモーダルの重なり順。Esc でいちばん上のものだけ閉じる */
const stack: symbol[] = [];

export const Modal = ({ title, onClose, children, width = 900 }: Props) => {
  // 開いた順を保つため、登録は最初の1回だけ（onClose は毎回変わりうるので ref で最新を使う）
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = Symbol("modal");
    stack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === me) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(me), 1);
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
};
