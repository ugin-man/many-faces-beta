# 開発ガイド

## 実行と配布

Node.js 22.13以上、npm、Linuxのbash/coreutilsを使用します。依存はpackage-lock.jsonに固定しています。通常のcloneにはフルカタログが含まれます。最小CIのsparse checkoutではカタログ本体を省き、フルカタログのブラウザQAを別ジョブで実行します。

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npm start
```

本番用の顔解析モデルを同梱する場合は以下を実行します。サンプル専用プレイヤーには不要です。

```bash
mkdir -p public/mediapipe/wasm public/models
cp -a node_modules/@mediapipe/tasks-vision/wasm/. public/mediapipe/wasm/
curl -fL --retry 3 -o public/models/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

Sitesの配布ではカタログ本体を固定リビジョンとハッシュで検証しながら取得する構成を使用しています。GitHubの通常ビルドは同梱カタログを使用します。カタログの件数・角度・特徴量をUI変更のために簡略化しないでください。

## 現在の入口

- `/` と `/live`：自分の動画を選んで合成するStudio。
- `/demo`：解析不要の処理済みMP4。
- `/live/astra`：リアルタイム（デモ）。

`demo-client.tsx` が通常の動画合成を担当します。過去の `review-client-lite.tsx` と `offline-video-lab.tsx` は実験・回帰比較用で、現在のStudioの入口ではありません。

## 保護フレーム

`video-pose-continuity.ts` は短い誤方向の検出区間を除外します。`demo-face-composite.ts` は完全に合成できたフレームだけを更新し、欠落・読込失敗時には保護済みフレームを保持します。初回の未合成時には保護画面を表示します。シーク時にも対応する保護済みフレームを使います。

回帰テストは一般化した姿勢数値と合成処理を検証します。個人のFace Meshや未加工の動画をテスト資産に追加しないでください。

## 公開サンプル

`public/demo/sample.json` にMP4のSHA-256、フレーム数、解析密度、形式を記録しています。30fpsで699コマを描画し、映像のみをH.264へ圧縮しました。ポスターも合成後のフレームです。

差し替え時には全フレームを確認し、`ffprobe` で30/1・699フレーム・音声トラックなしを検証します。`scripts/render-processed-sample.mjs` は明示された `SAMPLE_SOURCE` のみを受け付けます。元動画は `private-inputs/` などGit管理外に置き、元動画・顔の解析データ・未加工スクリーンショットを成果物へ含めないでください。

## CI

- `ci.yml`：ビルド、Node回帰テスト、Python回帰テスト、lint。
- `demo-face-composite.yml`：完成済みサンプルの即時再生、保存、スマホ表示、廃止URL遮断、通常動画アップロード・合成保存。
- `astra-realtime-hardening.yml`：フルカタログと公開写真から作る仮想カメラの検証。
- `astra-input-regressions.yml`：入力処理の回帰検証。

古いカタログ移行や固定コミット比較のworkflowは `.github/archive/workflows/` に記録を残して停止しています。再利用前に入力、権限、成果物に個人情報が含まれないことを確認してください。過去の結果を今回のUIの検証結果として流用しないでください。
