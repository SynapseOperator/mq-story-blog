import { handleAuth } from "@/server/auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleAuth;
export const POST = handleAuth;
export const PUT = handleAuth;
export const PATCH = handleAuth;
export const DELETE = handleAuth;
export const OPTIONS = handleAuth;
export const HEAD = handleAuth;
