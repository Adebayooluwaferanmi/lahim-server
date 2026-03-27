# LaHIM Server

Fastify backend for LaHIM.

## Overview

This package provides the main API surface for the LaHIM platform, including laboratory workflows, reporting, quality control, workflow dashboards, integrations, and supporting operational services.

The active server direction is:

- Fastify + TypeScript
- PostgreSQL + Prisma for primary domain modeling
- Redis for cache/infrastructure support
- modern observability, eventing, and dual-write migration helpers where needed

## Development

```bash
yarn install
yarn dev
```

Useful commands:

```bash
yarn build
yarn test
yarn db:generate
yarn db:migrate
yarn seed:vocabularies
```

## Notes

- This package is part of the LaHIM workspace.
- Production-facing work should use LaHIM-owned repos, package names, docs, and operational conventions.
- Legacy compatibility layers may remain temporarily where they support migration, but the active target is a fully LaHIM-owned backend surface.

## License

Released under the [MIT license](LICENSE).
