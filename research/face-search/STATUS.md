# 実装・実験の完了状態と実行履歴

更新: 2026年11月11日。現在の状態: **主実験・独立実行とも完了し、数値と全結果の検証に成功。**

## 完了した成果

[日本語の実測レポート](REPORT_JA.md)、[主実験summary](results/actions-v1/summary.json)、[独立実行summary](results/actions-v1/isolated/summary.json)、それぞれの全query数値CSVを保存した。[公開ファイルmanifest](results/actions-v1/PUBLIC_MANIFEST.json)には回収した元レポートのbyte数とSHA256を記録した。

[GitHub Actions run 43021151993](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993)の全ステップは成功した。元の入力hashを完全に再現し、全70,000候補、1,011有効query、主実験11方式×2順序×3反復、独立実行6 passを検証した。主実験66,726件、独立実行6,066件の数値行を保持している。

同じ上位64件を返す独立実行では、元順で平均54.88 → 23.30 ms/query（約2.36倍）。シャッフルでは55.02 → 54.72 msでほぼ同速だった。主実験でHNSW 512は平均2.35 ms、Recall@1は100%、平均Recall@64は93.34%。この1本の入力・固定スコア・実装条件での結果であり、アプリ全体の速度や世界最速の主張には使わない。

## コードと測定の来歴

| 区分 | commit / 実行 |
| --- | --- |
| 本番スコアの基準 | `ec97e233003e272cc203580953a180377945228d` |
| 最初に保存した研究core | `53850572afbc4278c686a9434089d3ae2eb76358` |
| 完了runの研究ブランチhead | `e9b4daa5cef5f490eecc57f1812c8b1ee16cf876` |
| 実際のActions checkout（PR merge commit） | `8f5d19abc5c2089fceab6a0b8678562a7552fdb2` |
| 完了run | [43021151993](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993) |
| 既存CI（同じ研究head） | [43021151885](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151885)、成功 |
| PR | [draft #6](https://github.com/ugin-man/many-faces-beta/pull/6)、#5をbaseとする |

主要4つのPython採点・計時ファイルと元プロトコルは、環境停止の前後で変更していない。新しい集計器・独立実行control・workflow・文書は復旧過程で新規実装したもので、停止前の未回収ファイルをバイト単位で復元したものではない。結果保存のcommitは測定後の文書・データ追加と、今後の再実行workflowの起動方法・出力先の整備を含む。採点・計時ソースと元プロトコルは変更せず、測定commitとは別に記録する。

## 最初のローカル実験の中断

ローカルの主実験はPython方式群とNode coreの各2反復が完了し、Python第3反復の元順301 / 1,011 queryまで進んだことを最後に確認した。2026年11月11日12:04–12:05 UTC頃、実行環境の接続が切れ、以後の状態取得とファイル読出しが `No usable execution environment is available` で失敗した。

その環境での完全な元記録は回収できていない。削除されたとも、その後に全計測が完了したとも断定しない。この最初の試行は**未完了・元記録未回収**として残し、途中でチャットに表示した数値を最終ベンチマークへ採用しない。独立実行controlも中断前の環境では実行していない。

新しいActions runは12:32 UTC頃に開始し、13:03 UTC頃までに全手順を終了した。これは別ハードウェアでの完全な再実行であり、中断前の部分結果と合算していない。

## 計時順序の懸念と追加診断

主実験の循環シフトは各方式の開始位置を変えるが、方式同士の隣接関係を完全には均衡させない。元環境の途中観測では、全件検索直後の実行が時間方向の方式へ有利に働く可能性があった。この循環実行を完全な順序均等化とは呼ばない。

その観測後、元順E→T→T→E、シャッフルT→Eを、それぞれ別の新規プロセスで動かす診断を追加した。元順は各2反復、シャッフルは各1反復。保存済みoracleとの照合はタイマーの外で行い、主実験の計測値と混ぜない。この診断は外部の事前登録実験ではない。

新しいマシンでは、元順の主実験E/T比2.376と独立実行2.355は近かった。シャッフルはそれぞれ1.019と1.005だった。過去の途中観測を、新しい環境で同じ大きさの順序効果が確認されたかのように扱わない。独立実行では競合ANN indexの割当もなくなるため、差のすべてをキャッシュだけの因果効果とも解釈しない。

## 保存した証拠

- [入力診断artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993/artifacts/13855361109): 入力manifest、抽出metadata、数値検証、preflight。87,851 bytes。
- [計測artifact](https://github.com/ugin-man/many-faces-beta/actions/runs/43021151993/artifacts/13857236753): 数値測定と集計・診断。2,020,628 bytes。
- artifactの期限: 2027年2月9日。元の公開用6ファイルはSHA256を照合し、gitにも保存した。
- 顔画像・特徴配列・oracle・返却候補IDを含むmatches配列は公開artifactに含めない。runnerのprivate work配列が永続保存されたとは主張しない。
- 再現方法と検証コマンドは[README.md](README.md)に記載する。

## 今後のworkflow

研究用の長時間計測は手動起動にし、run ID・attempt別の新規work出力へ保存する。これにより文書や結果の保存で研究実験が繰り返し走ること、および保存済みactions-v1への上書き拒否による再実行失敗を避ける。通常のリポジトリCIは変更していない。今回完了した数値は以前の測定commitのものであり、この起動・出力整理によって再測定した値ではない。
