import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MQ · Our Stories",
  description: "MQ · Our Stories 静态视觉原型：星空、青草山坡与篝火旁的我们。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
