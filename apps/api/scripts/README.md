# apps/api/scripts

One-off operational tools. Nothing here is part of the running API: `nest build` only compiles `src/`
(see `tsconfig.build.json`), so these files never ship in the deployed image.

- `diagnostics/` read-only checks against a real database (permissions, registry rows, roles). Run with
  `node -r ts-node/register/transpile-only scripts/diagnostics/<file>.ts` from `apps/api`. They read
  `apps/api/.env` and only print; they change nothing.
- `local/` is git-ignored. Put personal helper scripts here (anything that holds a personal email, a password
  or a TOTP lookup). Never commit credentials.

The tools that are part of normal operation stay in `src/database/` and have npm scripts:
`npm run migrate`, `npm run seed`, `npm run seed:pilot`, `npm run grant-role`, `npm run encrypt-backfill`.
