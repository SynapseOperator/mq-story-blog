import { handlePublicMedia, rejectPublicMediaMethod } from "@/server/media/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await context.params;
  return handlePublicMedia(request, id, assetId);
}
export const HEAD = GET;
export const POST = rejectPublicMediaMethod;
export const PUT = rejectPublicMediaMethod;
export const PATCH = rejectPublicMediaMethod;
export const DELETE = rejectPublicMediaMethod;
export const OPTIONS = rejectPublicMediaMethod;
