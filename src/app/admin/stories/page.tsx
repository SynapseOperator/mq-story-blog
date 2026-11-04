import type { Metadata } from "next";
import { headers } from "next/headers";
import { withAdmin } from "../../../server/admin/access";
import { AdminAccessError } from "../../../server/admin/policy";
import { authConfiguration } from "../../../server/auth/policy";
import { StoryEditor } from "../../../components/admin-editor/story-editor";
import "../../../components/admin-editor/editor.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "故事手稿 · MQ", description: "MQ 私有故事编辑工作区。", robots: { index: false, follow: false },
};

export default async function EditorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let denied: string | null = null;
  try {
    const config = authConfiguration();
    // Preserve actual Origin/proxy headers. Neither Host nor client roles can
    // select a trusted origin. No draft is read or serialized in this page/RSC.
    const request = new Request(new URL("/admin/stories", config.origin), { headers: await headers() });
    await withAdmin(request, async () => undefined);
  } catch (error) {
    denied = error instanceof AdminAccessError && error.status === 401
      ? "请先回到 MQ 登录受控管理员账号。"
      : error instanceof AdminAccessError && error.status === 403
        ? "当前会话没有有效的管理员授权，无法读取或编辑草稿。"
        : "暂时无法确认管理员权限。请稍后刷新重试，草稿不会在这里公开。";
  }
  if (denied) return <main className="editor-gate"><span className="editor-brand">MQ</span><h1>无法进入故事工作区</h1><p>{denied}</p><a href="/">返回 MQ</a></main>;
  const query = await searchParams;
  const initialId = typeof query.story === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.story) ? query.story : null;
  // Presentation only. Every publication request still checks the server key,
  // database session and grant; no signing configuration reaches the browser.
  return <StoryEditor initialId={initialId} publishingEnabled={process.env.MQ_PUBLISH_ENABLED === "true"} />;
}
