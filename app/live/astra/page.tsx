import Studio from "../../studio";
export const metadata = { title: "Many Faces — Realtime (Demo)", description: "An experimental realtime mode matching photos to your camera movements." };
export default function RealtimePage() { return <Studio initialMode="camera" />; }
