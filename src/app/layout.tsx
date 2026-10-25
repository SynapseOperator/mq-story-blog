import type { Metadata } from "next";
import "./globals.css";
import "../components/reader/letter.css";
import "../components/auth/auth.css";
import { AuthProvider } from "@/components/auth/auth-provider";

export const metadata: Metadata = {
  title: "MQ · Our Stories",
  description: "MQ · Our Stories 交互原型：在星空下打开一封合成演示书信。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}
