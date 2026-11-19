# Working on MQ Story

## Start here

- Read [README](README.md), [development guide](docs/DEVELOPMENT.md) and `git status` before editing. Preserve unrelated changes.
- Keep the modular Next.js monolith. Reuse existing services before introducing abstractions or moving directories.
- `src/app/` owns pages and HTTP routes; `src/server/` owns authentication and transactional domain services; `src/components/` owns UI; `prisma/` owns the schema and incremental SQL migrations.
- `scripts/` contains local tools, tests and deployment operations. Current contracts are indexed in [docs/README.md](docs/README.md); dated experiments belong in [docs/archive/](docs/archive/README.md).

## Commands and checks

- Use Node **24.22.2** and npm **11.21.2** with the committed lockfile. Keep npm `private: true`.
- Install: `npm ci`. Local demo: `npm run demo`. Scene development: `npm run dev`.
- Quality: `npm run check` (lint, schema validation, types, unit tests, build).
- Focused entry points: `test:unit`, `test:integration`, `test:e2e`, `test:ops`; see the development guide for database, image and browser prerequisites. `test:demo` exercises the local demo lifecycle.
- Run tests appropriate to the change. Report actual commands, exit codes and omissions. A build does not replace browser or database verification; documentation changes need link and example checks rather than unrelated integration suites.
- `quality`, `database` and `container` are required GitHub Actions checks. Do not skip checks, manufacture success or bypass branch protection. PRs require independent review of the latest change; merging and deployment need separate authorization.

## Data and security boundaries

- Append migrations; never rewrite applied migrations or reset an existing database to make a test pass. Preserve story bindings and data.
- Integration tests create their own random databases and synthetic content inside the guarded test environment. The demo has its own local resources. Neither may target an existing development or production database.
- Admin writes use `withAdmin(request, async (tx, principal) => ...)` and the same transaction's `tx`. Do not trust a client role or open a second transaction for protected work.
- Public readers use only the selected `PUBLISHED` revision. Drafts, old revisions, private media, internal account fields and Session tokens must not reach public APIs, HTML, metadata or logs. An unavailable database must not silently fall back to demo stories.
- Preserve Origin/CSRF checks, the auth route whitelist, encrypted Session storage and separate runtime/migration/maintenance/backup identities. See [Session storage](docs/engineering/SESSION_STORAGE.md) and [database permissions](docs/engineering/PRODUCTION_FOUNDATION.md).
- Never commit credentials, `.env` files, backups, browser profiles, private stories or personal photos. Do not print connection strings or secrets when reporting an error.
- Repository changes and local tests do not authorize operations on a real host, database, bucket, DNS or firewall. Deployment tools require their documented target checks and approvals.

## Product and contribution scope

- Preserve the accepted artwork and responsive layout unless the requested change includes visual work. There are seven preset story stars and one campfire entry; decorative stars are not interactive. Long stories scroll inside the letter.
- The editor keeps working, sent and confirmed state separate; unknown writes are reconciled rather than blindly resent. Comments remain subject to moderation.
- Use [product requirements](docs/product/MQ_共享主页_PRD_v1.1.md) and [recorded decisions](docs/engineering/DECISIONS_AND_REVIEW.md) for ambiguous behavior; cite the document as well as any requirement number.
- Keep PRs reviewable: describe the problem, final behavior, validation and limitations. Do not expand a small fix into unrelated refactoring or a new test framework.
- Code is MIT; artwork has separate terms in [ASSETS_LICENSE.md](ASSETS_LICENSE.md). Do not silently change those terms or introduce unlicensed assets.
