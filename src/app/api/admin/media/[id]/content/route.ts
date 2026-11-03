import { getMedia } from "../../../../../../server/media/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  getMedia(request, (await context.params).id, true);
export const HEAD = GET;
