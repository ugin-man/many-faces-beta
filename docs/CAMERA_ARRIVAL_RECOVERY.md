# カメラ入力の8秒誤停止 — 2026-10-04 JST

## 対象と変更範囲

`ugin-man/many-faces-beta` / `astra/realtime-hardening`。ユーザーは既存の動画検証が動くことを確認済みで、リアルタイムだけが「8秒間入力なし」で停止すると報告した。

変更前: `de063df626617178c6296f660eb3931d73feb3c8`。
入力の修正コミット: `e1fcd881c7bed83cbda4ca730927a02a62f4deaa`。
専用の新旧ブラウザ比較を完了したコミット: `6ec69885d26759762940abe4031dab9908a72036`。後続2コミットはCIの実行順・失敗ログ表示のみで、入力の実装はe1fcd88から変わっていない。

アプリの変更は次の3ファイルだけ。

- `app/live/frame-arrival.ts`: 入力到着の識別を独立した処理へ分離。
- `app/live/media-input.ts`: 再生時刻だけに依存しないフレームポンプ。
- `app/runtime-identity.ts`: versionを `camera-arrival-v3` に更新。

動画検証の実装、動画検索Worker、停止フレームの取り出し、画面UI、7万枚の資産、固定動画は変更していない。カタログのGit treeは `559f7f39e3a8eed452ef7eb6a3355a318235c307` のまま。main/baseへのマージ、Siteの再公開はしていない。

## 再現した実装不具合

旧コードはコールバックの `mediaTime` をフレームIDとして使い、前回と同じ値なら解析も入力到着時刻の更新も行わなかった。一方、コールバック自体が続くと、`video.currentTime` を見る代替経路も起動しない。

ライブストリームではmediaTimeが0になることが認められている。[rVFC仕様のmediaTimeとpresentedFrames定義](https://wicg.github.io/video-rvfc/#dictdef-videoframecallbackmetadata)。つまり「時刻が同じ」と「新しい映像がない」は同じ条件ではない。

修正版はcompositorの `presentedFrames` とデコードされたフレーム数の増加を先に使う。非対応環境ではpresentationTime、最後に再生時刻を用いる。フレームポンプの第2引数は実時刻ではなく単調増加の到着番号になった。現在の呼び出し元はこれを重複判定にだけ使い、推論時刻には引き続きperformance.now系のcapturedAtを渡す。

フレーム到着の証拠が増えない限り、タイマーが回っただけでは生存扱いにしない。カウンターが利用できる場合、単なる再生時計の増加で停止を隠さない。入力/推論の8秒監視そのものは延長も撤去もしていない。静止した顔を入力停止と扱うピクセル差分方式も使っていない。

## 実行済みの比較

[Camera arrival regression 37140258365](https://github.com/ugin-man/many-faces-beta/actions/runs/37140258365) は全工程success。

実際のChromiumのgetUserMedia仮想カメラ、MediaPipe、変更していない全7万枚を使用した。刺激映像は公開カタログ写真から生成した既存CI用素材。時刻/カウンターAPIの挙動だけを故障注入し、入力画像・顔検出・検索結果は偽装していない。これはユーザーの物理カメラでの検証ではなく、同じエラーを起こすコード経路の再現である。

| ケース | 実際の結果 |
| --- | --- |
| 旧版: 実フレームの通知は続くがmediaTimeを0に固定 | 約8.169秒でVIDEO_FRAMES_STALLED。実際には243回のコールバックが到着。解析は1フレーム、出力0回で停止 |
| 修正版: 同じmediaTime=0条件 | 11.503秒時点でrunning、227フレーム解析、29回の画像更新、画像失敗0 |
| 修正版: 通知なし・currentTime=0、ネイティブのデコード数は増える | 11.501秒時点でrunning、219フレーム解析、27回の画像更新、画像失敗0 |
| 修正版: 通常のネイティブ通知 | 11.503秒時点でrunning、226フレーム解析、29回の画像更新、画像失敗0 |
| 修正版: フレーム更新を示す全情報を固定する負例 | 約8.282秒でVIDEO_FRAMES_STALLED。タイマー/コールバックだけで監視を回避しないことを確認 |

負例の停止後は全カメラトラックが解放された。入力情報を復帰させて再開すると出力した。各正例でも明示的停止・動画モードへの切り替えとトラック解放を確認。全ケースで同時解析は最大1フレーム。未捕捉のページ例外0。

最終実行のbuild、全162テスト（162 pass、skip/fail 0）、lint、動画実装とカタログが不変である照合も成功。lintの成功は既存警告が0という主張ではない。

[検証artifact 11280059515](https://github.com/ugin-man/many-faces-beta/actions/runs/37140258365/artifacts/11280059515): `camera-arrival-37140258365`、1,594,538 bytes、GitHubのSHA-256は `a66aefd6dd59dd23550a5fce181982de5116062c359a997a35307b570300d36e`。JSONの実測値はジョブログでも確認した。スクリーンショットの目視検査を行ったという主張はしない。

同じアプリ実装e1fcd88で、[既存の動画停止回帰 37139901306](https://github.com/ugin-man/many-faces-beta/actions/runs/37139901306)、[全画面UI検証 37139901262](https://github.com/ugin-man/many-faces-beta/actions/runs/37139901262)、[入力互換性の回帰 37139901258](https://github.com/ugin-man/many-faces-beta/actions/runs/37139901258)、[通常CI 37139904937](https://github.com/ugin-man/many-faces-beta/actions/runs/37139904937) もsuccessだった。

初回専用CIはビルド前にビルド済みserverをimportする13テストを起動したため、ERR_MODULE_NOT_FOUNDで失敗した。元の失敗ログを回収して原因を確認し、build→testへ修正した。浅いcloneで比較元がない問題もfetchの実行順で修正。テストを削ったりアプリをCI中に書き換えたりしたのではない。

## 既存Siteへ渡す情報

既存Siteの `/api/runtime` を2026-10-03 17:25:54 UTCに読み取った応答は次のとおり。

- version: `verification-recovery-v2`
- build: `e770b732d1eece8f`
- revision: `63f10b8b21fcc891e8d98da279af58df4c0d7524`

これは新しい `camera-arrival-v3` ではない。上記revisionはこのGitHubリポジトリでは見つからず、ホスト側の正確なソース差分までは確認できていない。この応答だけを理由に「Workの公開処理が壊れている」とは判断しない。

Workでは既存Siteと動画側の修正・公開設定を保持し、上記3ファイルの入力修正を取り込んで再ビルドする。既存に独自のカメラ修正があれば差分を確認して統合し、無条件に上書きしない。新しい別アプリや軽量版は不要。

検証した変更なしのアプリbuildは `23fcb915a052a01b`、versionは `camera-arrival-v3` で、ブラウザと推論Workerのbuildが一致した。ホスト独自のソース変更がある場合はbuild値が変わり得るが、同じ公開単位のクライアント/サーバー/Workerが一致すること、フレーム到着修正が入っていることを確認する。

## 境界

ユーザーの物理カメラでmediaTime=0が起きていたかは診断データ未取得のため断定しない。今回の正例は約11.5秒の回帰テストで、長時間安定性・Safari実機・追従品質が完成したという主張ではない。Siteはこの作業では再公開しておらず、ユーザーのカメラが直ったことはまだ確認していない。新しい版で同じエラーが残る場合は、停止前の小窓映像が動いているかと、保存した診断JSONで実入力停止/到着認識/推論停止を切り分ける。
