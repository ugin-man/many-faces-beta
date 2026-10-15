from __future__ import annotations

from pathlib import Path

TARGET = Path("app/live/review-client-lite.tsx")
MARKER = '目的フレームの描画待ちがタイムアウトしました'


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print("astra hardening already applied")
        return

    old_promise = '''  return new Promise<void>((resolve) => {\n    const source = video as VideoWithFrameCallback;'''
    new_promise = '''  return new Promise<void>((resolve, reject) => {\n    const source = video as VideoWithFrameCallback;'''
    if text.count(old_promise) != 1:
        raise SystemExit("waitForDecodedVideoFrame promise signature drifted")
    text = text.replace(old_promise, new_promise, 1)

    old_timeout = '''    const timeout = window.setTimeout(finish, 2_500);'''
    new_timeout = '''    const timeout = window.setTimeout(() => {\n      if (settled) return;\n      settled = true;\n      if (callbackId !== null) source.cancelVideoFrameCallback?.(callbackId);\n      reject(new Error("目的フレームの描画待ちがタイムアウトしました"));\n    }, 2_500);'''
    if text.count(old_timeout) != 1:
        raise SystemExit("decoded-frame timeout implementation drifted")
    text = text.replace(old_timeout, new_timeout, 1)

    TARGET.write_text(text, encoding="utf-8")
    print("applied astra decoded-frame timeout hardening")


if __name__ == "__main__":
    main()
