import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && process.env.NODE_ENV === "production") {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

if (!databaseUrl) {
  console.warn("[db] DATABASE_URL is not set; database-backed features are unavailable in development.");
}

export const pool = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {}),
  connectionTimeoutMillis: 4000,
  max: 3,
});
pool.on("error", (err) => {
  console.error("[db] pool error:", err.message);
});
export const db = drizzle(pool, { schema });

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (reason) => {
  console.error("[uncaughtException]", reason);
});
