import { FilePlus2, FolderOpen, FileClock, X } from "lucide-react";
import { useId, useState } from "react";
import { getRecentFiles, removeRecentFile } from "../../db/database";
import { APP_NAME } from "../../constants/appConfig";
// @ts-ignore
import pkg from "../../../package.json";

/**
 * chi のロゴ：帳簿色の角丸に、白の「chi」。
 * 下の二重線は帳簿の締切線（合計の下に引く二重線）から。
 */
export const Logo = ({ size = 96 }: { size?: number }) => {
  const uid = useId().replace(/:/g, "");
  const grad = `chi-grad-${uid}`;
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden>
      <defs>
        <linearGradient id={grad} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#002D62" />
          <stop offset="100%" stopColor="#1D4F91" />
        </linearGradient>
      </defs>
      <rect className="logo-body" x="56" y="56" width="400" height="400" rx="90" fill={`url(#${grad})`} />
      <g className="logo-mark" fill="#fff">
        <text
          x="256" y="292" textAnchor="middle"
          fontFamily="Georgia, 'Times New Roman', 'Hiragino Mincho ProN', serif"
          fontSize="176" fontWeight="700" letterSpacing="-4"
        >chi</text>
        <rect x="150" y="334" width="212" height="12" rx="3" />
        <rect x="150" y="358" width="212" height="12" rx="3" />
      </g>
    </svg>
  );
};

interface Props {
  onCreate: () => void;
  onOpen: () => void;
  onOpenPath: (path: string) => void;
  busy: boolean;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export const StartScreen = ({ onCreate, onOpen, onOpenPath, busy }: Props) => {
  const [recent, setRecent] = useState(getRecentFiles());

  return (
    <div className="start">
      <div className="start-card">
        <Logo />
        <h1 className="start-title">{APP_NAME}</h1>
        <p className="start-sub">個人事業主のための、手元で完結する帳簿</p>

        <div className="start-actions">
          <button className="btn primary lg" onClick={onCreate} disabled={busy}>
            <FilePlus2 size={18} /> 新しい帳簿を作る
          </button>
          <button className="btn ghost lg" onClick={onOpen} disabled={busy}>
            <FolderOpen size={18} /> 帳簿ファイルを開く
          </button>
        </div>

        {recent.length > 0 && (
          <div className="recent-files">
            <h2>最近開いた帳簿</h2>
            <ul>
              {recent.map((p) => (
                <li key={p}>
                  <button className="recent-file" onClick={() => onOpenPath(p)} disabled={busy} title={p}>
                    <FileClock size={16} />
                    <span>{fileName(p)}</span>
                  </button>
                  <button
                    className="icon-btn subtle"
                    aria-label={`${fileName(p)} を一覧から外す`}
                    onClick={() => {
                      removeRecentFile(p);
                      setRecent(getRecentFiles());
                    }}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="start-ver">ver {pkg.version}</p>
      </div>
    </div>
  );
};
