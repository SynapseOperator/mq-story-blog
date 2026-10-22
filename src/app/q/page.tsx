import type { Metadata } from "next";
import { ScenePage } from "@/components/scene/scene-page";

export const metadata: Metadata = { title: "Q · 建设中 | MQ" };

export default function QPage() {
  return <ScenePage section="q" />;
}
