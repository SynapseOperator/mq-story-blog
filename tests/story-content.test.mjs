import assert from "node:assert/strict";
import test from "node:test";
import {
  ContentValidationError,
  validateStoryContent,
  validateStoryTitle,
} from "../src/server/stories/content.ts";

const paragraph = (text = "合成演示段落。") => ({ type: "paragraph", text });
const document = (...blocks) => ({ version: 1, blocks });
const rejects = (value) => assert.throws(() => validateStoryContent(value), ContentValidationError);

test("story content preserves bounded paragraphs, simple formatting and image metadata", () => {
  const input = document(
    paragraph(),
    { ...paragraph("合成强调。"), style: "emphasis" },
    { ...paragraph("合成粗体。"), style: "strong" },
    { type: "image", src: "/story-media/synthetic.webp", alt: "合成图片", caption: "演示说明" },
    { type: "image", src: "https://example.com/synthetic.webp", alt: "远程合成图" },
  );
  const result = validateStoryContent(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.blocks, input.blocks);
  input.blocks[0].text = "变更输入";
  assert.equal(result.blocks[0].text, "合成演示段落。");
});

test("story title is bounded and cannot be empty", () => {
  assert.equal(validateStoryTitle(" 合成标题 "), "合成标题");
  assert.equal(validateStoryTitle("字".repeat(160)).length, 160);
  for (const title of ["", "   ", null, 42, "字".repeat(161), "含\0控制符"]) {
    assert.throws(() => validateStoryTitle(title), ContentValidationError);
  }
});

test("story content rejects extra fields, unsupported HTML blocks and unsupported formatting", () => {
  rejects({ ...document(paragraph()), arbitrary: true });
  rejects(document({ type: "html", html: "<script>not-supported</script>" }));
  rejects(document({ ...paragraph(), html: "<b>unsupported</b>" }));
  rejects(document({ ...paragraph(), style: "script" }));
  rejects(document({ ...paragraph(), style: undefined }));
  rejects(document({ type: "image", src: "/story-media/a.webp", alt: "演示", onerror: "unsupported" }));
  rejects(document(Object.assign(new Date(), paragraph())));
  // Angle brackets are plain text, never marked as trusted HTML by this contract.
  assert.equal(validateStoryContent(document(paragraph("<b>文字</b>"))).blocks[0].text, "<b>文字</b>");
});

test("story content rejects unsafe image schemes, credentials and local directory escapes", () => {
  for (const src of [
    "javascript:alert(1)", "data:image/png;base64,AA", "http://example.com/a.webp", "//example.com/a.webp",
    "https://user:password@example.com/a.webp", "https://user@example.com/a.webp", "https://example.com/\na.webp",
    "https:\\example.com/a.webp", " https://example.com/a.webp", "/other/a.webp", "/story-media/",
    "/story-media/../private.webp", "/story-media/%2e%2e/private.webp", "/story-media/%252e%252e/private.webp",
    "/story-media/a%2fb.webp", "/story-media/a%5cb.webp", "/story-media/a%00.webp", "/story-media/%ZZ.webp",
  ]) rejects(document({ type: "image", src, alt: "合成图片" }));
});

test("story content validates required image labels and paragraph limits", () => {
  rejects(document({ type: "image", src: "/story-media/a.webp", alt: "" }));
  rejects(document({ type: "image", src: "/story-media/a.webp", alt: "字".repeat(301) }));
  rejects(document({ type: "image", src: "/story-media/a.webp", alt: "图", caption: "字".repeat(1001) }));
  rejects(document(paragraph("   ")));
  rejects(document(paragraph("字".repeat(10_001))));
  assert.equal(validateStoryContent(document(paragraph("字".repeat(10_000)))).blocks.length, 1);
});

test("story content enforces version, block count and total UTF-8 byte limits", () => {
  for (const input of [null, [], {}, { version: 3, blocks: [paragraph()] }, document()]) rejects(input);
  rejects({ version: 1, blocks: Array(1) });
  rejects(document(...Array.from({ length: 201 }, () => paragraph())));
  assert.equal(validateStoryContent(document(...Array.from({ length: 200 }, () => paragraph()))).blocks.length, 200);
  // Each block and the count are individually valid, but the document is too large.
  rejects(document(...Array.from({ length: 10 }, () => paragraph("字".repeat(10_000)))));
});
