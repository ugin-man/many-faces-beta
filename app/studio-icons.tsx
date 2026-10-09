import type { SVGProps } from "react";
export type IconName = "back" | "camera" | "video" | "play" | "pause" | "stop" | "upload" | "sample" | "settings" | "info" | "close" | "next" | "previous" | "expand" | "shrink" | "mirror" | "eye";
const paths: Record<IconName, React.ReactNode> = {
  back: <path d="m14 5-7 7 7 7" />,
  camera: <><path d="M4 7h11v10H4zM15 10l5-3v10l-5-3" /></>,
  video: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="m10 8 6 4-6 4z" /></>,
  play: <path d="m8 4 12 8-12 8z" />,
  pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
  sample: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3z" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  next: <><path d="m5 5 11 7-11 7zM19 5v14" /></>,
  previous: <><path d="m19 5-11 7 11 7zM5 5v14" /></>,
  expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
  shrink: <path d="M3 9h6V3m6 0v6h6M9 21v-6H3m12 6v-6h6" />,
  mirror: <><path d="M12 3v18M8 6 3 18h5zm8 0 5 12h-5z" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
