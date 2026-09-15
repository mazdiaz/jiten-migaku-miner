import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let database: ReturnType<typeof drizzle<typeof schema>> | undefined;
export function getDatabase() {
  if (!database) {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error("DATABASE_URL is not configured. Set up PostgreSQL before using the app.");
    database = drizzle(
      postgres(url, { max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false }),
      { schema },
    );
  }
  return database;
}
