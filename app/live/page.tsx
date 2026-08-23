import LiveFaceLab from "../live-face-lab";

export const metadata = {
  title: "Many Faces Realtime Lab",
  description: "カメラまたは動画をFace Meshで追跡し、実写70,000枚のカタログから近い別人の顔をリアルタイム表示する実験画面。",
};

export default function LivePage() {
  return <LiveFaceLab />;
}
