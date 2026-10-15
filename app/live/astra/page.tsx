import Studio from "../../studio";
export const metadata = { title: "Many Faces — リアルタイム（デモ）", description: "カメラの動きに写真を合わせる実験的なリアルタイムモード。" };
export default function RealtimePage() { return <Studio initialMode="camera" />; }
