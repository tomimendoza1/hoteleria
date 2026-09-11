import "dotenv/config";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const url = process.env.DATABASE_URL_DIRECT;
if (!url) throw new Error("Configure DATABASE_URL_DIRECT para migraciones");
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 10000,
});
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(71830609)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL("../db/" + name, import.meta.url),
      "utf8",
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    const previous = (
      await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      )
    ).rows[0];
    if (previous) {
      if (previous.checksum !== hash)
        throw new Error("Migración modificada: " + name);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, hash],
      );
      await client.query("COMMIT");
      console.log("Aplicada:", name);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await client.end();
}
