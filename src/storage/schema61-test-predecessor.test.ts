import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { removeEmptySchema61TestSuccessor } from "../../scripts/fixtures/schema61-test-predecessor";

// Reduced helper fixtures test only refusal/atomicity, never historical
// StateStore migration or native custody admission.
const fixture = () => {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
    CREATE TABLE provider_process_invocations(nonce TEXT PRIMARY KEY) STRICT;
    CREATE TABLE retained_history(value TEXT NOT NULL) STRICT;
    INSERT INTO retained_history VALUES('unchanged'); PRAGMA user_version=61`);
  const insert = database.query("INSERT INTO migrations VALUES (?,?)");
  for (let version = 1; version <= 61; version++) insert.run(version, 1000 + version);
  return database;
};
const snapshot = (database: Database) => ({
  schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  version: database.query("PRAGMA user_version").get(),
  ledger: database.query("SELECT * FROM migrations ORDER BY version").all(),
  custody: database.query("SELECT * FROM provider_process_invocations").all(),
  retained: database.query("SELECT * FROM retained_history").all(),
});

test("schema61 predecessor helper removes only empty successor custody and its ledger row", () => {
  const database = fixture();
  try {
    const before = snapshot(database);
    removeEmptySchema61TestSuccessor(database);
    expect(database.query("SELECT name FROM sqlite_master WHERE tbl_name='provider_process_invocations'").all()).toEqual([]);
    expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(before.ledger.slice(0, 60));
    expect(database.query("SELECT * FROM retained_history").all()).toEqual(before.retained);
    // The existing caller must explicitly apply its intended historical stamp.
    expect(database.query("PRAGMA user_version").get()).toEqual(before.version);
  } finally { database.close(); }
});

for (const invalid of ["custody", "version", "ledger"] as const) {
  test(`schema61 predecessor helper refuses ${invalid} without changing any schema or retained rows`, () => {
    const database = fixture();
    try {
      if (invalid === "custody") database.exec("INSERT INTO provider_process_invocations VALUES('retained-native-proof')");
      else if (invalid === "version") database.exec("PRAGMA user_version=60");
      else database.exec("DELETE FROM migrations WHERE version=60");
      const before = snapshot(database);
      expect(() => removeEmptySchema61TestSuccessor(database)).toThrow();
      expect(snapshot(database)).toEqual(before);
    } finally { database.close(); }
  });
}
