import type { Metadata } from "next";
import { ScenePage } from "@/components/scene/scene-page";
import { readPublicStorySummaryBySlug } from "@/server/stories/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const story = await readPublicStorySummaryBySlug(slug);
  return {
    title: story ? `${story.title} · MQ · Our Stories` : "故事暂不可用 · MQ · Our Stories",
    description: "在 MQ 星空下阅读一封公开的羽毛信。",
    // Production publication/indexing remains a separate release decision.
    robots: { index: false, follow: false },
  };
}

export default async function SharedStoryPage({ params }: Props) {
  const { slug } = await params;
  // Only the URL identity enters the client/RSC shell. Body, revision metadata
  // and private title never become page props or static prerendered output.
  // An unavailable link retains the MQ background and the same reader's
  // accessible error/retry/close UI; the body API responds 404 or 503.
  return <ScenePage section="mq" initialStorySlug={slug} />;
}
