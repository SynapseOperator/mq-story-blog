import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Story } from "../../generated/prisma/client.ts";
import {
  ContentValidationError,
  validateStoryContent,
  validateStoryTitle,
} from "./content.ts";

export type StoryErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE";

export class StoryDomainError extends Error {
  readonly code: StoryErrorCode;

  constructor(code: StoryErrorCode, message: string) {
    super(message);
    this.name = "StoryDomainError";
    this.code = code;
  }
}

type RevisionInput = { title: unknown; content: unknown };
type VersionInput = { storyId: string; expectedVersion: number };
type CreateDraftInput = RevisionInput & {
  slug: string;
  kind: "STAR" | "CAMPFIRE";
  slotId?: string | null;
};

function invalid(message: string): never {
  throw new StoryDomainError("VALIDATION", message);
}

function slugValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    return invalid("slug 必须是 1 至 120 位小写字母、数字及单个连接符。");
  }
  return value;
}

function slotValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/u.test(value)) {
    return invalid("星位标识格式无效。");
  }
  return value;
}

function versionInput(input: VersionInput): VersionInput {
  if (
    typeof input.storyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.storyId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion >= 2_147_483_647
  ) {
    return invalid("故事 ID 或编辑版本无效。");
  }
  return input;
}

function revisionInput(input: RevisionInput) {
  try {
    return { title: validateStoryTitle(input.title), content: validateStoryContent(input.content) };
  } catch (error) {
    if (error instanceof ContentValidationError) throw new StoryDomainError("VALIDATION", error.message);
    throw error;
  }
}

async function current(tx: Prisma.TransactionClient, input: VersionInput): Promise<Story> {
  const story = await tx.story.findUnique({ where: { id: input.storyId } });
  if (!story) throw new StoryDomainError("NOT_FOUND", "故事不存在。");
  if (story.version !== input.expectedVersion) {
    throw new StoryDomainError("CONFLICT", "故事已被修改，请重新读取后再编辑。");
  }
  return story;
}

async function change(
  tx: Prisma.TransactionClient,
  story: Story,
  data: Prisma.StoryUncheckedUpdateManyInput,
): Promise<Story> {
  // The earlier read provides transition context, not the concurrency guard.
  // PostgreSQL performs this version/state predicate atomically with the write.
  const result = await tx.story.updateMany({
    where: { id: story.id, version: story.version, state: story.state },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count !== 1) {
    throw new StoryDomainError("CONFLICT", "故事已被修改，本次操作没有保存。");
  }
  return tx.story.findUniqueOrThrow({ where: { id: story.id } });
}

function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new StoryDomainError("INVALID_STATE", message);
}

// Internal domain only: no route, server action or public write interface.
// An authenticated administrator boundary must be implemented before exposing
// these operations. This service does not claim to authorize a caller.
export function createStoryService(client: PrismaClient) {
  async function transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await client.$transaction(operation);
    } catch (error) {
      if (error instanceof StoryDomainError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code === "P2002" || code === "P2034") {
        throw new StoryDomainError("CONFLICT", "故事标识、星位或篝火已被占用，或发生并发修改。");
      }
      if (code === "P2003" || code === "P2004") {
        throw new StoryDomainError("VALIDATION", "故事引用或数据库约束校验失败。");
      }
      throw error;
    }
  }

  return {
    async createDraft(input: CreateDraftInput) {
      const revision = revisionInput(input);
      const slug = slugValue(input.slug);
      const slotId = slotValue(input.slotId);
      if (input.kind !== "STAR" && input.kind !== "CAMPFIRE") return invalid("故事类别无效。");
      if (input.kind === "CAMPFIRE" && slotId !== null) return invalid("篝火故事不能占用普通星位。");
      const id = randomUUID();
      const draftRevisionId = randomUUID();
      return transaction(async (tx) => {
        const story = await tx.story.create({
          data: { id, slug, kind: input.kind, state: "DRAFT", slotId, draftRevisionId, version: 0 },
        });
        // Deferred composite FK validates that the new revision belongs to this
        // story when both inserts commit, never a temporarily orphaned draft.
        await tx.storyRevision.create({ data: { id: draftRevisionId, storyId: id, ...revision } });
        return story;
      });
    },

    async saveDraft(input: VersionInput & RevisionInput) {
      versionInput(input);
      const revision = revisionInput(input);
      return transaction(async (tx) => {
        const story = await current(tx, input);
        const saved = await tx.storyRevision.create({ data: { storyId: story.id, ...revision } });
        // A losing CAS throws inside the transaction, rolling back its revision.
        return change(tx, story, { draftRevisionId: saved.id });
      });
    },

    async reserveSlot(input: VersionInput & { slotId: string | null }) {
      versionInput(input);
      if (input.slotId === undefined) return invalid("调整星位必须显式提供星位标识或 null。");
      const slotId = slotValue(input.slotId);
      return transaction(async (tx) => {
        const story = await current(tx, input);
        requireState(story.kind === "STAR" && story.state === "DRAFT", "只有未发布的普通故事可以调整预留星位。");
        return change(tx, story, { slotId });
      });
    },

    async publish(input: VersionInput) {
      versionInput(input);
      return transaction(async (tx) => {
        const story = await current(tx, input);
        requireState(story.state !== "WITHDRAWN", "下架故事须先恢复；恢复不会发布尚未确认的新草稿。");
        requireState(story.kind === "CAMPFIRE" || story.slotId !== null, "普通故事必须预留星位后才能发布。");
        requireState(story.draftRevisionId !== story.publishedRevisionId, "当前草稿已经发布，无待发布更新。");
        return change(tx, story, { state: "PUBLISHED", publishedRevisionId: story.draftRevisionId });
      });
    },

    async withdraw(input: VersionInput) {
      versionInput(input);
      return transaction(async (tx) => {
        const story = await current(tx, input);
        requireState(story.state === "PUBLISHED", "只有已发布故事可以下架。");
        return change(tx, story, { state: "WITHDRAWN" });
      });
    },

    async restore(input: VersionInput) {
      versionInput(input);
      return transaction(async (tx) => {
        const story = await current(tx, input);
        requireState(story.state === "WITHDRAWN", "只有已下架故事可以恢复。");
        return change(tx, story, { state: "PUBLISHED" });
      });
    },

    async getPublicStory(slug: string) {
      const story = await client.story.findFirst({
        where: { slug: slugValue(slug), state: "PUBLISHED" },
        select: {
          id: true,
          slug: true,
          kind: true,
          slotId: true,
          publishedRevision: { select: { id: true, title: true, content: true, createdAt: true } },
        },
      });
      if (!story?.publishedRevision) return null;
      const { publishedRevision, ...identity } = story;
      return { ...identity, revision: { ...publishedRevision, content: validateStoryContent(publishedRevision.content) } };
    },
  };
}
