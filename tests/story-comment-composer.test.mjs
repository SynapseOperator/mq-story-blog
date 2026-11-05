import assert from "node:assert/strict";
import test from "node:test";
import { canRetryComment, commentComposerReducer as reduce, commentLength, commentNeedsProtection,
  createCommentComposer, freezeCommentAttempt, validateCommentDraft } from "../src/lib/stories/comment-composer.ts";

const edit = (state, value) => reduce(state, { type: "edit", value });
function submitted(body = "原留言", identity = "anonymous", userId = null) {
  const state = edit(createCommentComposer(), body);
  const attempt = freezeCommentAttempt(state, "story-a", identity, userId, "original-key");
  return reduce(state, { type: "send", attempt });
}

test("comment validation counts Unicode code points after trim without truncating composition text", () => {
  assert.equal(commentLength(`  ${"🌟".repeat(500)}\n`), 500);
  assert.equal(validateCommentDraft(`  ${"🌟".repeat(500)}\n`), null);
  assert.ok(validateCommentDraft("🌟".repeat(501)));
  assert.equal(commentLength("e\u0301"), 2);
  assert.equal(validateCommentDraft("<script>alert(1)</script>\n\t普通文本"), null);
  for (const invalid of ["", " \n\t", "\ud800", "\udc00", "a\0b", "a\u001fb", "a\u007fb", "a\u0085b"]) {
    assert.ok(validateCommentDraft(invalid));
  }
  const composing = edit(createCommentComposer(), "🌟".repeat(501));
  assert.equal(composing.draft, "🌟".repeat(501), "Editing never truncates or discards a user's input");
});

test("success acknowledges only the frozen snapshot and clears only an unedited draft", () => {
  const original = submitted("  原留言\n");
  assert.equal(original.attempt.body, "原留言");
  assert.ok(Object.isFrozen(original.attempt));
  assert.equal(commentNeedsProtection(original), true);
  const accepted = reduce(original, { type: "accepted", key: "original-key" });
  assert.equal(accepted.draft, "");
  assert.equal(accepted.message, "留言已提交，审核通过后会显示");
  assert.equal(commentNeedsProtection(accepted), false);
  const newer = edit(original, "后来写的新稿");
  assert.equal(reduce(newer, { type: "accepted", key: "original-key" }).draft, "后来写的新稿");
  const reverted = edit(edit(original, "临时改动"), original.draft);
  assert.equal(reduce(reverted, { type: "accepted", key: "original-key" }).draft, original.draft,
    "Even editing back to the sent text is a later draft revision");
});

test("lost receipt retains original body/key/identity while editing and explicit replay preserve the new draft", () => {
  let state = submitted("账号原留言", "account", "user-a");
  const frozen = state.attempt;
  state = reduce(state, { type: "failed", key: frozen.key, uncertain: true, message: "unknown" });
  state = edit(state, "后来新稿");
  state = reduce(state, { type: "identity", value: "anonymous" });
  assert.equal(state.attempt, frozen);
  assert.equal(state.attempt.body, "账号原留言");
  assert.equal(state.attempt.identity, "account");
  assert.equal(canRetryComment(frozen, "user-b"), false);
  assert.equal(canRetryComment(frozen, null), false);
  assert.equal(canRetryComment(frozen, "user-a"), true);
  assert.equal(reduce(state, { type: "send", attempt: { ...frozen, key: "new-key" } }), state);
  state = reduce(state, { type: "retry" });
  assert.equal(state.attempt, frozen);
  state = reduce(state, { type: "accepted", key: frozen.key });
  assert.equal(state.draft, "后来新稿");
  assert.equal(state.attempt, null);
  assert.equal(commentNeedsProtection(state), true);
});

test("a later definite rejection does not erase an earlier uncertain outcome or its close protection", () => {
  let state = submitted();
  const frozen = state.attempt;
  state = reduce(state, { type: "failed", key: frozen.key, uncertain: true, message: "response lost" });
  state = edit(state, "");
  assert.equal(commentNeedsProtection(state), true);
  for (const message of ["401", "429", "404"]) {
    state = reduce(state, { type: "retry" });
    state = reduce(state, { type: "failed", key: frozen.key, uncertain: false, message });
    assert.equal(state.phase, "uncertain");
    assert.equal(state.attempt, frozen);
    assert.equal(commentNeedsProtection(state), true);
  }
});

test("anonymous frozen submissions remain anonymous across login, and ordinary rejection retains editable text", () => {
  const state = submitted("访客留言");
  assert.equal(canRetryComment(state.attempt, "signed-in-user"), true);
  assert.equal(state.attempt.accountUserId, null);
  const rejected = reduce(state, { type: "failed", key: state.attempt.key, uncertain: false, message: "rate limited" });
  assert.equal(rejected.draft, "访客留言");
  assert.equal(rejected.phase, "error");
  assert.equal(rejected.attempt, null);
  assert.equal(commentNeedsProtection(rejected), true);
  assert.equal(reduce(state, { type: "accepted", key: "other-attempt" }), state);
  assert.equal(reduce(state, { type: "send", attempt: { ...state.attempt, key: "duplicate" } }), state);
});
