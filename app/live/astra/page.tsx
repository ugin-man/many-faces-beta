import AstraRealtimeClient from "./client";

export const metadata = {
  title: "Many Faces — Realtime Preview",
  description: "端末内の別スレッドで顔を解析し、新しいカメラフレームに追従するMany Facesの動作確認画面。",
};

export default function AstraRealtimePage() {
  return <AstraRealtimeClient />;
}
