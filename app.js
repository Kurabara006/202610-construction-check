/* 写真・コメント記録 — Vanilla JS（設計書 v1.0） */
(function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DB_NAME = 'photo-report-v1';
  const DB_VERSION = 1;
  const MAX_LONG_EDGE = 2048;
  const JPEG_QUALITY = 0.85;
  const DEBOUNCE_MS = 400;

  /** @type {'idle'|'saving'|'ok'|'err'} */
  let saveUiState = 'idle';
  let saveUiTimer = null;

  /** @typedef {{ id: string, file: string, fileName: string, takenAt: string, location: string, comment: string, order: number, blob?: Blob, objectUrl?: string }} PhotoMeta */
  /** @typedef {{ schemaVersion: number, reportId: string, title: string, surveyDate: string, location: string, memo: string, updatedAt: string, photos: PhotoMeta[] }} ReportData */

  /** @type {ReportData | null} */
  let currentReport = null;
  /** @type {'list'|'edit'|'pc'} */
  let mode = 'list';
  /** @type {boolean} */
  let pcEditMode = false;

  const appEl = document.getElementById('app');
  const toastEl = document.getElementById('save-toast');

  function uid() {
    return crypto.randomUUID();
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function todayDateInput() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setSaveToast(state, message) {
    saveUiState = state;
    if (!toastEl) return;
    if (state === 'idle') {
      toastEl.hidden = true;
      return;
    }
    toastEl.hidden = false;
    toastEl.textContent = message;
    toastEl.className = 'save-toast' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
    if (state === 'ok' || state === 'err') {
      clearTimeout(saveUiTimer);
      saveUiTimer = setTimeout(() => setSaveToast('idle', ''), 2200);
    }
  }

  // --- IndexedDB ---

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('reports')) {
          db.createObjectStore('reports', { keyPath: 'reportId' });
        }
        if (!db.objectStoreNames.contains('photos')) {
          const ps = db.createObjectStore('photos', { keyPath: 'id' });
          ps.createIndex('byReport', 'reportId', { unique: false });
        }
      };
    });
  }

  /** @returns {Promise<Omit<ReportData, 'photos'>[]>} */
  async function listReportSummaries() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('reports', 'readonly');
      const store = tx.objectStore('reports');
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result || []).sort((a, b) =>
          (b.updatedAt || '').localeCompare(a.updatedAt || ''),
        );
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** @param {string} reportId */
  async function loadReportFromDb(reportId) {
    const db = await openDb();
    const meta = await new Promise((resolve, reject) => {
      const tx = db.transaction('reports', 'readonly');
      const req = tx.objectStore('reports').get(reportId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!meta) throw new Error('レポートが見つかりません');

    const photos = await new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readonly');
      const idx = tx.objectStore('photos').index('byReport');
      const req = idx.getAll(reportId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    photos.sort((a, b) => a.order - b.order);
    const legacyReportLocation = meta.location || '';
    /** @type {ReportData} */
    const report = {
      schemaVersion: SCHEMA_VERSION,
      reportId: meta.reportId,
      title: meta.title,
      surveyDate: meta.surveyDate,
      location: '',
      memo: meta.memo || '',
      updatedAt: meta.updatedAt,
      photos: photos.map((p) => ({
        id: p.id,
        file: p.file || '',
        fileName: p.fileName,
        takenAt: p.takenAt,
        location: p.location || legacyReportLocation || '',
        comment: p.comment || '',
        order: p.order,
        blob: p.blob,
        objectUrl: p.blob ? URL.createObjectURL(p.blob) : undefined,
      })),
    };
    return report;
  }

  /** @param {ReportData} report */
  async function persistReport(report) {
    setSaveToast('saving', '保存中…');
    try {
      const db = await openDb();
      const meta = {
        reportId: report.reportId,
        title: report.title,
        surveyDate: report.surveyDate,
        location: report.location,
        memo: report.memo,
        updatedAt: report.updatedAt,
        schemaVersion: SCHEMA_VERSION,
      };

      await new Promise((resolve, reject) => {
        const tx = db.transaction(['reports', 'photos'], 'readwrite');
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.objectStore('reports').put(meta);

        const photoStore = tx.objectStore('photos');
        for (const p of report.photos) {
          photoStore.put({
            id: p.id,
            reportId: report.reportId,
            blob: p.blob,
            file: p.file,
            fileName: p.fileName,
            takenAt: p.takenAt,
            location: p.location || '',
            comment: p.comment,
            order: p.order,
          });
        }
      });
      setSaveToast('ok', '保存しました');
    } catch (e) {
      console.error(e);
      setSaveToast('err', '保存に失敗しました');
      throw e;
    }
  }

  /** @param {string} reportId */
  async function deleteReportFromDb(reportId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['reports', 'photos'], 'readwrite');
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.objectStore('reports').delete(reportId);
      const idx = tx.objectStore('photos').index('byReport');
      const req = idx.getAllKeys(reportId);
      req.onsuccess = () => {
        const store = tx.objectStore('photos');
        for (const key of req.result || []) store.delete(key);
      };
    });
  }

  /** @param {string} photoId */
  async function deletePhotoFromDb(photoId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.objectStore('photos').delete(photoId);
    });
  }

  // --- 画像処理 ---

  function readExifOrientation(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    const length = view.byteLength;
    while (offset + 4 < length) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2) break;
      if (marker === 0xe1 && offset + 4 + 6 < length) {
        const exifOffset = offset + 4;
        if (view.getUint32(exifOffset, false) === 0x45786966) {
          const tiff = exifOffset + 6;
          const little = view.getUint16(tiff, false) === 0x4949;
          const ifdOffset = view.getUint32(tiff + 4, little);
          const ifd = tiff + ifdOffset;
          if (ifd + 2 <= length) {
            const entries = view.getUint16(ifd, little);
            for (let i = 0; i < entries; i++) {
              const entry = ifd + 2 + i * 12;
              if (entry + 12 > length) break;
              if (view.getUint16(entry, little) === 0x0112) {
                const val = view.getUint16(entry + 8, little);
                return val >= 1 && val <= 8 ? val : 1;
              }
            }
          }
        }
      }
      offset += 2 + segLen;
    }
    return 1;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource} img
   * @param {number} orientation EXIF 1–8
   * @param {number} targetW
   * @param {number} targetH
   * @param {number} srcW intrinsic width
   * @param {number} srcH intrinsic height
   */
  function drawImageWithExifOrientation(
    ctx,
    img,
    orientation,
    targetW,
    targetH,
    srcW,
    srcH,
  ) {
    ctx.save();
    switch (orientation) {
      case 2:
        ctx.transform(-1, 0, 0, 1, targetW, 0);
        break;
      case 3:
        ctx.transform(-1, 0, 0, -1, targetW, targetH);
        break;
      case 4:
        ctx.transform(1, 0, 0, -1, 0, targetH);
        break;
      case 5:
        ctx.transform(0, 1, 1, 0, 0, 0);
        break;
      case 6:
        ctx.transform(0, 1, -1, 0, targetH, 0);
        break;
      case 7:
        ctx.transform(0, -1, -1, 0, targetH, targetW);
        break;
      case 8:
        ctx.transform(0, -1, 1, 0, 0, targetW);
        break;
      default:
        break;
    }
    ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, targetW, targetH);
    ctx.restore();
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<{ width: number, height: number, draw: Function, cleanup?: Function }>}
   */
  async function loadOrientedImageSource(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: 'from-image',
        });
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw: (ctx, dw, dh) => ctx.drawImage(bitmap, 0, 0, dw, dh),
          cleanup: () => bitmap.close(),
        };
      } catch {
        /* createImageBitmap 非対応形式など */
      }
    }

    const buf = await blob.arrayBuffer();
    const orientation = readExifOrientation(buf);
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url);
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    const swap = orientation >= 5 && orientation <= 8;
    return {
      width: swap ? srcH : srcW,
      height: swap ? srcW : srcH,
      draw: (ctx, dw, dh) =>
        drawImageWithExifOrientation(ctx, img, orientation, dw, dh, srcW, srcH),
      cleanup: () => URL.revokeObjectURL(url),
    };
  }

  /**
   * @param {File} file
   * @returns {Promise<{ blob: Blob, fileName: string }>}
   */
  async function processImageFile(file) {
    const blob = new Blob([await file.arrayBuffer()], {
      type: file.type || 'image/jpeg',
    });
    const source = await loadOrientedImageSource(blob);
    try {
      const scale = Math.min(1, MAX_LONG_EDGE / Math.max(source.width, source.height));
      const dstW = Math.round(source.width * scale);
      const dstH = Math.round(source.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = dstW;
      canvas.height = dstH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');
      source.draw(ctx, dstW, dstH);
      const outBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('画像変換に失敗'))),
          'image/jpeg',
          JPEG_QUALITY,
        );
      });
      const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
      return { blob: outBlob, fileName: `${base}.jpg` };
    } finally {
      source.cleanup?.();
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像読込失敗'));
      img.src = url;
    });
  }

  // --- レポート JSON（ZIP / 埋め込み用） ---

  /** @param {ReportData} report */
  function toExportJson(report) {
    const photos = [...report.photos]
      .sort((a, b) => a.order - b.order)
      .map((p, i) => ({
        id: p.id,
        file: p.file || `images/photo_${String(i + 1).padStart(3, '0')}.jpg`,
        fileName: p.fileName,
        takenAt: p.takenAt,
        location: p.location || '',
        comment: p.comment,
        order: i,
      }));
    return {
      schemaVersion: SCHEMA_VERSION,
      reportId: report.reportId,
      title: report.title,
      surveyDate: report.surveyDate,
      location: '',
      memo: report.memo,
      updatedAt: report.updatedAt,
      photos,
    };
  }

  function escapeJsonForScript(jsonStr) {
    return jsonStr.replace(/</g, '\\u003c');
  }

  /** @param {object} data */
  function buildExportIndexHtml(data) {
    const json = escapeJsonForScript(JSON.stringify(data, null, 2));
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(data.title || '写真・コメント記録')}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="save-toast" class="save-toast" role="status" aria-live="polite" hidden></div>
  <main id="app" class="app"></main>
  <script type="application/json" id="report-data">${json}</script>
  <script src="lib/jszip.min.js"><\/script>
  <script src="app.js"><\/script>
</body>
</html>`;
  }

  async function fetchTextAsset(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} の取得に失敗`);
    return res.text();
  }

  async function fetchBinaryAsset(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} の取得に失敗`);
    return res.blob();
  }

  /** @param {ReportData} report */
  async function buildZipBlob(report) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip が読み込まれていません');
    const zip = new JSZip();
    const exportJson = toExportJson(report);
    const sorted = [...report.photos].sort((a, b) => a.order - b.order);

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const path = exportJson.photos[i].file;
      let blob = p.blob;
      if (!blob && p.objectUrl) {
        blob = await fetch(p.objectUrl).then((r) => r.blob());
      }
      if (!blob && p.file) {
        blob = await fetch(p.file).then((r) => r.blob());
      }
      if (!blob) throw new Error('写真データがありません: ' + p.id);
      zip.file(path, blob);
    }

    zip.file('data.json', JSON.stringify(exportJson, null, 2));

    let appJs;
    let styleCss;
    let jszipBlob;
    try {
      [appJs, styleCss, jszipBlob] = await Promise.all([
        fetchTextAsset('app.js'),
        fetchTextAsset('style.css'),
        fetchBinaryAsset('lib/jszip.min.js'),
      ]);
    } catch (e) {
      throw new Error(
        'ZIP同梱ファイルの取得に失敗しました。HTTPSで開いているか、ZIP内から再出力しているか確認してください。',
      );
    }

    zip.file('index.html', buildExportIndexHtml(exportJson));
    zip.file('app.js', appJs);
    zip.file('style.css', styleCss);
    zip.folder('lib').file('jszip.min.js', jszipBlob);

    return zip.generateAsync({ type: 'blob' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- UI ---

  let debounceTimer = null;

  function schedulePersist() {
    if (!currentReport || mode !== 'edit') return;
    currentReport.updatedAt = isoNow();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      persistReport(currentReport).catch(() => {});
    }, DEBOUNCE_MS);
  }

  /** @param {File[]} files */
  async function appendPhotosToCurrentReport(files) {
    if (!currentReport || !files.length) return;
    try {
      setSaveToast('saving', '画像処理中…');
      let order = currentReport.photos.length;
      for (const file of files) {
        const { blob, fileName } = await processImageFile(file);
        currentReport.photos.push({
          id: uid(),
          file: '',
          fileName,
          takenAt: isoNow(),
          location: '',
          comment: '',
          order: order++,
          blob,
          objectUrl: URL.createObjectURL(blob),
        });
      }
      await persistReport(currentReport);
      renderEdit();
    } catch (e) {
      setSaveToast('err', e instanceof Error ? e.message : '追加失敗');
    }
  }

  /**
   * @param {ReportData} report
   * @param {File[]} files
   * @param {boolean} editable
   */
  async function appendPhotosToPcReport(report, files, editable) {
    if (!files.length) return;
    try {
      setSaveToast('saving', '画像処理中…');
      let order = report.photos.length;
      for (const file of files) {
        const { blob, fileName } = await processImageFile(file);
        report.photos.push({
          id: uid(),
          file: '',
          fileName,
          takenAt: isoNow(),
          location: '',
          comment: '',
          order: order++,
          blob,
          objectUrl: URL.createObjectURL(blob),
        });
      }
      report.updatedAt = isoNow();
      renderPcView(report, editable);
      setSaveToast('ok', '写真を追加しました');
    } catch (e) {
      setSaveToast('err', e instanceof Error ? e.message : '追加失敗');
    }
  }

  function bindPhotoInputs(captureId, pickId) {
    const capture = document.getElementById(captureId);
    const pick = document.getElementById(pickId);
    if (capture) {
      capture.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const files = input.files ? [...input.files] : [];
        input.value = '';
        await appendPhotosToCurrentReport(files);
      });
    }
    if (pick) {
      pick.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const files = input.files ? [...input.files] : [];
        input.value = '';
        await appendPhotosToCurrentReport(files);
      });
    }
  }

  function renderList() {
    mode = 'list';
    currentReport = null;
    appEl.className = 'app view-list';
    appEl.innerHTML = '<p class="empty">読み込み中…</p>';

    listReportSummaries()
      .then((rows) => {
        const items =
          rows.length === 0
            ? '<p class="empty">レポートがありません。「新規レポート」から作成してください。</p>'
            : `<ul class="report-list">${rows
                .map(
                  (r) => `
              <li>
                <div>
                  <strong>${escapeHtml(r.title || '無題')}</strong>
                  <div class="meta">${escapeHtml(r.surveyDate || '')}</div>
                </div>
                <div class="btn-row" style="margin:0">
                  <button type="button" data-open="${r.reportId}">開く</button>
                  <button type="button" class="danger" data-del-report="${r.reportId}">削除</button>
                </div>
              </li>`,
                )
                .join('')}</ul>`;

        appEl.innerHTML = `
          <h1>写真・コメント記録</h1>
          <p class="lead">撮影とコメントを端末内に保存し、ZIPでPCへ持ち出して印刷できます。</p>
          <button type="button" class="primary hero-new-report" id="btn-new-report">新規レポート</button>
          ${items}
          <div class="hint-block">
            <p class="hint"><strong>保存場所:</strong> 撮影・追加した写真は、端末の「写真」アプリのフォルダには<strong>自動では入りません</strong>。このサイトを開いている<strong>ブラウザ内</strong>（アプリの記録領域）に保存されます。機種によってはカメラ撮影時に OS がカメラロールへ残すことがありますが、報告用データの正本はブラウザ内です。</p>
            <p class="hint"><strong>バックアップ:</strong> 長期保管・PC 利用は、各レポートの<strong> ZIP 出力</strong>で端末のダウンロードフォルダ等へ保存してください。ブラウザのデータ削除やキャッシュクリアで記録が消えることがあります。</p>
          </div>
        `;

        document.getElementById('btn-new-report').onclick = () => {
          /** @type {ReportData} */
          const report = {
            schemaVersion: SCHEMA_VERSION,
            reportId: uid(),
            title: '現地調査記録',
            surveyDate: todayDateInput(),
            location: '',
            memo: '',
            updatedAt: isoNow(),
            photos: [],
          };
          currentReport = report;
          persistReport(report)
            .then(() => openEdit(report.reportId))
            .catch(() => {});
        };

        appEl.querySelectorAll('[data-open]').forEach((btn) => {
          btn.addEventListener('click', () => openEdit(btn.getAttribute('data-open')));
        });
        appEl.querySelectorAll('[data-del-report]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-del-report');
            if (!id || !confirm('このレポートを削除しますか？')) return;
            await deleteReportFromDb(id);
            renderList();
          });
        });
      })
      .catch(() => {
        appEl.innerHTML =
          '<p class="empty">一覧の読み込みに失敗しました。ブラウザのストレージ設定を確認してください。</p>';
      });
  }

  async function openEdit(reportId) {
    try {
      currentReport = await loadReportFromDb(reportId);
      mode = 'edit';
      renderEdit();
    } catch (e) {
      alert(e instanceof Error ? e.message : '読み込み失敗');
      renderList();
    }
  }

  function renderEdit() {
    if (!currentReport) return;
    appEl.className = 'app view-edit no-print';
    const r = currentReport;
    const photos = [...r.photos].sort((a, b) => a.order - b.order);

    const photoHtml =
      photos.length === 0
        ? '<p class="empty">写真がありません。撮影するか、デバイスから追加してください。</p>'
        : `<ul class="photo-list">${photos
            .map(
              (p, idx) => `
          <li class="photo-item" data-photo-id="${p.id}">
            <div class="photo-thumb-square"><img src="${p.objectUrl || p.file}" alt="" /></div>
            <label for="loc-${p.id}">場所</label>
            <input type="text" id="loc-${p.id}" data-location="${p.id}" value="${escapeHtml(p.location)}" placeholder="例: 2F 北側外壁" />
            <label for="cmt-${p.id}">コメント</label>
            <textarea id="cmt-${p.id}" data-comment="${p.id}">${escapeHtml(p.comment)}</textarea>
            <div class="row">
              <button type="button" data-up="${p.id}" ${idx === 0 ? 'disabled' : ''}>上へ</button>
              <button type="button" data-down="${p.id}" ${idx === photos.length - 1 ? 'disabled' : ''}>下へ</button>
              <button type="button" class="danger" data-del-photo="${p.id}">削除</button>
            </div>
          </li>`,
            )
            .join('')}</ul>`;

    appEl.innerHTML = `
      <header class="page-header">
        <div class="page-header-row">
          <h1>レポート作成編集</h1>
          <button type="button" class="btn-back-list" id="btn-back">一覧へ</button>
        </div>
        <p class="lead">変更は自動保存されます（${saveUiState === 'saving' ? '保存中…' : '完了時に通知'}）</p>
      </header>
      <div class="photo-add-actions">
        <label class="file-btn hero-add-photo primary" for="photo-capture">撮影</label>
        <input type="file" id="photo-capture" accept="image/*" capture="environment" />
        <label class="file-btn add-from-device" for="photo-pick">デバイスから追加</label>
        <input type="file" id="photo-pick" accept="image/*" multiple />
      </div>
      <div class="card">
        <label for="f-title">タイトル</label>
        <input id="f-title" type="text" value="${escapeHtml(r.title)}" />
        <label for="f-date">調査日</label>
        <input id="f-date" type="date" value="${escapeHtml(r.surveyDate)}" />
        <label for="f-memo">メモ（任意）</label>
        <textarea id="f-memo">${escapeHtml(r.memo)}</textarea>
      </div>
      <div class="card">
        <h2>写真一覧</h2>
        ${photoHtml}
      </div>
      <div class="toolbar">
        <button type="button" class="primary" id="btn-export-zip">ZIP出力</button>
      </div>
    `;

    const bindField = (id, key) => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        currentReport[key] = el.value;
        schedulePersist();
      });
    };
    bindField('f-title', 'title');
    bindField('f-date', 'surveyDate');
    bindField('f-memo', 'memo');

    document.getElementById('btn-back').onclick = () => renderList();
    bindPhotoInputs('photo-capture', 'photo-pick');

    appEl.querySelectorAll('[data-location]').forEach((input) => {
      input.addEventListener('input', () => {
        const id = input.getAttribute('data-location');
        const p = currentReport.photos.find((x) => x.id === id);
        if (p) {
          p.location = input.value;
          schedulePersist();
        }
      });
    });

    appEl.querySelectorAll('[data-comment]').forEach((ta) => {
      ta.addEventListener('input', () => {
        const id = ta.getAttribute('data-comment');
        const p = currentReport.photos.find((x) => x.id === id);
        if (p) {
          p.comment = ta.value;
          schedulePersist();
        }
      });
    });

    appEl.querySelectorAll('[data-del-photo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-photo');
        if (!id || !confirm('この写真を削除しますか？')) return;
        currentReport.photos = currentReport.photos.filter((p) => p.id !== id);
        currentReport.photos.forEach((p, i) => {
          p.order = i;
        });
        await deletePhotoFromDb(id);
        await persistReport(currentReport);
        renderEdit();
      });
    });

    const swapOrder = async (id, dir) => {
      const list = [...currentReport.photos].sort((a, b) => a.order - b.order);
      const idx = list.findIndex((p) => p.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= list.length) return;
      [list[idx], list[j]] = [list[j], list[idx]];
      list.forEach((p, i) => {
        p.order = i;
      });
      currentReport.photos = list;
      await persistReport(currentReport);
      renderEdit();
    };

    appEl.querySelectorAll('[data-up]').forEach((btn) => {
      btn.addEventListener('click', () => swapOrder(btn.getAttribute('data-up'), -1));
    });
    appEl.querySelectorAll('[data-down]').forEach((btn) => {
      btn.addEventListener('click', () => swapOrder(btn.getAttribute('data-down'), 1));
    });

    document.getElementById('btn-export-zip').onclick = async () => {
      try {
        setSaveToast('saving', 'ZIP作成中…');
        const blob = await buildZipBlob(currentReport);
        const stamp = currentReport.surveyDate || todayDateInput();
        downloadBlob(blob, `report-${stamp}.zip`);
        setSaveToast('ok', 'ZIPをダウンロードしました');
      } catch (e) {
        setSaveToast('err', e instanceof Error ? e.message : 'ZIP出力失敗');
      }
    };
  }

  /** @param {ReportData} report */
  function renderPcView(report, editable) {
    mode = 'pc';
    currentReport = report;
    pcEditMode = editable;
    appEl.className = 'app view-pc';

    const photos = [...report.photos].sort((a, b) => a.order - b.order);

    const printSection = photos
      .map((p, i) => {
        const src = p.objectUrl || p.file;
        return `
        <article class="print-record">
          <div class="num">${i + 1}</div>
          ${p.location ? `<p class="photo-location"><strong>場所:</strong> ${escapeHtml(p.location)}</p>` : ''}
          <img src="${escapeHtml(src)}" alt="写真${i + 1}" />
          <p class="comment">${escapeHtml(p.comment) || '（コメントなし）'}</p>
        </article>`;
      })
      .join('');

    const editPhotos =
      editable && photos.length
        ? `<ul class="photo-list no-print">${photos
            .map(
              (p, idx) => `
          <li class="photo-item" data-photo-id="${p.id}">
            <div class="photo-thumb-square"><img src="${p.objectUrl || p.file}" alt="" /></div>
            <label>場所</label>
            <input type="text" data-pc-location="${p.id}" value="${escapeHtml(p.location)}" />
            <label>コメント</label>
            <textarea data-pc-comment="${p.id}">${escapeHtml(p.comment)}</textarea>
            <div class="row">
              <button type="button" data-pc-up="${p.id}" ${idx === 0 ? 'disabled' : ''}>上へ</button>
              <button type="button" data-pc-down="${p.id}" ${idx === photos.length - 1 ? 'disabled' : ''}>下へ</button>
              <button type="button" class="danger" data-pc-del="${p.id}">削除</button>
            </div>
          </li>`,
            )
            .join('')}</ul>`
        : '';

    appEl.innerHTML = `
      <div class="toolbar no-print">
        <button type="button" id="pc-toggle">${editable ? '閲覧モード' : '編集モード'}</button>
      </div>
      <div class="photo-add-actions no-print">
        <label class="file-btn hero-add-photo primary" for="pc-capture">撮影</label>
        <input type="file" id="pc-capture" accept="image/*" capture="environment" />
        <label class="file-btn add-from-device" for="pc-pick">デバイスから追加</label>
        <input type="file" id="pc-pick" accept="image/*" multiple />
      </div>
      <div class="toolbar no-print">
        <button type="button" class="primary" id="pc-reexport">更新ZIPを出力</button>
        <button type="button" id="pc-print">印刷 / PDF</button>
      </div>
      <div class="card no-print">
        <label>タイトル</label>
        <input id="pc-title" type="text" value="${escapeHtml(report.title)}" ${editable ? '' : 'readonly'} />
        <label>調査日</label>
        <input id="pc-date" type="date" value="${escapeHtml(report.surveyDate)}" ${editable ? '' : 'readonly'} />
        <label>メモ</label>
        <textarea id="pc-memo" ${editable ? '' : 'readonly'}>${escapeHtml(report.memo)}</textarea>
      </div>
      ${editPhotos}
      <section class="print-sheet">
        <header class="print-header">
          <h1>${escapeHtml(report.title)}</h1>
          <dl>
            <dt>調査日</dt><dd>${escapeHtml(report.surveyDate)}</dd>
            <dt>更新</dt><dd>${escapeHtml(report.updatedAt)}</dd>
          </dl>
          ${report.memo ? `<p>${escapeHtml(report.memo)}</p>` : ''}
        </header>
        ${printSection}
      </section>
    `;

    document.getElementById('pc-toggle').onclick = () => renderPcView(report, !editable);

    const syncFields = () => {
      if (!editable) return;
      report.title = /** @type {HTMLInputElement} */ (document.getElementById('pc-title')).value;
      report.surveyDate = /** @type {HTMLInputElement} */ (document.getElementById('pc-date')).value;
      report.memo = /** @type {HTMLTextAreaElement} */ (document.getElementById('pc-memo')).value;
      report.updatedAt = isoNow();
    };

    ['pc-title', 'pc-date', 'pc-memo'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('input', syncFields);
    });

    appEl.querySelectorAll('[data-pc-location]').forEach((input) => {
      input.addEventListener('input', () => {
        const id = input.getAttribute('data-pc-location');
        const p = report.photos.find((x) => x.id === id);
        if (p) {
          p.location = input.value;
          report.updatedAt = isoNow();
        }
      });
    });

    appEl.querySelectorAll('[data-pc-comment]').forEach((ta) => {
      ta.addEventListener('input', () => {
        const id = ta.getAttribute('data-pc-comment');
        const p = report.photos.find((x) => x.id === id);
        if (p) {
          p.comment = ta.value;
          report.updatedAt = isoNow();
        }
      });
    });

    appEl.querySelectorAll('[data-pc-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-pc-del');
        report.photos = report.photos.filter((p) => p.id !== id);
        report.photos.forEach((p, i) => {
          p.order = i;
        });
        report.updatedAt = isoNow();
        renderPcView(report, editable);
      });
    });

    const pcSwap = (id, dir) => {
      const list = [...report.photos].sort((a, b) => a.order - b.order);
      const idx = list.findIndex((p) => p.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= list.length) return;
      [list[idx], list[j]] = [list[j], list[idx]];
      list.forEach((p, i) => {
        p.order = i;
      });
      report.photos = list;
      report.updatedAt = isoNow();
      renderPcView(report, editable);
    };

    appEl.querySelectorAll('[data-pc-up]').forEach((btn) => {
      btn.addEventListener('click', () => pcSwap(btn.getAttribute('data-pc-up'), -1));
    });
    appEl.querySelectorAll('[data-pc-down]').forEach((btn) => {
      btn.addEventListener('click', () => pcSwap(btn.getAttribute('data-pc-down'), 1));
    });

    const pcCapture = document.getElementById('pc-capture');
    const pcPick = document.getElementById('pc-pick');
    if (pcCapture) {
      pcCapture.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const files = input.files ? [...input.files] : [];
        input.value = '';
        await appendPhotosToPcReport(report, files, editable);
      });
    }
    if (pcPick) {
      pcPick.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const files = input.files ? [...input.files] : [];
        input.value = '';
        await appendPhotosToPcReport(report, files, editable);
      });
    }

    document.getElementById('pc-reexport').onclick = async () => {
      syncFields();
      for (let i = 0; i < report.photos.length; i++) {
        const p = report.photos[i];
        if (!p.file) {
          p.file = `images/photo_${String(i + 1).padStart(3, '0')}.jpg`;
        }
      }
      try {
        setSaveToast('saving', 'ZIP作成中…');
        const blob = await buildZipBlob(report);
        downloadBlob(blob, `report-updated-${todayDateInput()}.zip`);
        setSaveToast('ok', '更新ZIPをダウンロードしました');
      } catch (e) {
        setSaveToast('err', e instanceof Error ? e.message : 'ZIP出力失敗');
      }
    };

    document.getElementById('pc-print').onclick = () => {
      syncFields();
      renderPcView(report, editable);
      requestAnimationFrame(() => window.print());
    };
  }

  /** @param {object} data */
  function initFromEmbeddedJson(data) {
    /** @type {ReportData} */
    const report = {
      schemaVersion: data.schemaVersion || SCHEMA_VERSION,
      reportId: data.reportId,
      title: data.title || '',
      surveyDate: data.surveyDate || '',
      location: data.location || '',
      memo: data.memo || '',
      updatedAt: data.updatedAt || isoNow(),
      photos: (data.photos || []).map((p, i, arr) => {
        const legacyReportLocation = data.location || '';
        const onlyOne = arr.length === 1;
        return {
          id: p.id,
          file: p.file,
          fileName: p.fileName || p.file,
          takenAt: p.takenAt,
          location:
            p.location ||
            (legacyReportLocation && onlyOne && i === 0 ? legacyReportLocation : ''),
          comment: p.comment || '',
          order: p.order,
        };
      }),
    };
    renderPcView(report, false);
  }

  function bootstrap() {
    const embedEl = document.getElementById('report-data');
    const raw = embedEl && embedEl.textContent ? embedEl.textContent.trim() : '';
    if (raw) {
      try {
        const data = JSON.parse(raw);
        initFromEmbeddedJson(data);
        return;
      } catch (e) {
        console.error(e);
        appEl.innerHTML = '<p class="empty">埋め込みデータの読込に失敗しました。</p>';
        return;
      }
    }
    if (!window.indexedDB) {
      appEl.innerHTML =
        '<p class="empty">このブラウザは IndexedDB に対応していません。</p>';
      return;
    }
    renderList();
  }

  bootstrap();
})();
