import LiveResponsiveLab from "../live-responsive-lab";

export const metadata = {
  title: "Many Faces Responsive Realtime Lab",
  description: "静止中は顔を保持し、動作中は実写70,000枚のカタログを12〜20fps相当で追従するリアルタイム実験画面。",
};

export default function LivePage() {
  return <LiveResponsiveLab />;
}
