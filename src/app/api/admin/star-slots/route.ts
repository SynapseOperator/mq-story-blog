import { handlePublication } from "../../../../server/admin/publishing/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => handlePublication(request);
export const HEAD = GET;
