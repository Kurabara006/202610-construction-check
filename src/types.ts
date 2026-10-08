export interface RecordEntry {
  id: string;
  createdAt: number;
  comment: string;
  /** MIME type, e.g. image/jpeg */
  photoType: string;
  /** Raw image bytes */
  photoBlob: Blob;
}

export interface RecordEntryExport {
  id: string;
  createdAt: number;
  comment: string;
  photoType: string;
  /** Base64 without data URL prefix */
  photoBase64: string;
}

export const EXPORT_VERSION = 1 as const;

export interface ExportBundle {
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  entries: RecordEntryExport[];
}
