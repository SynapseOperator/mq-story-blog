import { FUNCTION_IDENTITIES } from "./database-config.mjs";

const read = (...tables) => Object.fromEntries(tables.map(table => [table, { SELECT: "*" }]));
const columns = (select, update) => ({ SELECT: select, ...(update ? { UPDATE: update } : {}) });
const userLock = { 'public.User': columns(["id"], ["id"]) };
const sessionLock = { 'public.Session': columns(["id", "userId", "expiresAt"], ["id"]) };
const storyLock = { 'public.story': columns(["id", "state"], ["id"]) };
const grantLock = { 'public.AdminGrant': columns(["id", "userId", "revokedAt"], ["id"]) };
const metadata = ["display_mime_type", "display_width", "display_height", "display_bytes", "display_sha256",
  "thumbnail_mime_type", "thumbnail_width", "thumbnail_height", "thumbnail_bytes", "thumbnail_sha256"];

/** Exact, reviewed role matrix; all omitted table/column/function rights deny.
 * Lock-only UPDATE(id) belongs to unreachable NOLOGIN function owners, never
 * to application credentials. PostgreSQL row locks require an UPDATE right. */
export function deploymentPrivilegePolicy(config) {
  const policy = {
    runtime: {
      tables: {
        ...read("public.User", "public.Account", "public.Session", "public.AdminGrant", "public.story",
          "public.story_revision", "public.star_slot", "public.media_asset", "public.story_revision_asset",
          "public.story_like", "public.story_comment"),
        'public.User': { SELECT: "*", INSERT: "*" },
        'public.Account': { SELECT: "*", INSERT: "*" },
        'public.Session': { SELECT: "*", INSERT: "*", DELETE: "*" },
        'public.RateLimit': { SELECT: "*", INSERT: "*", UPDATE: "*", DELETE: "*" },
        'public.AuthRateLimit': { SELECT: "*", INSERT: "*", UPDATE: "*", DELETE: "*" },
        'public.story': { SELECT: "*", INSERT: ["id", "slug", "kind", "draft_revision_id"], UPDATE: ["draft_revision_id", "version", "updated_at"] },
        'public.story_revision': { SELECT: "*", INSERT: ["id", "story_id", "title", "content"] },
        'public.media_asset': { SELECT: "*", INSERT: ["id"], UPDATE: ["state", ...metadata, "updated_at"] },
        'public.story_like': { SELECT: "*", INSERT: ["user_id", "story_id"], DELETE: "*" },
        'public.story_comment': { SELECT: "*", INSERT: ["id", "story_id", "user_id", "body", "submission_key_hash"] },
      },
      functions: ["admin_access", "admin_credentials", "publication", "like_access", "comment_context", "moderation"],
    },
    maintenance: {
      tables: {
        'public.User': { SELECT: "*", INSERT: "*" },
        'public.Account': { SELECT: "*", INSERT: "*", UPDATE: ["password", "updatedAt"] },
        'public.Session': { SELECT: "*", DELETE: "*" },
        'public.AdminGrant': { SELECT: "*", INSERT: "*", UPDATE: ["version", "revokedAt"] },
        ...read("public.AdminSecurityEvent"),
      }, functions: [],
    },
    mediaMaintenance: { tables: {
      'public.media_asset': { SELECT: "*", UPDATE: ["state", "updated_at"] },
      ...read("public.story_revision_asset"),
    }, functions: [] },
    // Includes credential/key tables because a complete native dump contains
    // them. This separate credential must never be mounted into the web app.
    backup: { tables: {}, functions: [], allTablesRead: true },
    grant_audit: { tables: {
      'public.Session': { SELECT: ["userId"], DELETE: "*" },
      'public.AdminSecurityEvent': { INSERT: ["kind", "userId", "databaseActor"] },
    }, functions: [] },
    credential_lock: { tables: { 'public.AdminGrant': columns(["userId"], ["id"]) }, functions: [] },
    credential_audit: { tables: {
      'public.AdminGrant': columns(["userId", "version", "credentialVersion"], ["version", "credentialVersion"]),
    }, functions: [] },
    admin_access: { tables: { ...grantLock, ...userLock, ...sessionLock }, functions: [] },
    admin_credentials: { tables: { 'public.AdminGrant': columns(["id", "userId"], ["id"]) }, functions: [] },
    asset_projection: { tables: {
      'public.story_revision_asset': { INSERT: ["revision_id", "asset_id"] },
      'public.story_revision': columns(["id", "content"]),
    }, functions: [] },
    publication: { tables: {
      ...read("public.story", "public.story_revision", "public.star_slot", "public.media_asset", "public.story_revision_asset", "mq_publish_private.signing_key"),
      'public.story': { SELECT: "*", UPDATE: ["state", "published_revision_id", "slot_id", "version", "updated_at"] },
    }, functions: ["admin_access", "hmac"] },
    like_access: { tables: { ...userLock, ...sessionLock, ...storyLock }, functions: [] },
    comment_context: { tables: { ...userLock, ...sessionLock, ...storyLock }, functions: [] },
    comment_guard: { tables: { ...storyLock }, functions: [] },
    moderation: { tables: {
      'public.story_comment': columns(["id", "story_id", "state", "version", "approved_at"], ["state", "version", "moderated_at", "moderated_by", "approved_at"]),
      ...read("mq_comment_private.moderation_key"),
    }, functions: ["admin_access", "comment_context", "hmac"] },
  };
  const signatures = Object.fromEntries(FUNCTION_IDENTITIES);
  signatures.hmac = "mq_publish_private.hmac(bytea,bytea,text)";
  return Object.entries(policy).map(([key, value]) => ({
    ...value, key, name: config.roles[key] ?? config.roles.owners[key],
    functions: value.functions.map(name => signatures[name]),
    ownFunction: signatures[key],
  }));
}
