import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, translate } from '../app/translations.ts';

test('only an explicit Japanese preference overrides the English default', () => {
  for (const value of [null, undefined, '', 'en', 'ja-JP', 'fr', '{}']) assert.equal(normalizeLanguage(value), 'en');
  assert.equal(normalizeLanguage('ja'), 'ja');
});
test('stored progress and error messages translate without mutating engine state', () => {
  const message='採用画像を準備中 4 / 20';
  assert.equal(translate(message,'en'),'Preparing selected photos 4 / 20');
  assert.equal(translate(message,'ja'),message);
  assert.equal(translate('「録画をFace Meshで解析中」で90秒以上進捗がありません。処理を停止しました。','en'),'No progress during “Analyzing video with Face Mesh” for 90 seconds. Processing stopped.');
  assert.equal(translate('入力映像を再生できませんでした（media code 4）。','en'),'Could not play the video input (media code 4).');
  assert.equal(translate('カメラの許可がありません。サイトとOSのカメラ設定を確認してください。埋め込み表示の場合は別タブで開いて試してください。','en'),'Camera permission was denied. Check site and system camera permissions. If embedded, try opening the site in a new tab.');
  assert.equal(translate('Unknown browser error','en'),'Unknown browser error');
});
