import { handleStoryLikes, rejectStoryLikeMethod } from "@/server/likes/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleStoryLikes(request, id);
}
export const PUT = GET;
export const DELETE = GET;
export const HEAD = rejectStoryLikeMethod;
export const POST = rejectStoryLikeMethod;
export const PATCH = rejectStoryLikeMethod;
export const OPTIONS = rejectStoryLikeMethod;
