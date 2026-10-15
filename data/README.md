# 顔写真カタログ

現在のカタログIDは `many-faces-clean-core-v5-28e6092363ed981f-pose-local-v1` です。通常のGitHub cloneには写真パックと索引を含みます。Sitesでは同じデータを固定リビジョン・ハッシュ付きで取得します。

| 項目 | 現在の値 |
| --- | ---: |
| 写真 | 70,000枚 |
| 検索可能な顔 | 70,000件 |
| 角度の刻み | 3度 |
| 角度セル | 775 |
| JSON shard | 775 |
| 画像パック | 775 |
| 検索特徴量 | 55 |

`SHA256SUMS` は現在のmanifest、shard、画像パックのSHA-256です。Git LFSは使用しません。

```bash
npm run catalog:validate -- ./public/seed-catalog
sha256sum -c data/SHA256SUMS
```

[データセットカード](DATASET_CARD.md) と [データライセンス](LICENSE.md) を参照してください。以前の収集・比較結果は履歴資料であり、現在の件数や配布内容の根拠には使用しないでください。
