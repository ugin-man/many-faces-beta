import LiveFaithfulLab from "../live-faithful-lab";

export const metadata = {
  title: "Many Faces Faithful Live Baseline",
  description: "動画版と同じ3D形状比較とstrict経路最適化を、フレームを捨てないFIFOでカメラ入力へ適用する基準実装。",
};

export default function LivePage() {
  return <LiveFaithfulLab />;
}
