# Many Faces

動画の顔の向きや表情に合わせて、7万枚の写真から顔を選んで合成するブラウザアプリです。背景と身体を残したまま、さまざまな人の顔へ切り替わります。

**[Many Facesを開く](https://many-faces-prototype.uginn-poppo.chatgpt.site)** · [処理済みサンプル](https://many-faces-prototype.uginn-poppo.chatgpt.site/demo) · [使い方](docs/USER_GUIDE.md)

## できること

| 入口 | 動作 |
| --- | --- |
| 動画を選ぶ | 手元の動画をブラウザ内で解析し、顔の位置・向き・表情に合わせて写真を合成します。画像保存、動画保存、コマ送りに対応します。 |
| 右上のサンプル | 合成済みの35.4秒・30fpsのMP4をそのまま再生します。解析やカメラの許可は不要です。 |
| リアルタイム（デモ） | カメラの動きに合わせて写真を表示する実験機能です。端末性能やカメラ環境に影響されます。 |

合成前の個人動画と、その顔の解析キャッシュは現在の配布物に含めません。サンプルは全1,061コマを合成した768 × 768の無音動画です。元動画をダウンロードして再合成する仕組みは廃止しました。

## 使い方

1. 「動画を選ぶ」から動画を開きます。初回は解析モデルと写真の取得に時間がかかります。
2. 解析完了後に再生・シーク・コマ送りで確認します。設定で解析密度や表示方法を変更できます。
3. 「画像保存」または「合成動画保存」で保存します。合成動画は音声なしです。

動画解析の初期値は30fpsです。顔写真の回転で首の傾きを合わせ、位置・大きさ・角度をフレーム間で補間します。短く動きが小さい検出抜け以外や、写真の読み込みが欠けた区間は、直前の合成済みフレームを保持します。最初の合成前は保護画面を表示します。横顔の急な反転が不確かな場合も前後の検出を確認し、保護済み画面を保持します。任意の入力に対する匿名化の保証はないため、共有前に出力全編を確認してください。

## 開発

Node.js 22.13以上とLinuxの標準ビルドツールが必要です。

```bash
npm ci
npm run dev
```

通常のGit cloneには7万枚のカタログが含まれます。サンプル再生には顔解析モデルは不要です。動画解析・カメラ用モデルはブラウザで取得します。オフライン配置や本番ビルドの詳細は [開発ガイド](docs/DEVELOPMENT.md) を参照してください。

```bash
npm test
npm run lint
```

主要CIはNode/Pythonの回帰テスト、ビルド、サンプル再生・通常動画アップロードのブラウザテスト、仮想カメラによるリアルタイム検証です。ブラウザテストには個人の未加工動画を使いません。

## 構成

- `app/` — 動画の解析・合成、処理済みサンプルのプレイヤー、カメラデモ
- `public/demo/` — 公開用の合成済みMP4、ポスター、検証用メタデータ
- `public/seed-catalog/` — 70,000枚の写真、3度刻み・775セルの索引と特徴量
- `worker/` — カタログとモデルの配信、廃止した素材URLの遮断
- `tests/` — 合成・検出欠落・向き・入力・カタログの回帰テスト
- `data/` — データの説明、出典、ライセンス
- `.github/archive/workflows/` — 過去の一回限りの移行・収集・比較手順。自動実行されません。

旧実験のレポートは当時の記録です。現在の仕様はこのREADMEと [使い方](docs/USER_GUIDE.md)、[開発ガイド](docs/DEVELOPMENT.md) を基準にしてください。

## データとライセンス

ソフトウェアは [MIT License](LICENSE)、写真カタログは別の [データライセンス](data/LICENSE.md) に従います。FFHQ由来のデータにはCC BY-NC-SA 4.0と元画像のライセンスが適用されます。非商用の創作・実験向けで、商用利用や人物の識別・認証用には使えません。補助画像の出典はアプリの設定内から確認できます。

入力動画の扱い、保存内容、過去版の削除状況は [プライバシーと配布](docs/PRIVACY.md) にまとめています。

### Display language / 表示言語

The interface starts in English, regardless of browser language. Open **Settings → Language / 言語** to select English or 日本語. The choice is remembered on this browser when local storage is available. Switching language keeps the current video and playback position.

初期表示は英語です。**Settings → Language / 言語** から日本語に切り替えられます。選択は同じブラウザに保存されます。

### 60 fps video mode

Choose **Settings → Analysis rate → 60 fps** before selecting a video, or change the rate after processing to analyze the current video again. Analysis, timeline stepping and the capture-stream export target use the selected rate. The default remains 30 fps. The 60 fps export target uses 6 Mbps; actual frame delivery depends on browser rendering and encoding performance. A 30 fps source cannot gain new captured motion detail by selecting 60 fps. The prepared sample remains its original 30 fps, and the realtime demo is unchanged.
