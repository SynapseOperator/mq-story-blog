import { handlePublicStories, rejectPublicStoryMethod } from "@/server/stories/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handlePublicStories(request, id);
}
export const HEAD = GET;
export const POST = rejectPublicStoryMethod;
export const PUT = rejectPublicStoryMethod;
export const PATCH = rejectPublicStoryMethod;
export const DELETE = rejectPublicStoryMethod;
export const OPTIONS = rejectPublicStoryMethod;
