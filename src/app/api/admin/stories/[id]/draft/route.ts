import { handleAdminDrafts } from "@/server/admin/drafts/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function route(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleAdminDrafts(request, id);
}
export { route as GET, route as HEAD, route as POST, route as PUT, route as PATCH, route as DELETE, route as OPTIONS };
