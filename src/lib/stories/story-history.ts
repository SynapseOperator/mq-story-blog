/** Native History API is supported by Next's App Router. Let it carry its state;
 * store only routing coordinates here, never article text, drafts or credentials. */
export const HISTORY_KEY = "mqStoryHistory";
type Entry = { chain: string; index: number; path: string; fromHome: boolean };
type Host = Pick<Window, "history" | "location" | "addEventListener" | "removeEventListener">;
type Callbacks = {
  onRoute: (slug: string | null, initial?: boolean) => void;
  hasReader: () => boolean;
  requestClose: () => boolean;
};

export function storyPath(slug: string) { return `/stories/${encodeURIComponent(slug)}`; }
export function pathStorySlug(path: string): string | null {
  const match = /^\/stories\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function entry(value: unknown, path: string): Entry | null {
  if (!value || typeof value !== "object") return null;
  const item = (value as Record<string, unknown>)[HISTORY_KEY] as Partial<Entry> | undefined;
  return item && typeof item.chain === "string" && Number.isSafeInteger(item.index) && item.index! >= 0
    && item.path === path && typeof item.fromHome === "boolean" ? item as Entry : null;
}

/** A guarded traversal goes back to its source before asking the existing
 * reader to close. Cancel needs no push/replace, so it cannot duplicate history.
 * The matching traversal is replayed only after the reader confirms and closes. */
export function createStoryHistory(host: Host, callbacks: Callbacks, chain: string) {
  let current = entry(host.history.state, host.location.pathname) ?? {
    chain, index: 0, path: host.location.pathname, fromHome: false,
  };
  let pending: Entry | null = null;
  let mode: "idle" | "restore" | "confirm" | "commit" = "idle";
  let active = true;
  const write = (method: "pushState" | "replaceState", value: Entry) => {
    // Next's supported native-history integration carries its internal state.
    // Do not copy private router flags: that would bypass URL synchronization.
    host.history[method]({ [HISTORY_KEY]: value }, "", value.path);
  };
  const publish = (value: Entry, initial = false) => {
    current = value;
    callbacks.onRoute(pathStorySlug(value.path), initial);
  };
  function onPop() {
    if (!active) return;
    const target = entry(host.history.state, host.location.pathname);
    // Do not hijack external/unknown history. Cross-document draft protection
    // uses the browser's beforeunload confirmation, not fabricated history.
    if (!target || target.chain !== current.chain) return;
    if (mode === "restore") {
      if (target.index !== current.index) { host.history.go(current.index - target.index); return; }
      mode = "confirm";
      if (!callbacks.requestClose()) { pending = null; mode = "idle"; }
      return;
    }
    if (mode === "confirm") {
      if (target.index !== current.index) host.history.go(current.index - target.index);
      return;
    }
    if (mode === "commit") {
      mode = "idle"; pending = null; publish(target); return;
    }
    if (target.index === current.index && target.path === current.path) return;
    if (callbacks.hasReader()) {
      pending = target;
      mode = "restore";
      host.history.go(current.index - target.index);
    } else publish(target);
  }
  // Initial stamping changes no URL. Preserve pre-hydration router state even
  // when the child's mount effect runs before Next installs its history wrapper.
  host.history.replaceState({ ...host.history.state, [HISTORY_KEY]: current }, "");
  host.addEventListener("popstate", onPop);
  publish(current, true);
  return {
    open(slug: string) {
      if (mode !== "idle" || callbacks.hasReader()) return;
      const path = storyPath(slug);
      if (path === current.path) return;
      const next = { chain: current.chain, index: current.index + 1, path, fromHome: current.path === "/" };
      write("pushState", next); publish(next);
    },
    cancel() { if (mode === "confirm") { pending = null; mode = "idle"; } },
    closed() {
      if (pending && mode === "confirm") {
        const delta = pending.index - current.index;
        mode = "commit";
        host.history.go(delta);
      } else if (current.fromHome && current.index > 0) {
        mode = "commit";
        host.history.back();
      } else {
        // A direct shared URL has no proven MQ home predecessor. Replace only
        // this entry: closing must never send the reader to an external site.
        mode = "idle"; pending = null;
        const home = { ...current, path: "/", fromHome: false };
        write("replaceState", home); publish(home);
      }
    },
    dispose() { active = false; host.removeEventListener("popstate", onPop); },
  };
}
