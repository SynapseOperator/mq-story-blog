import { handleAdminStatus } from "../../../../server/admin/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleAdminStatus(request);
