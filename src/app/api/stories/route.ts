import { handlePublicStories, rejectPublicStoryMethod } from "@/server/stories/public-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export function GET(request: Request) { return handlePublicStories(request); }
export const HEAD = GET;
export const POST = rejectPublicStoryMethod;
export const PUT = rejectPublicStoryMethod;
export const PATCH = rejectPublicStoryMethod;
export const DELETE = rejectPublicStoryMethod;
export const OPTIONS = rejectPublicStoryMethod;
