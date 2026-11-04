import type { Prisma, PrismaClient } from "../../generated/prisma/client.ts";
import { validateStoryContent } from "./content.ts";
import { createStoryOperations, mapStoryError, slugValue, type CreateDraftInput, type RevisionInput, type VersionInput } from "./operations.ts";

export { createStoryOperations, mapStoryError, StoryDomainError, type StoryErrorCode } from "./operations.ts";

/** Internal factory preserves the existing lifecycle API. Administrators use
 * createStoryOperations(withAdmin's tx), never this root-client wrapper. */
export function createStoryService(client: PrismaClient) {
  async function transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await client.$transaction(operation); }
    catch (error) { throw mapStoryError(error); }
  }
  return {
    createDraft: (input: CreateDraftInput) => transaction(tx => createStoryOperations(tx).createDraft(input)),
    saveDraft: (input: VersionInput & RevisionInput) => transaction(tx => createStoryOperations(tx).saveDraft(input)),
    reserveSlot: (input: VersionInput & { slotId: string | null }) => transaction(tx => createStoryOperations(tx).reserveSlot(input)),
    publish: (input: VersionInput) => transaction(tx => createStoryOperations(tx).publish(input)),
    withdraw: (input: VersionInput) => transaction(tx => createStoryOperations(tx).withdraw(input)),
    restore: (input: VersionInput) => transaction(tx => createStoryOperations(tx).restore(input)),
    async getPublicStory(slug: string) {
      const story = await client.story.findFirst({
        where: { slug: slugValue(slug), state: "PUBLISHED" },
        select: { id: true, slug: true, kind: true, slotId: true,
          publishedRevision: { select: { id: true, title: true, content: true, createdAt: true } } },
      });
      if (!story?.publishedRevision) return null;
      const { publishedRevision, ...identity } = story;
      return { ...identity, revision: { ...publishedRevision, content: validateStoryContent(publishedRevision.content) } };
    },
  };
}
