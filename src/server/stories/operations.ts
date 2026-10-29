import { randomUUID } from "node:crypto";
import type { Prisma, Story } from "../../generated/prisma/client.ts";
import { ContentValidationError, validateStoryContent, validateStoryTitle } from "./content.ts";

export type StoryErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE";
export class StoryDomainError extends Error {
  readonly code: StoryErrorCode;
  constructor(code: StoryErrorCode, message: string) {
    super(message); this.name = "StoryDomainError"; this.code = code;
  }
}
export type RevisionInput = { title: unknown; content: unknown };
export type VersionInput = { storyId: string; expectedVersion: number };
export type CreateDraftInput = RevisionInput & { slug: string; kind: "STAR" | "CAMPFIRE"; slotId?: string | null };

/** Only understood database categories are mapped; unknown errors must remain
 * failures for the caller's redacting boundary, never generic input errors. */
export function mapStoryError(error: unknown): unknown {
  if (error instanceof StoryDomainError) return error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const meta = record.meta && typeof record.meta === "object" ? record.meta as Record<string, unknown> : {};
  const adapter = meta.driverAdapterError && typeof meta.driverAdapterError === "object"
    ? meta.driverAdapterError as Record<string, unknown> : {};
  const cause = adapter.cause && typeof adapter.cause === "object" ? adapter.cause as Record<string, unknown> : {};
  // Prisma 7's pg adapter wraps raw SQLSTATE here; older/native clients use
  // meta.code. Inspect only the code, never parse/return originalMessage, row
  // values or constraint details. Permissions and unknown states stay failures.
  const sqlCode = record.code === "P2010" ? (meta.code ?? cause.originalCode) : null;
  if (record.code === "P2002" || record.code === "P2034" || sqlCode === "23505") {
    return new StoryDomainError("CONFLICT", "故事标识、星位或篝火已被占用，或发生并发修改。");
  }
  if (record.code === "P2003" || record.code === "P2004" || sqlCode === "23503") {
    return new StoryDomainError("VALIDATION", "故事引用或数据库约束校验失败。");
  }
  return error;
}
function invalid(message: string): never { throw new StoryDomainError("VALIDATION", message); }
export function storyIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    return invalid("故事 ID 无效。");
  }
  return value;
}
export function slugValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    return invalid("slug 必须是 1 至 120 位小写字母、数字及单个连接符。");
  }
  return value;
}
function slotValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/u.test(value)) return invalid("星位标识格式无效。");
  return value;
}
function versionInput(input: VersionInput): void {
  storyIdValue(input.storyId);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2_147_483_647) invalid("编辑版本无效。");
}
function revisionInput(input: RevisionInput) {
  try { return { title: validateStoryTitle(input.title), content: validateStoryContent(input.content) }; }
  catch (error) {
    if (error instanceof ContentValidationError) throw new StoryDomainError("VALIDATION", error.message);
    throw error;
  }
}
async function current(tx: Prisma.TransactionClient, input: VersionInput): Promise<Story> {
  const story = await tx.story.findUnique({ where: { id: input.storyId } });
  if (!story) throw new StoryDomainError("NOT_FOUND", "故事不存在。");
  if (story.version !== input.expectedVersion) throw new StoryDomainError("CONFLICT", "故事已被修改，请重新读取后再编辑。");
  return story;
}
async function change(tx: Prisma.TransactionClient, story: Story, data: Prisma.StoryUncheckedUpdateManyInput): Promise<Story> {
  const result = await tx.story.updateMany({ where: { id: story.id, version: story.version, state: story.state },
    data: { ...data, version: { increment: 1 } } });
  if (result.count !== 1) throw new StoryDomainError("CONFLICT", "故事已被修改，本次操作没有保存。");
  return tx.story.findUniqueOrThrow({ where: { id: story.id } });
}
function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new StoryDomainError("INVALID_STATE", message);
}

/** No root client, connection creation or nested transaction. The caller owns
 * rollback and must propagate failures; administrators supply withAdmin's tx. */
export function createStoryOperations(tx: Prisma.TransactionClient) {
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) { throw mapStoryError(error); }
  }
  async function appendRevision(storyId: string, id: string, revision: ReturnType<typeof revisionInput>) {
    // Explicit columns avoid ORM defaults requiring broader INSERT grants.
    await tx.$executeRaw`INSERT INTO public.story_revision (id, story_id, title, content)
      VALUES (${id}::uuid, ${storyId}::uuid, ${revision.title}, ${JSON.stringify(revision.content)}::jsonb)`;
  }
  return {
    async createDraft(input: CreateDraftInput) {
      const revision = revisionInput(input), slug = slugValue(input.slug), slotId = slotValue(input.slotId);
      if (input.kind !== "STAR" && input.kind !== "CAMPFIRE") return invalid("故事类别无效。");
      if (input.kind === "CAMPFIRE" && slotId !== null) return invalid("篝火故事不能占用普通星位。");
      return operation(async () => {
        const id = randomUUID(), draftRevisionId = randomUUID();
        if (slotId === null) {
          // Runtime has no INSERT grant on state, publication or slot columns.
          await tx.$executeRaw`INSERT INTO public.story (id, slug, kind, draft_revision_id)
            VALUES (${id}::uuid, ${slug}, ${input.kind}::public."StoryKind", ${draftRevisionId}::uuid)`;
        } else {
          // Internal reservation stays available; P2-08A HTTP cannot use it.
          await tx.$executeRaw`INSERT INTO public.story (id, slug, kind, draft_revision_id, slot_id)
            VALUES (${id}::uuid, ${slug}, ${input.kind}::public."StoryKind", ${draftRevisionId}::uuid, ${slotId})`;
        }
        await appendRevision(id, draftRevisionId, revision);
        return tx.story.findUniqueOrThrow({ where: { id } });
      });
    },
    async saveDraft(input: VersionInput & RevisionInput) {
      versionInput(input); const revision = revisionInput(input);
      return operation(async () => {
        const story = await current(tx, input), revisionId = randomUUID();
        await appendRevision(story.id, revisionId, revision);
        // A losing CAS throws through the outer transaction, rolling back INSERT.
        return change(tx, story, { draftRevisionId: revisionId });
      });
    },
    async reserveSlot(input: VersionInput & { slotId: string | null }) {
      versionInput(input);
      if (input.slotId === undefined) return invalid("调整星位必须显式提供星位标识或 null。");
      const slotId = slotValue(input.slotId);
      return operation(async () => {
        const story = await current(tx, input);
        requireState(story.kind === "STAR" && story.state === "DRAFT", "只有未发布的普通故事可以调整预留星位。");
        return change(tx, story, { slotId });
      });
    },
    async publish(input: VersionInput) {
      versionInput(input);
      return operation(async () => {
        const story = await current(tx, input);
        requireState(story.state !== "WITHDRAWN", "下架故事须先恢复；恢复不会发布尚未确认的新草稿。");
        requireState(story.kind === "CAMPFIRE" || story.slotId !== null, "普通故事必须预留星位后才能发布。");
        requireState(story.draftRevisionId !== story.publishedRevisionId, "当前草稿已经发布，无待发布更新。");
        return change(tx, story, { state: "PUBLISHED", publishedRevisionId: story.draftRevisionId });
      });
    },
    async withdraw(input: VersionInput) {
      versionInput(input);
      return operation(async () => {
        const story = await current(tx, input);
        requireState(story.state === "PUBLISHED", "只有已发布故事可以下架。");
        return change(tx, story, { state: "WITHDRAWN" });
      });
    },
    async restore(input: VersionInput) {
      versionInput(input);
      return operation(async () => {
        const story = await current(tx, input);
        requireState(story.state === "WITHDRAWN", "只有已下架故事可以恢复。");
        return change(tx, story, { state: "PUBLISHED" });
      });
    },
  };
}
