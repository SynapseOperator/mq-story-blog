import { handlePublicStoryBySlug, rejectPublicStoryMethod } from "@/server/stories/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  return handlePublicStoryBySlug(request, slug);
}
export const HEAD = GET;
export const POST = rejectPublicStoryMethod;
export const PUT = rejectPublicStoryMethod;
export const PATCH = rejectPublicStoryMethod;
export const DELETE = rejectPublicStoryMethod;
export const OPTIONS = rejectPublicStoryMethod;
