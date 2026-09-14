// Credential-free child controlled only by exact files in its private fixture.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, label, exitValue] = process.argv.slice(2);
if (process.env.OOMPA_QUEUE_FIXTURE !== "1" || root === undefined || label === undefined
  || !/^[a-z][a-z0-9-]{0,40}$/u.test(label) || (exitValue !== "0" && exitValue !== "7")) throw new Error("invalid queue fixture");
const guard = setTimeout(() => { process.exit(4); }, 25_000);
try {
  appendFileSync(join(root, "order"), `${label}\n`, { mode: 0o600 });
  writeFileSync(join(root, `${label}-ready`), String(process.pid), { mode: 0o600, flag: "wx" });
  while (!existsSync(join(root, `${label}-finish`))) await Bun.sleep(10);
  writeFileSync(join(root, `${label}-finished`), "collected", { mode: 0o600, flag: "wx" });
  process.exitCode = Number(exitValue);
} finally { clearTimeout(guard); }
