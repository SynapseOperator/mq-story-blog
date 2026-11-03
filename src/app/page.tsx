import { ScenePage } from "@/components/scene/scene-page";

export default function Home() {
  // The static scene shell contains no story text. The client requests a small
  // public catalog, then fetches only the selected published revision.
  return <ScenePage section="mq" />;
}
