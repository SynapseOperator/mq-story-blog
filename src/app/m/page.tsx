import type { Metadata } from "next";
import { ScenePage } from "@/components/scene/scene-page";

export const metadata: Metadata = { title: "M · 建设中 | MQ" };

export default function MPage() {
  return <ScenePage section="m" />;
}
