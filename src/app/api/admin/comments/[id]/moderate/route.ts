import { handleAdminComments } from "@/server/comments/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleAdminComments(request, id);
}
export const GET = POST;
export const HEAD = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
