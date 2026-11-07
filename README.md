# Saathi · ਸਾਥੀ

A family assistant for live English ↔ Indian Punjabi conversations and Punjabi explanations of English letters and emails. Built with React, Vinext, Cloudflare Workers/D1, and Gemini.

Production: https://saathi-punjabi-family.guri007.chatgpt.site

## Development

Use the Node version in `.nvmrc` and the committed npm lockfile.

```sh
npm run install:ci
npm run dev
```

The local preview normally opens at `http://127.0.0.1:5173`. Local sign-in simulates a development identity only; production sign-in is provided by Sites.

Keep local settings in ignored `.dev.vars`. The application needs `SAATHI_SECRET` (a random encryption/session secret) and `OWNER_EMAIL`. The organizer enters the Gemini key privately through setup. Never copy production credentials or the live database into development or CI.

The Sites runtime/build integration is vendored under `scripts/`; a clean GitHub runner does not need Codex or a local Sites plugin to check and build the app.

## Checks

```sh
npm test                 # Discover all tests, including new test files
npm run typecheck        # Generate framework types and check TypeScript
npm run check            # Typecheck and tests
npm run ci               # Typecheck, tests, production build, artifact checks
```

Tests use mocked Google responses and isolated databases. They make no paid AI calls and need no Gemini key, family code, or production secrets. They cover authorization, encryption, provider errors, continuous audio lifecycle, and microphone resampling. Changes to speech behavior still need a real spoken exchange on an iPhone.

## GitHub workflow

Use a feature branch and pull request; wait for **Saathi CI** before merging to `main`. The workflow also runs on `main` and can be started manually. It installs locked dependencies and runs `npm run ci`.

Successful `main` pushes produce a release candidate with the exact source revision and build provenance. PR checks have read-only repository permissions and no production secrets. The workflow does not publish to the family app.

**Deployment boundary:** the current public Sites host has no supported GitHub Actions deployment integration. Checks and release packaging can run automatically; production publication currently uses authenticated Codex/Sites tools. Never store temporary Sites source credentials as GitHub secrets or substitute `wrangler deploy`: Sites owns the real database bindings, secrets, and sign-in routing.

If supported by the GitHub account, protect `main` by requiring a pull request and the **Validate and build** check. The workflow file alone does not enforce branch protection.

## Release and rollback

Ask Codex to publish a successful `main` revision. The release must verify the exact commit and its successful CI run, open the existing Site with the supported source helper, reconcile that source, run its checks, push/package it, save the matching Sites version, and deploy through the native Sites tool. Retain the project ID/audience in `.openai/hosting.json`.

Confirm the terminal deployment result and run `npm run smoke:production`. This checks the public page, microphone asset, configured status, and anonymous access boundaries without credentials or AI calls. Never call production `/api/setup` from CI: it rotates the family setup.

Record both the GitHub revision and Sites version in the release report. Sites may assign a separate source commit during publication. A successful GitHub build alone does not mean the release is deployed.

To roll back application code, deploy the last known-good saved Sites version. Code rollback does not undo database migrations or restore deleted data; prefer additive, compatible migrations.

## Application layout

- `app/`: accessible bilingual interface and API routing.
- `lib/live-conversation.ts`, `public/saathi-microphone.js`: streaming audio capture/playback and cleanup.
- `lib/live-config.ts`, `lib/gemini-live.ts`: constrained short-lived Live credentials.
- `lib/gemini.ts`: letter translation, explanation, and speech.
- `lib/server.ts`, `lib/security.ts`: authorization, limits, and encrypted settings.
- `db/schema.ts`, `drizzle/`: schema and migrations.
- `tests/`: automatically discovered tests.

For schema changes, run `npm run db:generate` and commit a new migration. Do not edit an already-applied migration. Sites publication applies production migrations.
