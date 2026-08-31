import LightweightReviewClient from "./review-client-lite";

export const metadata = {
  title: "Many Faces Lightweight Five-Second Review",
  description: "起動時に70,000枚を展開せず、5秒録画のFace Mesh解析後に必要な角度のshardだけを読み込んで連続再生する品質確認画面。",
};

export default function LivePage() {
  return <LightweightReviewClient />;
}
