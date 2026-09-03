#!/usr/bin/env python3
"""Replace implementation-heavy review copy with a compact user-facing UI."""

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

replacements = {
    "MANY FACES / 5 SECOND REVIEW": "MANY FACES / MOTION REVIEW",
    "重い処理は後回し。まず5秒だけ撮る。": "5秒で、動きのつながりを確認する。",
    "起動時に70,000枚を展開しません。録画をFace Meshで解析した後、必要な角度のshardだけを読み込みます。": "固定動画またはカメラの5秒を解析し、元映像と変換結果を同じ時間軸で並べます。",
    "1 撮影": "1 入力",
    "2 処理": "2 解析",
    "3 確認": "3 再生",
    "5秒撮って、あとから連続再生": "5秒の動きを、連続した結果で見る",
    "5秒レビュー": "動画を選ぶか、5秒撮影",
    "カメラを押すだけ。モデルやカタログの準備完了は待たなくて大丈夫です。": "固定動画の選択が確実です。カメラ撮影は補助的に利用できます。",
    "処理の詳細": "詳細データ",
    ">VIDEO<": ">動画版<",
    ">FIFO<": ">FIFO<",
    ">FAST<": ">高速版<",
}

for old, new in replacements.items():
    text = text.replace(old, new)

PATH.write_text(text, encoding="utf-8")
print("Review UI copy simplified.")
