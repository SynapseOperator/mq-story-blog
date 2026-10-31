/** Reads from an interactive terminal only. I/O injection is exclusively for
 * unit tests; the maintenance CLI never supplies alternate streams or passwords.
 */
export function readHiddenPassword(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") throw new Error("TTY_REQUIRED");
  output.write(prompt);
  const previousRaw = Boolean(input.isRaw);
  let value = "";
  let settled = false;
  return new Promise((resolve, reject) => {
    function finish(error) {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode(previousRaw);
      input.pause();
      output.write("\n");
      if (error) { value = ""; reject(error); }
      else { resolve(value); value = ""; }
    }
    function onError() { finish(new Error("PASSWORD_INPUT_FAILED")); }
    function onData(data) {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") { finish(new Error("CANCELLED")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        if (character.codePointAt(0) < 32 || value.length + character.length > 128) {
          finish(new Error("PASSWORD_INPUT_REJECTED")); return;
        }
        value += character;
      }
    }
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.once("error", onError);
    input.resume();
  });
}
