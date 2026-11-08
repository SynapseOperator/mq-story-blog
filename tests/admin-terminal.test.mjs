import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readHiddenPassword } from "../scripts/admin/terminal.mjs";

function terminal(previousRaw = false) {
  const input = new EventEmitter();
  Object.assign(input, {
    isTTY: true, isRaw: previousRaw, modes: [], paused: false,
    setRawMode(mode) { this.isRaw = mode; this.modes.push(mode); },
    setEncoding(value) { this.encoding = value; },
    resume() { this.paused = false; }, pause() { this.paused = true; },
  });
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  return { input, output };
}

function assertRestored(io, previousRaw = false) {
  assert.deepEqual(io.input.modes, [true, previousRaw]);
  assert.equal(io.input.paused, true);
  assert.equal(io.input.listenerCount("data"), 0);
  assert.equal(io.input.listenerCount("error"), 0);
  assert.equal(io.output.text, "Password: \n");
}

test("hidden terminal input never echoes characters and restores terminal state after submit", async () => {
  const io = terminal();
  const result = readHiddenPassword("Password: ", io);
  io.input.emit("data", "synthetic😀\u007f_credential\r\n");
  assert.equal(await result, "synthetic_credential");
  assertRestored(io);
});

test("hidden input disables echo and attaches the reader before exposing the prompt", async () => {
  const io = terminal();
  io.output.write = function(value) {
    this.text += value;
    if (value === "Password: ") {
      assert.equal(io.input.isRaw, true, "Visible password prompt must already have echo disabled");
      assert.equal(io.input.listenerCount("data"), 1);
      assert.equal(io.input.paused, false);
      io.input.emit("data", "synthetic_immediate_input\n");
    }
  };
  assert.equal(await readHiddenPassword("Password: ", io), "synthetic_immediate_input");
  assertRestored(io);
});

test("failure to disable terminal echo refuses before showing a password prompt", async () => {
  const io = terminal();
  io.input.setRawMode = () => { throw new Error("SYNTHETIC_TTY_MODE_FAILED"); };
  await assert.rejects(readHiddenPassword("Password: ", io), /SYNTHETIC_TTY_MODE_FAILED/);
  assert.equal(io.output.text, "");
  assert.equal(io.input.listenerCount("data"), 0);
});

test("hidden input cancellation, stream error and overflow reject without echo or stale listeners", async () => {
  for (const scenario of ["ctrl-c", "ctrl-d", "escape", "overflow", "stream-error"]) {
    const io = terminal(true);
    const result = readHiddenPassword("Password: ", io);
    const assertion = assert.rejects(result, /CANCELLED|PASSWORD_INPUT_REJECTED|PASSWORD_INPUT_FAILED/);
    io.input.emit("data", "typed_secret");
    if (scenario === "stream-error") io.input.emit("error", new Error("must never be rendered"));
    else io.input.emit("data", scenario === "ctrl-c" ? "\u0003" : scenario === "ctrl-d" ? "\u0004" : scenario === "escape" ? "\u001b" : "x".repeat(129));
    await assertion;
    assertRestored(io, true);
  }
});

test("hidden input refuses piped stdin or redirected output before reading anything", () => {
  for (const surface of ["input", "output"]) {
    const io = terminal();
    io[surface].isTTY = false;
    assert.throws(() => readHiddenPassword("Password: ", io), /TTY_REQUIRED/);
    assert.equal(io.output.text, "");
    assert.deepEqual(io.input.modes, []);
  }
});
