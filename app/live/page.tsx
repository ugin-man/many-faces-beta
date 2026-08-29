import LiveReviewClient from "./review-client";

export const metadata = {
  title: "Many Faces Five-Second Faithful Review",
  description: "5秒のカメラ入力を動画版と同じstrict処理で最後まで解析し、処理時間とは切り離して実時間再生する品質確認画面。",
};

export default function LivePage() {
  return <LiveReviewClient />;
}
