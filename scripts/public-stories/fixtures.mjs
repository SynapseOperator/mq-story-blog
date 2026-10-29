import { randomUUID } from "node:crypto";
import { createStoryService } from "../../src/server/stories/service.ts";

/** Only the integration runner's freshly migrated temporary database is passed
 * here. These synthetic examples are never startup/dev/production seed data.
 */
export async function createPublicFixtures(client, { imageSource, brokenImageSource }) {
  const service = createStoryService(client);
  const token = randomUUID().replaceAll("-", "");
  const privateCanaries = ["DRAFT_ONLY", "WITHDRAWN_ONLY", "UNPUBLISHED_EDIT", "OLD_REVISION"]
    .map(label => `PRIVATE_${label}_${token}`);
  const paragraph = text => ({ type: "paragraph", text });
  const longBlocks = [
    { type: "paragraph", style: "emphasis", text: "合成演示 · 这封长信只用于数据库与阅读体验验收，不是真实人物的回忆。" },
    { type: "paragraph", style: "strong", text: "每一颗故事星，都有自己的位置。" },
  ];
  for (let i = 0; i < 24; i += 1) {
    longBlocks.push(paragraph(`第 ${i + 1} 段合成文字。晚风经过山坡的时候，草叶轻轻摇动，远处的灯光依然安静。我们把一个平常的夜晚写在纸上，让一段不真实的示例也能说明阅读的节奏。这里没有真实姓名、日期或照片，也没有应当公开的私人内容。这一段为内部滚动、中文换行与长文章测试提供足够的文字。`));
    if (i === 1 || i === 10) longBlocks.push({ type: "image", src: imageSource,
      alt: `合成演示星空插图 ${i === 1 ? 1 : 2}`,
      caption: "合成演示插图 · 测试复用已验收 MQ 星空素材" });
  }
  longBlocks.push({ type: "image", src: brokenImageSource, alt: "故意不可用的合成配图", caption: "用于验证图片失败后仍可读信" });
  longBlocks.push(paragraph(`PUBLIC_LONG_BODY_${token}`));
  const longContent = { version: 1, blocks: longBlocks };
  const plainContent = { version: 1, blocks: [paragraph("合成演示 · 一封没有图片的短笺。"),
    paragraph(`PUBLIC_SHORT_BODY_${token}`)] };
  const campfireContent = { version: 1, blocks: [
    { type: "paragraph", style: "emphasis", text: "合成演示 · 我们在一起的故事，仅为隔离测试编写。" },
    paragraph(`PUBLIC_CAMPFIRE_BODY_${token}`),
    paragraph("篝火入口始终绑定同一篇已发布故事，不依赖故事数组的先后顺序。"),
  ] };
  async function make(label, title, content, kind = "STAR", slotId = null) {
    return service.createDraft({ slug: `synthetic-${label}-${token}`, title, content, kind, slotId });
  }
  const publish = story => service.publish({ storyId: story.id, expectedVersion: story.version });
  let starOne = await make("long", "合成演示 · 星光里的长信", { version: 1, blocks: [paragraph(privateCanaries[3])] }, "STAR", "star-1");
  starOne = await publish(starOne);
  starOne = await service.saveDraft({ storyId: starOne.id, expectedVersion: starOne.version,
    title: "合成演示 · 星光里的长信", content: longContent });
  starOne = await publish(starOne);
  starOne = await service.saveDraft({ storyId: starOne.id, expectedVersion: starOne.version,
    title: privateCanaries[2], content: { version: 1, blocks: [paragraph(privateCanaries[2])] } });
  const starTwo = await publish(await make("short", "合成演示 · 晚风短笺", plainContent, "STAR", "star-2"));
  let withdrawn = await publish(await make("withdrawn", privateCanaries[1],
    { version: 1, blocks: [paragraph(privateCanaries[1])] }, "STAR", "star-3"));
  withdrawn = await service.withdraw({ storyId: withdrawn.id, expectedVersion: withdrawn.version });
  const draft = await make("draft", privateCanaries[0], { version: 1, blocks: [paragraph(privateCanaries[0])] });
  const campfire = await publish(await make("campfire", "合成演示 · 我们在一起的故事", campfireContent, "CAMPFIRE"));
  const fixture = (record, title, content) => ({ id: record.id, slug: record.slug, title, content });
  const fixtures = {
    starOne: fixture(starOne, "合成演示 · 星光里的长信", longContent),
    starTwo: fixture(starTwo, "合成演示 · 晚风短笺", plainContent),
    withdrawn: fixture(withdrawn, privateCanaries[1], { version: 1, blocks: [paragraph(privateCanaries[1])] }),
    draft: fixture(draft, privateCanaries[0], { version: 1, blocks: [paragraph(privateCanaries[0])] }),
    campfire: fixture(campfire, "合成演示 · 我们在一起的故事", campfireContent),
    privateCanaries,
    publicCanaries: [`PUBLIC_LONG_BODY_${token}`, `PUBLIC_SHORT_BODY_${token}`, `PUBLIC_CAMPFIRE_BODY_${token}`],
  };
  const managedIds = new Set([starOne.id, starTwo.id, campfire.id, withdrawn.id, draft.id]);
  async function changeVisibility(id, visible) {
    if (!managedIds.has(id)) throw new Error("Fixture visibility target is not owned by this run");
    const current = await client.story.findUniqueOrThrow({ where: { id } });
    if (visible && current.state === "WITHDRAWN") await service.restore({ storyId: id, expectedVersion: current.version });
    if (!visible && current.state === "PUBLISHED") await service.withdraw({ storyId: id, expectedVersion: current.version });
  }
  return {
    fixtures,
    withdrawStory: id => changeVisibility(id, false),
    restoreStory: id => changeVisibility(id, true),
    async setPublicVisible(visible) {
      for (const id of [starOne.id, starTwo.id, campfire.id]) await changeVisibility(id, visible);
    },
  };
}
