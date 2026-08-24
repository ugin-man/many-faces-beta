import FaithfulLiveClient from "./faithful-client";

export const metadata = {
  title: "Many Faces Offline-Faithful FIFO Live",
  description: "動画版と同じ3D投影比較とstrict経路最適化を、全画角のカメラ入力・遅延許容FIFO・確定先読み付きで順番に実行する基準実装。",
};

export default function LivePage() {
  return <FaithfulLiveClient />;
}
