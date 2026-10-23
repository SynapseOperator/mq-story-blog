import { defineConfig } from "prisma/config";

// Generate/validate/build do not need a running DB or a secret.
// The database command wrapper supplies an explicitly validated target URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
