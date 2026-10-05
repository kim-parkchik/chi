import type { ReactNode } from "react";

export const PageHeader = ({ title, note, children }: { title: string; note?: string; children?: ReactNode }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {note && <p className="page-note">{note}</p>}
    </div>
    {children && <div className="page-actions">{children}</div>}
  </div>
);
