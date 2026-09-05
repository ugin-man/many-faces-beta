import LiveResponsiveLab from "../../live-responsive-lab";

export const metadata = {
  title: "Many Faces Astra Realtime Preview",
  description:
    "Astra hardening branch realtime preview. Camera behavior is experimental until the physical-camera and browser E2E gates pass.",
};

export default function AstraRealtimePage() {
  return <LiveResponsiveLab />;
}
