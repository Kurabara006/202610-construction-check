# 写真・コメント記録 Web アプリ

設計書 v1.0 に基づく **HTML + CSS + Vanilla JavaScript** の静的アプリです。  
Node.js・ビルドツール・フレームワークは使いません。

- スマホ: 撮影・コメント → **IndexedDB** に自動保存 → **ZIP 出力**
- PC: ZIP 展開 → `index.html` を **file://** で開く → 編集・再 ZIP → **A4 印刷 / PDF**

---

## スマホからすぐ試す（GitHub Pages）

コードは **main にマージ済み** です。**初回だけ** 次の 1 操作が必要です（GitHub アプリまたはブラウザから可能）。

1. リポジトリ `Kurabara006/202610-construction-check` を開く  
2. **Settings** → **Pages**  
3. **Build and deployment** の **Source** を **GitHub Actions** に変更して保存  

数十秒後、Actions の「Deploy GitHub Pages」が成功すると公開されます。失敗していた場合は **Actions** タブから該当 workflow を **Re-run** してください。

### コピペ用 URL（公開後）

```
https://kurabara006.github.io/202610-construction-check/
```

ブラウザのアドレスバーに貼って開くだけです（HTTPS のためカメラ利用可）。

---

## スマホ Termux で clone して確認

Termux でコードを取得し、ローカル HTTP サーバーを起動します。  
（HTTP のため **カメラ API は使えない** ことがあります。撮影確認は GitHub Pages を推奨します。UI・ZIP 出力の動作確認向けです。）

### 1 行セットアップ＋起動

```bash
pkg install -y git python && git clone https://github.com/Kurabara006/202610-construction-check.git && cd 202610-construction-check && python -m http.server 8080
```

### 同じ端末のブラウザで開く URL

```
http://127.0.0.1:8080/
```

Termux から Chrome を開く例:

```bash
termux-open-url http://127.0.0.1:8080/
```

---

## ファイル構成（開発・公開側）

| ファイル | 役割 |
|----------|------|
| `index.html` | エントリ（モバイル / ZIP 共通） |
| `style.css` | UI・印刷（A4） |
| `app.js` | レポート管理・IndexedDB・ZIP |
| `lib/jszip.min.js` | ZIP 生成（同梱・CDN 不要） |

---

## 受入テスト（設計書より）

1. 写真 3 枚＋コメント → タブを閉じて再開 → 内容が残る  
2. オフライン PC で ZIP 展開後の `index.html` が開き、写真・コメントが見える  
3. PC でコメント変更 → 更新 ZIP → 再展開で内容が維持される  
4. `data.json` と HTML 埋め込み JSON が一致する（ZIP 出力時に同一ソースから生成）  
5. A4 印刷プレビューで写真とコメントが大きく分断されない  
6. 保存失敗時にトーストで異常が分かる  

---

## 注意

- IndexedDB は **端末内のみ**。消える可能性があるため **ZIP バックアップ** を推奨します。  
- ZIP 出力成功後もスマホ側データは自動削除しません。  
- PWA / ZIP 再インポートは設計書 Phase 3（任意）です。
