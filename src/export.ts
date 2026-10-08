import type { ExportBundle, RecordEntry, RecordEntryExport } from './types';
import { EXPORT_VERSION } from './types';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read blob'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

export async function entriesToExportBundle(
  entries: RecordEntry[],
): Promise<ExportBundle> {
  const exported: RecordEntryExport[] = await Promise.all(
    entries.map(async (e) => ({
      id: e.id,
      createdAt: e.createdAt,
      comment: e.comment,
      photoType: e.photoType,
      photoBase64: await blobToBase64(e.photoBlob),
    })),
  );
  return {
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    entries: exported,
  };
}

export function exportBundleToEntries(bundle: ExportBundle): RecordEntry[] {
  if (bundle.version !== EXPORT_VERSION) {
    throw new Error(`未対応のエクスポート形式: v${bundle.version}`);
  }
  return bundle.entries.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    comment: e.comment,
    photoType: e.photoType,
    photoBlob: base64ToBlob(e.photoBase64, e.photoType),
  }));
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function buildPrintableHtml(entries: RecordEntry[]): Promise<string> {
  const rows = await Promise.all(
    entries.map(async (e, index) => {
      const b64 = await blobToBase64(e.photoBlob);
      const src = `data:${e.photoType};base64,${b64}`;
      const when = new Date(e.createdAt).toLocaleString('ja-JP');
      const commentHtml = escapeHtml(e.comment).replace(/\n/g, '<br />');
      return `
        <article class="record">
          <header>
            <span class="num">${index + 1}</span>
            <time>${escapeHtml(when)}</time>
          </header>
          <figure>
            <img src="${src}" alt="記録 ${index + 1}" />
          </figure>
          <p class="comment">${commentHtml || '（コメントなし）'}</p>
        </article>`;
    }),
  );

  const title = `現場チェック記録 — ${new Date().toLocaleDateString('ja-JP')}`;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; color: #111; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    .meta { color: #555; font-size: 0.875rem; margin-bottom: 24px; }
    .record { break-inside: avoid; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #ddd; }
    .record header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .num { font-weight: 700; font-size: 1.1rem; }
    time { color: #666; font-size: 0.875rem; }
    img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #eee; }
    .comment { white-space: pre-wrap; line-height: 1.6; margin: 12px 0 0; }
    @media print {
      body { padding: 12px; }
      .record { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">件数: ${entries.length} — 印刷または PDF 保存してください</p>
  ${rows.join('\n')}
</body>
</html>`;
}

export function openPrintableReport(html: string): void {
  const win = window.open('', '_blank');
  if (!win) {
    alert('ポップアップがブロックされました。ブラウザの設定を確認してください。');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.onload = () => {
    win.print();
  };
}
