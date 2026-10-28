import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  pool: Pool;
  db: Database;
}

/** Creates the connection pool and the drizzle client used by the repositories. */
export function createDatabase(connectionString: string, maxConnections = 10): DatabaseHandle {
  const pool = new Pool({ connectionString, max: maxConnections });

  return { pool, db: drizzle(pool, { schema }) };
}

/** Trivial liveness query used by `/readyz`. */
export async function pingDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
