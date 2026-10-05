/** 証憑の書類の種類（選択肢） */
export const EVIDENCE_DOC_TYPES = ["請求書", "領収書", "納品書", "見積書", "注文書", "契約書", "その他"] as const;

/**
 * 取り込めるファイルの種類。中身で判定する（判定のしかたは lib/evidence.ts の detectFileType）
 * 保存は受け取ったファイルのまま（変換しない）。preview は画面での表示のしかた
 *  - pdf / image：そのまま表示（表示できない環境では「書き出して開く」）
 *  - text：文字として表示（CSV・XML など）
 *  - none：表示しない（書き出して開く）
 */
export type EvidencePreviewKind = "pdf" | "image" | "text" | "none";
export interface EvidenceFileType {
  mime: string;
  ext: string;
  label: string;
  preview: EvidencePreviewKind;
}

export const EVIDENCE_FILE_TYPES: EvidenceFileType[] = [
  { mime: "application/pdf", ext: "pdf", label: "PDF", preview: "pdf" },
  { mime: "image/jpeg", ext: "jpg", label: "JPEG", preview: "image" },
  { mime: "image/png", ext: "png", label: "PNG", preview: "image" },
  { mime: "image/heic", ext: "heic", label: "HEIC", preview: "image" },
  { mime: "image/heif", ext: "heif", label: "HEIF", preview: "image" },
  { mime: "image/gif", ext: "gif", label: "GIF", preview: "image" },
  { mime: "image/webp", ext: "webp", label: "WebP", preview: "image" },
  { mime: "image/tiff", ext: "tif", label: "TIFF", preview: "image" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", label: "Excel", preview: "none" },
  { mime: "application/vnd.ms-excel", ext: "xls", label: "Excel（旧形式）", preview: "none" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", label: "Word", preview: "none" },
  { mime: "application/msword", ext: "doc", label: "Word（旧形式）", preview: "none" },
  { mime: "application/zip", ext: "zip", label: "ZIP", preview: "none" },
  { mime: "application/xml", ext: "xml", label: "XML", preview: "text" },
  { mime: "text/csv", ext: "csv", label: "CSV", preview: "text" },
  { mime: "text/plain", ext: "txt", label: "テキスト", preview: "text" },
];

export const fileTypeOf = (mime: string) => EVIDENCE_FILE_TYPES.find((t) => t.mime === mime);

/** 画面の案内に出す、おもな形式 */
export const EVIDENCE_MAIN_FORMATS = "PDF・画像（JPEG・PNG・HEIC など）・Excel・CSV・XML など";

export const EVIDENCE_KIND_LABEL = { electronic: "電子取引", scan: "スキャナ保存" } as const;
