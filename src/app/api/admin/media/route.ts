import { listMedia, uploadMedia } from "../../../../server/media/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = uploadMedia;
export const GET = listMedia;
