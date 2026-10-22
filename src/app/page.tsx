import { ScenePage } from "@/components/scene/scene-page";
import { demoBindings } from "@/data/demo-bindings";
import { demoStories } from "@/data/demo-stories";
import { bindSceneStories } from "@/lib/stories/scene-catalog";

export default function Home() {
  return <ScenePage section="mq" stories={bindSceneStories(demoStories, demoBindings)} />;
}
