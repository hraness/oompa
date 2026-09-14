import type { Database } from "bun:sqlite";
import { z } from "zod";

/**
 * Test-only preparation for an explicitly source-derived predecessor. Remove
 * only the empty schema61 addition; the caller still owns its historical stamp
 * and exact predecessor/cohort assertions. Never apply this to archived bytes
 * or to a database containing even released native custody evidence.
 */
export function removeEmptySchema61TestSuccessor(database: Database): void {
  database.transaction(() => {
    z.object({ user_version: z.literal(61) }).strict().parse(
      database.query("PRAGMA user_version").get(),
    );
    const ledger = z.array(z.object({
      version: z.number().int().positive(),
      applied_at: z.number().int().nonnegative().safe(),
    }).strict()).parse(database.query("SELECT version,applied_at FROM migrations ORDER BY version").all());
    if (ledger.length !== 61 || ledger.some((row, index) => row.version !== index + 1)) {
      throw new Error("SCHEMA61_TEST_PREDECESSOR_LEDGER_INVALID");
    }
    if (database.query("SELECT 1 FROM provider_process_invocations LIMIT 1").get() !== null) {
      throw new Error("SCHEMA61_TEST_PREDECESSOR_CUSTODY_NOT_EMPTY");
    }
    database.exec("DROP TABLE provider_process_invocations");
    if (database.query("DELETE FROM migrations WHERE version=61").run().changes !== 1) {
      throw new Error("SCHEMA61_TEST_PREDECESSOR_LEDGER_INVALID");
    }
  }).immediate();
}
