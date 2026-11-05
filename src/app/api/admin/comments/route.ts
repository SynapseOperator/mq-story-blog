import { handleAdminComments } from "@/server/comments/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleAdminComments(request);
}
export const POST = GET;
export const HEAD = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
