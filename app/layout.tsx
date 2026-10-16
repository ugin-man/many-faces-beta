import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "./language";
export const metadata: Metadata = {
  title: "Many Faces — A new face for every moment",
  description: "Replace faces in your videos with photos from a 70,000-face catalog, right in your browser.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#08090b" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><LanguageProvider>{children}</LanguageProvider></body></html>;
}
