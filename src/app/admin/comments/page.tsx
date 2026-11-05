import type { Metadata } from "next";
import { headers } from "next/headers";
import { withAdmin } from "../../../server/admin/access";
import { AdminAccessError } from "../../../server/admin/policy";
import { authConfiguration } from "../../../server/auth/policy";
import { CommentModerationWorkspace } from "../../../components/admin-comments/workspace";
import "../../../components/admin-comments/comments.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "留言审核 · MQ", description: "MQ 私有留言审核工作区。", robots: { index: false, follow: false } };

export default async function CommentsPage() {
  let denied: string | null = null;
  try {
    const config = authConfiguration();
    const request = new Request(new URL("/admin/comments", config.origin), { headers: await headers() });
    await withAdmin(request, async () => undefined);
  } catch (error) {
    denied = error instanceof AdminAccessError && error.status === 401 ? "请先回到 MQ 登录受控管理员账号。"
      : error instanceof AdminAccessError && error.status === 403 ? "当前会话没有有效的管理员授权。"
        : "暂时无法确认管理员权限，请稍后刷新重试。";
  }
  if (denied) return <main className="comments-gate"><span className="comments-brand">MQ</span><h1>无法进入留言审核</h1><p>{denied}</p><a href="/">返回 MQ</a></main>;
  // No private comment or story fields enter the page/RSC. This flag only
  // controls presentation; every API operation verifies its own admin session.
  return <CommentModerationWorkspace enabled={process.env.MQ_COMMENTS_ENABLED === "true"} />;
}
