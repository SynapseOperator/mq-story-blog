import { withAdmin } from "./access.ts";
import { AdminAccessError } from "./policy.ts";

const headers = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function document(authorized: boolean) {
  // Static markup only: no account name, internal email, grant ID or session data.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MQ · 管理权限检查</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#0c1723;color:#ead4ad;font-family:system-ui,sans-serif;line-height:1.8}main{max-width:540px;border:1px solid #89734d;border-radius:12px;padding:clamp(24px,6vw,48px);background:#152230}h1{font-size:clamp(22px,5vw,28px);font-weight:500}p{color:#d3d5d7}a{color:#ead4ad}small{color:#b5b8bd}
  </style></head><body><main><small>MQ · P2-05</small><h1>${authorized ? "管理员权限已验证" : "无法进入管理区域"}</h1><p>${authorized ? "当前数据库会话与唯一管理员授权有效。可以进入私有故事工作区编辑草稿；发布及留言审核尚未开放。" : "需要有效的管理员会话与授权。请返回主页，使用受控账号登录；权限被撤销或服务不可用时不能继续访问。"}</p>${authorized ? '<p><a href="/admin/stories">进入故事工作区</a></p>' : ""}<a href="/">返回 MQ</a></main></body></html>`;
}

export async function handleAdminStatus(request: Request, html = false) {
  let status = 200;
  let code: string | undefined;
  try {
    if (new URL(request.url).search || !["GET", "HEAD"].includes(request.method)) {
      throw new AdminAccessError("ADMIN_REQUEST_REJECTED", 400);
    }
    await withAdmin(request, async () => undefined);
  } catch (error) {
    status = error instanceof AdminAccessError ? error.status : 503;
    code = error instanceof AdminAccessError ? error.code : "ADMIN_UNAVAILABLE";
  }
  return html ? new Response(document(status === 200), { status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" } })
    : Response.json(status === 200 ? { authorized: true } : { code }, { status, headers });
}
