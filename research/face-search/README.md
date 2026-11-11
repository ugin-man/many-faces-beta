# Face-search engine research

動画から連続して得られる顔の特徴を入力として、大量の顔画像から近い顔を返す検索エンジンを研究する。Many Faces は、そのエンジンの応用システムとして位置付ける。

## 完了した実験と結果

**2026年11月11日、全70,000候補・全1,011有効queryの主実験3反復と、独立実行6 passが完了した。** [日本語の実測レポート](REPORT_JA.md)に全設定・不利な条件・初期化費用をまとめた。[Actions実行](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993)の全ステップも成功している。

- 同じglobal strict top-64を返す独立実行では、動画順の平均検索時間が **54.88 → 23.30 ms/query**。NumPy全件採点に対して **約2.36倍**、測定時間57.54%削減だった。
- 同じqueryのシャッフルでは **55.02 → 54.72 ms/query**でほぼ同速。元順でもp95は58.27 → 57.28 msで、遅いqueryの待ち時間はほぼ残った。
- 主実験のFaiss HNSW 512は **2.35 ms/query**、今回の1,011 queryでRecall@1は100%、平均Recall@64は93.34%だった。近い顔を1枚選ぶ用途では既存OSSが有力であり、自作方式が最速という結果ではない。

主実験と独立実行は条件が異なるため、値を混ぜずに報告する。1本の合成済み動画とサーバーCPU上の検索coreの結果であり、未知動画での品質・本人識別・本番アプリ全体の速度・アルゴリズムの新規性を確立したものではない。研究成果の範囲と次の検証課題はレポートに明記した。

最初のローカル実験は環境停止で未完了となり、完全な元記録を回収できなかった。Actionsでは元の入力hashを完全に再現し、別ハードウェアの新しい一組として最初から測定した。**中断前の部分結果は合算していない。** 実行履歴は[STATUS.md](STATUS.md)を参照する。

## 研究課題と参照結果

基準となる本番ソースは commit `ec97e233003e272cc203580953a180377945228d`。この版の[採点式](../../app/projection-matching.ts)の `projectionError(frame, candidate).strictTotal` を固定した検索対象とする。

- 候補は元の70,000レコードすべて。重複、欠落、不正な値を認めず、候補ID順を固定する。
- 各queryについて全70,000件を採点したglobal top-64を参照結果にする。同点は候補IDの順で解決する。
- 同じ抽出済みqueryを全方式へ渡し、全queryで結果を返す。
- queryの元順と、同じ全queryの固定シャッフル順を測る。NumPy PCG64、seed `20261111`。
- 1 CPUへのaffinity、計算ライブラリ1 thread、3反復を固定する。測定プロセスを並列に走らせない。
- 設定は [protocol.json](protocol.json) に固定する。有利なフレーム、seed、候補数、最速の反復だけを選ばない。

Recall@1 / @10 / @64は、固定した計算上のスコアの上位候補を回収した割合である。**同一人物の識別精度、人間が感じる顔の近さ、合成映像の知覚品質を表す値ではない。** 本研究の検索対象は、主に姿勢・表情・投影形状の近さになる。平均Recallに加えて、最悪フレームのRecallと上位1件のスコア超過量も報告する。

## 比較方式

| 方式 | 役割 |
| --- | --- |
| `exhaustive_strict` | 全候補を共通のfloat64 scorerで採点する参照検索。NumPyへの移植は本番JavaScriptと数値比較する。 |
| `temporal_exact` | 過去のanchor queryで得た全候補のスコアと、今回までの変化量の上限を使って候補を除外し、残した候補を今回のqueryで再採点する。 |
| Faiss `IndexFlatL2` + 再採点 | 固定した検索用ベクトルのL2距離で候補を得て、共通の `strictTotal` で再順位付けする。 |
| Faiss `IndexHNSWFlat` + 再採点 | 同じ検索用ベクトルで近似検索を行い、共通の `strictTotal` で再順位付けする。 |
| 現行video core | 本番のpose window、`ReviewStrictRanker`、window cacheをimportし、準備済みカタログ上の検索部分を測る。 |

**Faiss Flatがexactなのは検索用ベクトルのL2距離についてであり、`strictTotal` のglobal top-64についてではない。** `strictTotal` には複数の距離の和・最大値・queryに依存するwink係数が含まれるため、連結したL2ベクトルだけでは同じ順位を保証できない。FlatとHNSWには同じベクトル定義、候補数、再採点を使う。

Faissの候補数は `128 / 512 / 2048 / 8192` の全4点を保持する。HNSWは `M=32`、`efConstruction=200`、`efSearch=max(128, 2×候補数)` を固定する。この範囲での比較であり、あらゆるデータに最適なANN設定を検証したという主張ではない。

現行video coreの比較には、ネットワーク、画像の読み込み、wink補助カタログ、quality exclusion、ブラウザの待機、動画全体の経路最適化、合成描画を含めない。本番アプリ全体の速度として報告しない。各shard内の候補順は固定入力のID順であり、元ファイル内の順序をそのまま再現したものではない。

実装は [engines.py](engines.py)、[temporal_exact.py](temporal_exact.py)、[benchmark-current.mjs](benchmark-current.mjs) を参照する。

### 時間方向の情報を使う方式の根拠

数式と浮動小数点上の留保は [PROOF.md](PROOF.md) に記載する。距離の変化上限、最大値の変化上限、過去の計算の再利用を、既存の採点式へ適用した方式である。これらの一般的な考え方自体の新規性は主張しない。先行研究と現段階の貢献の範囲は [RELATED_WORK.md](RELATED_WORK.md) に記載する。

最初のqueryは全件検索する。以後、上位に入れないと判定できる候補を除外する。残存候補がデータベースの60%を超える場合は全件検索でanchorを更新する。急な姿勢変化、wink、場面転換で全件検索が増えた場合も、その結果を残す。

各順序・各反復の先頭で履歴を空にする。warmupはデータベース由来のqueryだけを使い、その後も履歴をリセットする。未来のフレーム、前の反復で得たquery結果、フレームの間引きは利用しない。

証明の式は実数演算についてのもの。実装ではfloat64と保守的な余裕幅を使い、実験で全件参照との不一致を検出したら失敗させる。有限の検証での一致を、あらゆる浮動小数点入力に対する形式的な保証と同一視しない。

## 入力の来歴と固定

入力映像は既存の `public/demo/many-faces-sample-30fps.mp4`。768×768、30 fps、全1,061フレームである。**この映像は既に顔を合成した公開サンプルであり、独立に収集した生の動画データセットではない。** 1本の診断から、一般の実動画や別の人物群への優位性まで主張しない。

v1の固定入力は、Native MediaPipe 0.10.32のCPU / IMAGEモードとOpenCV 5.0.0で作った。全フレームを連続decodeし、有効な顔特徴を得た1,011 queryをすべて使う。検出できなかった50フレームもmanifestへ記録する。

Nativeの行列をWebのcolumn-major配置に直した後、変更していない本番JavaScriptの `catalogFeatureFromResult` と `faceGeometryFromLandmarks` で検索入力へ変換する。projectionの縮小や量子化は行わない。本番の `filterVideoProfileIslands` は未来のフレームを参照するため、primary queryの選別には使わず、診断用の `appAdmitted` フラグだけを残す。固定入力ではこのフィルタによる追加除外は0件だった。

Native経路を使用したのは、元の環境でChromiumを起動できなかったためである。本番decoderとanalyzerを使う [prepare-queries.mjs](prepare-queries.mjs) も保存されているが、このブラウザ経路とv1 Native入力の数値一致は主張しない。ブラウザ経路へ切り替えた入力を、自動的に同じv1として扱わない。

70,000件の全shardとmanifestを基準commitのGit blob SHAと照合する。候補配列、query配列、ID・shard対応表、queryメタデータのhashは `protocol.json` の `input_lock` で固定されている。新しい環境では、query数が同じというだけでは合格にせず、指定されたhashをすべて確認する。

## ローカルでの再現手順

以下はリポジトリのルートで実行する。Linux、Python 3.12、Node.js 24、gitを使用する。研究コードを含むcommitをcheckoutし、そのcommit IDと実行環境を記録する。基準の本番commitだけにcheckoutを戻すと、研究ディレクトリは存在しない。

### 1. カタログと基準commitを用意する

`public/seed-catalog/manifest.json` と全shardが必要。sparse checkoutの場合は、次のディレクトリも取得する。

```sh
git sparse-checkout add app research public/demo public/mediapipe public/seed-catalog/shards
```

cone modeでは、shardsディレクトリの親にあるmanifestも取得される。shallow checkoutで基準commitのGit objectが存在しない場合は取得する。

```sh
git fetch origin ec97e233003e272cc203580953a180377945228d
```

projectionのfloat64 binaryだけで約524 MBある。元shard、依存関係、作業ファイル、全反復の結果を保存できるディスク領域を用意する。欠けたカタログを、小さなデータベースとしてそのまま測定しない。

### 2. 抽出用と検索用のPython環境を分ける

抽出用はNumPy 2.5.4、検索用はNumPy 2.3.5とFaiss 1.13.2を固定する。両方を同じ環境へ混ぜない。

```sh
python3.12 -m venv work/query-venv
work/query-venv/bin/python -m pip install -r research/face-search/prepare-queries-requirements.txt

python3.12 -m venv work/search-venv
work/search-venv/bin/python -m pip install -r research/face-search/requirements.txt
```

### 3. 全カタログと全動画のqueryを準備する

```sh
node research/face-search/export-data.mjs --catalog public/seed-catalog --out work/face-search

work/query-venv/bin/python research/face-search/prepare-queries-native.py \
  --video public/demo/many-faces-sample-30fps.mp4 \
  --model public/mediapipe/face_landmarker.task \
  --out work/face-search

node research/face-search/prepare-queries-native.mjs --out work/face-search
```

元のカタログを別の場所に置いた場合は、manifestと `shards/` のあるディレクトリを `--catalog` に渡す。Python抽出とJavaScript変換には同じ `--out` を渡す。抽出した動画・モデル・landmark列のhashは変換時にも確認する。

| 生成ファイル | 内容 |
| --- | --- |
| `candidates.features.f64` / `candidates.projections.f64` | `[70000,55]` / `[70000,936]` のlittle-endian float64 |
| `candidate-ids.json` / `candidate-shards.json` | 同じ順序の候補IDと元shard名 |
| `source-catalog-manifest.json` | 本番pose window用の元manifest |
| `queries.features.f64` / `queries.projections.f64` | `[1011,55]` / `[1011,936]` のlittle-endian float64 |
| `queries.json` | 元フレーム番号、時刻、roll補正、診断用フラグ |
| `catalog.manifest.json` / `queries.manifest.json` | 入力の来歴、設定、hash、全フレームの成否 |

別のライブラリ版・decoder・ハードウェアで入力hashが変わった場合は停止する。別入力で評価するなら、その違いを記録し、別のプロトコルとして明示する。v1のhashを自動で更新したり、検索結果を見ながら入力を選び直したりしない。

### 4. 採点式と履歴検索を検証する

```sh
work/search-venv/bin/python research/face-search/verify_strict_metric.py \
  --catalog public/seed-catalog \
  --out work/face-search/strict-metric-verification.json

work/search-venv/bin/python research/face-search/verify_temporal_exact.py \
  --data work/face-search \
  --out work/face-search/temporal-exact-verification.json

node research/face-search/benchmark-current.mjs --self-test
```

JavaScriptとNumPyの採点値・順位の比較、および実データと合成境界条件による履歴検索の検証を通してから測る。検証レポートと実装のhashが一致しない場合も進めない。コードを変更した場合は対応する検証をやり直す。

### 5. preflightと全3反復を実行する

```sh
work/search-venv/bin/python research/face-search/benchmark.py \
  --data work/face-search \
  --output work/face-search/preflight-manual-v1 \
  --prepare-only

work/search-venv/bin/python research/face-search/run-experiment.py \
  --data work/face-search \
  --output work/face-search/experiment-manual-v1
```

`--prepare-only` は固定入力と検証済みscorerを確認し、PythonとNodeが共用する `orders.json` を作る。runnerは1 CPUにaffinityを固定し、計算ライブラリのthread数を1にして、新しいPython・Nodeプロセスを順番に実行する。通常のvenvでは `--python-dependencies` は不要。この引数は `pip --target` などで依存を別の場所へ置いた場合だけに使う。

既存の実験出力は上書きしない。再実行は別の出力ディレクトリへ保存し、失敗したrunも残す。`--smoke-queries` は動作確認専用であり、完全な実験結果に含めない。

現行coreだけを診断する場合は、共通の `orders.json` 作成後に次のCLIを使える。正式な1 CPU条件での比較は上記runnerから行う。

```sh
node --max-old-space-size=4096 research/face-search/benchmark-current.mjs \
  --data work/face-search \
  --order-file work/face-search/orders.json \
  --repetitions 3 \
  --output work/face-search/current-core-diagnostic.json
```

### 6. 主実験を検証・集計し、独立実行controlを行う

主実験が全3反復を完了してから、同じcheckout・入力・検索venvで実行する。

```sh
work/search-venv/bin/python research/face-search/summarize_remote.py \
  --experiment work/face-search/experiment-manual-v1 \
  --data work/face-search \
  --output research/face-search/results/manual-v1

work/search-venv/bin/python research/face-search/isolated_control.py \
  --experiment work/face-search/experiment-manual-v1 \
  --data work/face-search \
  --output work/face-search/isolated-manual-v1 \
  --publish research/face-search/results/manual-v1/isolated
```

これらの補助スクリプトは環境停止後の新規実装であり、以前のローカル集計器を復旧したものではない。主実験の全候補配列と計時行を検査してから数値を公開する。追加controlは保存済みoracleを用いて全64件のID順位とscoreを照合し、独立した6 passがすべて完了するまで成功した集計として扱わない。

## 計時の範囲と順序効果

検索時間にはquery記述子の作成、候補検索、共通スコアによる再採点、上位候補の選択、返却形式への変換、履歴更新を含める。動画decode、顔特徴抽出、カタログ読み込み、候補記述子の作成、index構築は別に報告する。検索時間からアプリの合成fpsや動画全体の処理時間を直接導かない。

平均・中央値・p95・最大遅延、採点した候補数、全件検索へのfallback数を記録する。共有descriptorや複数方式のindexを同じプロセスに置くので、process peak RSSを単一方式だけのメモリ量として扱わない。Python / NumPy / FaissとNodeの比較は、実装されたエンジンの比較であり、言語やnative kernelの差を除いた純粋なアルゴリズム比較ではない。

### v1は完全なcounterbalanceではない

v1のPython方式群は、同じqueryに対して各方式を交互に実行するinterleaved条件である。方式の並びを循環シフトするが、直前の方式との隣接関係は多くのqueryで維持される。各方式が誰の直後に走るかを完全に均衡させた設計ではない。現行Node coreは別プロセスで測る。

途中の診断で、Temporalが全件検索の直後に走る機会が多いことが分かった。直前の処理によるメモリやcacheの状態などが計時へ影響する可能性があり、候補を十分に除外できていない場合の速度差も、そのまま手法固有の高速化とは解釈できない。

このため、exactな全件検索とTemporalの性能結論には、方式ごとに別プロセスで動画全体を処理する独立実行controlを優先する。controlはv1の観測後に設計する追加診断であり、最初から登録済みの実験、独立した別動画、完全な順序均衡の証明として扱わない。停止した元環境ではcontrolを実行しておらず、新しいActions環境で6 passを完了した。

v1の全結果は「循環シフトを伴う交互実行という条件下の観測」として残し、controlの値と混ぜて平均しない。不利な反復を捨てたり、元の結果をcontrolで置き換えたりしない。1本の動画の1,011フレームを、1,011本の独立した動画のように統計処理しない。

## Actionsのartifactと公開結果

2026年11月11日の[run 43021151993](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993)は全ステップ成功。元の結果ファイルを回収し、ログ中のファイルmanifestに対してbyte数とSHA256の一致を確認した上で、数値summary・全queryの圧縮CSV・自動レポートをgitにも保存した。

| 区分 | 保存先 |
| --- | --- |
| 日本語の実測と解釈 | [REPORT_JA.md](REPORT_JA.md) |
| 主実験の公開結果 | [results/actions-v1/](results/actions-v1/) |
| 独立実行の公開結果 | [results/actions-v1/isolated/](results/actions-v1/isolated/) |
| 公開ファイルのhashと来歴 | [PUBLIC_MANIFEST.json](results/actions-v1/PUBLIC_MANIFEST.json) |
| 実行・中断記録 | [STATUS.md](STATUS.md) |

入力・検証の詳細は[診断artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993/artifacts/13855361109)、数値計測ファイル群は[計測artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993/artifacts/13857236753)にもある。artifactの期限は2027年2月9日であり、gitに保存した結果はその期限に依存しない。生の特徴、landmark、候補IDを含む返却配列、oracle、matches NPZは公開artifactに含めない。runner内workディレクトリの永続性は保証せず、固定した公開入力とコードからの再現を基本とする。

公開するqueryごとの測定行には、query番号と数値指標だけを含む。未完了・入力不一致・検証失敗のrunは成功したベンチマークへ混ぜない。本番アプリへの研究エンジンの統合やスマートフォン上のend-to-end評価は、このPRの完了範囲には含まれない。

## Actionsでの今後の再計測

長時間の研究workflowは、結果保存後の自動再実行を避けるため、手動の `workflow_dispatch` で起動する。既存の通常CIはそのまま自動実行する。今後の公開用作業出力はrun IDとrun attemptで分けた `work/face-search/` 内の新規ディレクトリへ生成し、gitに保存した今回の `results/actions-v1/` を上書きしない。新しい計測値を今回のsummaryへ追記・合算する処理も行わない。

GitHubの[workflow_dispatchの仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)では、workflowファイルがdefault branchに存在することが必要になる。マージ前の再現には上記のローカル手順を使える。今回成功したrunとその測定commitは、workflowの手動化前のものとして保持する。

元のソフトウェアとカタログの利用条件は、リポジトリの `LICENSE`、`DATA_LICENSE.md` と該当するデータのライセンスを参照する。
