import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";

export const AUTH_TRANSACTION_POLICY = Object.freeze({ maxWait: 5000, timeout: 5000 });

/** Signup hashes inside Better Auth's transaction. A bounded five-second
 * acquisition budget accommodates the admitted burst on the three-connection
 * pool; the transaction execution timeout remains unchanged. This specialization
 * does not change the P2-03 client, schema, hash queue, or admission quotas.
 */
export function createAuthDatabaseClient(connectionString: string) {
  const adapter = new PrismaPg({ connectionString, max: 3,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  return new PrismaClient({ adapter, transactionOptions: AUTH_TRANSACTION_POLICY });
}
