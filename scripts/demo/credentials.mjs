// Only consumed by the host's interactive credentials command or isolated tests.
// Container stdout is captured in memory; never use Docker logs for credentials.
import { readFile } from "node:fs/promises";
const { admin, reader } = JSON.parse(await readFile("/run/mq-demo/setup/credentials.json", "utf8"));
process.stdout.write(JSON.stringify({ admin, reader }));
