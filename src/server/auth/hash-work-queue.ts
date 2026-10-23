export class AuthHashBusyError extends Error {
  readonly code = "AUTH_HASH_BUSY";

  constructor() {
    super("Authentication is busy. Please try again shortly.");
    this.name = "AuthHashBusyError";
  }
}

/** Only bounds password work in this Node process; shared HTTP limits live in PostgreSQL. */
export class PasswordWorkQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < 2) {
      this.active += 1;
    } else {
      if (this.waiting.length >= 4) throw new AuthHashBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      // Transfer the occupied permit before waking a waiter: a new caller cannot steal it.
      if (next) next();
      else this.active -= 1;
    }
  }
}
