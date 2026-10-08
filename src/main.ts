import './style.css';
import { addEntry, clearAllEntries, deleteEntry, listEntries } from './db';
import {
  buildPrintableHtml,
  downloadJson,
  entriesToExportBundle,
  exportBundleToEntries,
  openPrintableReport,
} from './export';
import type { RecordEntry } from './types';

function uid(): string {
  return crypto.randomUUID();
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type AppState = {
  pendingBlob: Blob | null;
  pendingType: string;
  entries: RecordEntry[];
  cameraStream: MediaStream | null;
};

const state: AppState = {
  pendingBlob: null,
  pendingType: 'image/jpeg',
  entries: [],
  cameraStream: null,
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function objectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

async function refreshList(): Promise<void> {
  state.entries = await listEntries();
  render();
}

function stopCamera(): void {
  state.cameraStream?.getTracks().forEach((t) => t.stop());
  state.cameraStream = null;
}

async function startCamera(video: HTMLVideoElement): Promise<void> {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザではカメラを利用できません');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  state.cameraStream = stream;
  video.srcObject = stream;
  await video.play();
}

function captureFromVideo(video: HTMLVideoElement): Blob | null {
  if (video.videoWidth === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const parts = dataUrl.split(',');
  const b64 = parts[1];
  if (!b64) return null;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function render(): void {
  const pendingPreview = state.pendingBlob
    ? `<img src="${objectUrl(state.pendingBlob)}" alt="選択中の写真" />`
    : `<div class="preview-placeholder">写真を撮影するか、ファイルを選択してください</div>`;

  const listHtml =
    state.entries.length === 0
      ? `<p class="empty">まだ記録がありません。上から写真とコメントを追加してください。</p>`
      : `<ul class="entry-list">
          ${state.entries
            .map(
              (e) => `
            <li class="entry-item" data-id="${e.id}">
              <img src="${objectUrl(e.photoBlob)}" alt="" />
              <div class="entry-body">
                <time>${formatWhen(e.createdAt)}</time>
                <p>${escapeHtml(e.comment) || '（コメントなし）'}</p>
              </div>
              <button type="button" class="delete-btn danger" data-delete="${e.id}">削除</button>
            </li>`,
            )
            .join('')}
        </ul>`;

  app.innerHTML = `
    <header class="app-header">
      <h1>現場チェック記録</h1>
      <p>写真＋コメントを溜めて、一覧（印刷・PDF）や JSON で出力できます。</p>
    </header>

    <section class="card" aria-labelledby="add-heading">
      <h2 id="add-heading">記録を追加</h2>
      <div class="preview-wrap" id="preview">${pendingPreview}</div>
      <label for="comment">コメント</label>
      <textarea id="comment" placeholder="状況・指摘事項など"></textarea>
      <div class="btn-row">
        <button type="button" id="btn-camera">カメラ起動</button>
        <button type="button" id="btn-shutter" disabled>シャッター</button>
        <label class="file-btn" for="file-input">ファイル選択</label>
        <input type="file" id="file-input" accept="image/*" capture="environment" />
        <button type="button" class="primary" id="btn-save" disabled>この内容で保存</button>
      </div>
      <p class="storage-note">
        データはこの端末のブラウザ内（IndexedDB）にのみ保存されます。別端末や長期保管には JSON エクスポートをご利用ください。
      </p>
    </section>

    <section class="toolbar">
      <button type="button" class="primary" id="btn-report" ${state.entries.length ? '' : 'disabled'}>
        一覧を出力（印刷）
      </button>
      <button type="button" id="btn-export-json" ${state.entries.length ? '' : 'disabled'}>
        JSON エクスポート
      </button>
      <label class="file-btn" for="import-json">JSON インポート</label>
      <input type="file" id="import-json" accept="application/json,.json" />
      <button type="button" class="danger" id="btn-clear" ${state.entries.length ? '' : 'disabled'}>
        すべて削除
      </button>
    </section>

    <section aria-labelledby="list-heading">
      <h2 id="list-heading" style="font-size:1rem;margin:0 0 12px;">記録一覧（${state.entries.length}件）</h2>
      ${listHtml}
    </section>
  `;

  wireEvents();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wireEvents(): void {
  const commentEl = document.querySelector<HTMLTextAreaElement>('#comment')!;
  const saveBtn = document.querySelector<HTMLButtonElement>('#btn-save')!;
  const shutterBtn = document.querySelector<HTMLButtonElement>('#btn-shutter')!;
  const fileInput = document.querySelector<HTMLInputElement>('#file-input')!;

  const updateSaveState = () => {
    const ok = state.pendingBlob !== null;
    saveBtn.disabled = !ok;
  };
  updateSaveState();

  document.querySelector('#btn-camera')!.addEventListener('click', async () => {
    const wrap = document.querySelector('#preview')!;
    wrap.innerHTML =
      '<video id="live-video" playsinline muted autoplay></video>';
    const video = document.querySelector<HTMLVideoElement>('#live-video')!;
    try {
      await startCamera(video);
      shutterBtn.disabled = false;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'カメラを起動できませんでした');
      render();
    }
  });

  shutterBtn.addEventListener('click', () => {
    const video = document.querySelector<HTMLVideoElement>('#live-video');
    if (!video) return;
    const blob = captureFromVideo(video);
    if (!blob) {
      alert('撮影に失敗しました');
      return;
    }
    stopCamera();
    state.pendingBlob = blob;
    state.pendingType = 'image/jpeg';
    render();
    const ta = document.querySelector<HTMLTextAreaElement>('#comment');
    ta?.focus();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    stopCamera();
    state.pendingBlob = file;
    state.pendingType = file.type || 'image/jpeg';
    render();
  });

  saveBtn.addEventListener('click', async () => {
    if (!state.pendingBlob) return;
    const comment = commentEl.value.trim();
    const entry: RecordEntry = {
      id: uid(),
      createdAt: Date.now(),
      comment,
      photoType: state.pendingType,
      photoBlob: state.pendingBlob,
    };
    await addEntry(entry);
    state.pendingBlob = null;
    stopCamera();
    await refreshList();
  });

  app.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete');
      if (!id) return;
      if (!confirm('この記録を削除しますか？')) return;
      await deleteEntry(id);
      await refreshList();
    });
  });

  document.querySelector('#btn-report')!.addEventListener('click', async () => {
    const html = await buildPrintableHtml(state.entries);
    openPrintableReport(html);
  });

  document.querySelector('#btn-export-json')!.addEventListener('click', async () => {
    const bundle = await entriesToExportBundle(state.entries);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`construction-check-${stamp}.json`, bundle);
  });

  document.querySelector('#import-json')!.addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as unknown;
      if (
        !bundle ||
        typeof bundle !== 'object' ||
        !('entries' in bundle) ||
        !Array.isArray((bundle as { entries: unknown }).entries)
      ) {
        throw new Error('形式が正しくありません');
      }
      const entries = exportBundleToEntries(bundle as Parameters<typeof exportBundleToEntries>[0]);
      if (
        !confirm(
          `インポート ${entries.length} 件を既存データに追加します。よろしいですか？`,
        )
      ) {
        return;
      }
      for (const e of entries) {
        await addEntry({ ...e, id: uid() });
      }
      await refreshList();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'インポートに失敗しました');
    }
  });

  document.querySelector('#btn-clear')!.addEventListener('click', async () => {
    if (!confirm('すべての記録を削除します。この操作は取り消せません。')) return;
    await clearAllEntries();
    state.pendingBlob = null;
    stopCamera();
    await refreshList();
  });
}

window.addEventListener('beforeunload', () => stopCamera());

void refreshList();
