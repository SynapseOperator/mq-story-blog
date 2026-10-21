import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MQ · Our Stories | 工程占位",
  description: "MQ 个人博客的 Phase 0 工程占位页。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
