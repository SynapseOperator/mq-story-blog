# MQ · Our Stories

**Stories among the stars, memories in a letter.**

[Live site](https://mq-story.xyz) · [简体中文](README.md) · [Development guide (Chinese)](docs/DEVELOPMENT.md) · [Documentation index (Chinese)](docs/README.md)

MQ Story is a personal blog about shared memories. Open a star or the campfire to read a story on a feather-decorated letter, with photos, likes and comments alongside the text.

The project also serves as a software engineering and DevOps course project. The repository covers the work from requirements and editing tools to database migrations, deployment and backup recovery. The website launched on **November 12, 2026**, and the repository became public on **November 16, 2026**.

![MQ Story's live home page](docs/showcase/home-desktop-readme.webp)

This is a compressed copy of an actual production screenshot. The original image and its source details are preserved in [the screenshot notes](docs/showcase/README.md). This page provides an English overview; the detailed guides and engineering records are in Chinese.

## Features

- **A sky of stories:** seven fixed star positions and a separate campfire entry. Published stories support mouse, keyboard and touch interaction, with reduced-motion support.
- **Reading and sharing:** text, photos, likes and comments scroll within the letter. Each story has a stable `/stories/:slug` link; browser history and unsent-comment prompts keep navigation predictable.
- **Likes and moderated comments:** signed-in readers can like and unlike stories. Guests can leave anonymous comments; signed-in readers can also choose anonymity. Comments become public only after approval.
- **An author workspace:** the single administrator can edit drafts, upload images, preview star positions, publish, update, withdraw and restore stories. Occupied star positions cannot be assigned twice, and draft edits do not change the published revision.
- **Private content:** draft and media access follows account permissions. Sessions use encrypted storage with a separate protection key. Database identities separate application access from migrations, maintenance and backups.
- **Self-hosting tools:** Docker Compose, Caddy HTTPS, private media storage, Restic-encrypted backups and isolated restore tooling.

The M / Q pages remain placeholders. Comment replies, attachments and a rich-text editor are not implemented.

## Tech stack

| Layer | Implementation |
| --- | --- |
| Frontend | Next.js 16 App Router · React 19 · TypeScript · CSS / Tailwind CSS 4 |
| Server | Node.js 24 · Route Handlers · Better Auth |
| Data | PostgreSQL 18 · Prisma 7 · explicit SQL migrations and constraints |
| Images | Sharp · private storage · permission-checked read endpoints |
| Deployment | Docker Compose · non-root application container · Caddy |
| Testing | Node test runner · Playwright · real PostgreSQL / HTTP / HTTPS |

The development toolchain uses Node **24.22.2** ([.nvmrc](.nvmrc)) and npm **11.21.2**. Exact dependency versions are in [package-lock.json](package-lock.json). The [Chinese README](README.md) includes the architecture diagram and directory guide.

## Run locally

Install Git and the Node/npm versions above. Database features also require Docker with **Linux containers** and Compose. Run these commands from the repository root; Windows PowerShell users can use `npm.cmd` if needed.

### 1. Open the scene

```sh
git clone https://github.com/SynapseOperator/mq-story-blog.git
cd mq-story-blog
npm ci
npm run dev -- --hostname 127.0.0.1
```

Open <http://127.0.0.1:3000>. Without a database, the scene renders, but the story catalog shows an error/retry state and sign-in is disabled. It does not substitute demonstration stories for missing data.

### 2. Add a local database and ordinary accounts

Stop the previous dev server before running:

```sh
npm run db:env
npm run db:up -- dev
npm run db:migrate
npm run auth:env
npm run dev:auth
```

Continue using **`http://127.0.0.1:3000`**, rather than `localhost`: the authentication entry point checks the Origin. The two `*:env` commands create separate, Git-ignored local configuration files with random secrets and refuse to overwrite existing files. Keep those files with their corresponding database volumes; generating a new password does not update an existing database.

Registration creates ordinary users. The default development database identity is intended for initialization and migrations, and is **rejected by the admin workspace** because of its elevated privileges.

### 3. Choose a full application setup

The backend, media, publishing and moderation need their own low-privilege database identities, administrator and signing configuration. There is no default administrator password, and the live website's data is not included.

The [development guide](docs/DEVELOPMENT.md) explains two paths: an automated container exercise using synthetic data, and a persistent self-hosted instance. The container exercise cleans up its own resources on success; it is not a demo server left running for manual use.

## Checks

```sh
npm run check
```

This runs lint, Prisma Schema validation, type checking, Node tests and a production build. It does not require a database connection. Database, browser and container tests run separately according to the change; their commands are listed in [package.json](package.json) and the [development guide](docs/DEVELOPMENT.md).

Use isolated databases and synthetic content for testing, never a production database. Check results and any approved CI exceptions are recorded for each change; a successful build alone does not establish that browser or database tests passed.

## Deployment

The live site runs on a single Ubuntu VPS in Hong Kong, using Compose, PostgreSQL 18 and Caddy. Restic encrypts database and private-media backups before sending them to Alibaba Cloud OSS; an isolated restore has been verified.

To host your own instance, prepare your own domain, database identities, administrator and secret files. Start with the [production configuration guide](docs/engineering/PRODUCTION_FOUNDATION.md), then the [initialization and release procedure](docs/engineering/PRODUCTION_LAUNCH.md). Build versioned images on a build machine or CI before transferring them to a small VPS. Backup and monitoring templates need to be configured for your installation; see [backup and recovery](docs/engineering/PRODUCTION_BACKUP.md).

## License and artwork

Program code is released under the [MIT License](LICENSE), with copyright held by SynapseOperator and SnorkelingBreather.

The couple characters, night-sky scene, feather-letter artwork, MQ wordmark and screenshots containing them are **not covered by MIT**. They may be displayed, downloaded and forked as part of this repository. Independent reuse in another project requires permission from the relevant rights holders. Third-party components retain their own licenses; stories, photos and comments on the live website are not licensed with the source code. See [ASSETS_LICENSE.md](ASSETS_LICENSE.md) for details.

## Contributing and reporting problems

Bug reports, documentation improvements and small pull requests are welcome. Describe what you expected, what happened and how to reproduce it; discuss changes to the overall visual design or data permissions first. See [CONTRIBUTING.md](CONTRIBUTING.md).

GitHub Private Vulnerability Reporting is enabled. Report security issues privately through [Security → Advisories](https://github.com/SynapseOperator/mq-story-blog/security/advisories), following [SECURITY.md](SECURITY.md). Do not include passwords, tokens or private content in public issues or pull requests.
