# Saathi development and releases

Read `README.md` before changes or releases. This is a working family pilot on iPhone/iPad with Indian Punjabi/Gurmukhi as the primary language.

- Use `.nvmrc` and the existing lockfile. Run `npm run install:ci` when installation is needed; never overlap installers.
- Add meaningful tests for changed behavior. `npm test` discovers new test files. Run `npm run ci` before release; failures block publication until fixed.
- Use GitHub feature branches and PRs. Verify the exact selected main revision has successful CI and has not been superseded before production promotion.
- CI is not a production deployment. Public Sites publication requires its supported authenticated source helper and native save/deploy tools. Apply the installed Sites skill. Keep the existing project ID, audience, family link, runtime bindings, and sign-in integration.
- Never put real API keys, session tokens, family codes, production databases, `.dev.vars`, or `.wrangler` state in source, artifacts, logs, workflow secrets, screenshots, or tests. CI uses mocks and isolated databases. Temporary Sites credentials stay in memory and go only through the helper's hidden stdin.
- Preserve organizer/family authorization, same-origin POST checks, no-store responses, and usage limits. Do not reset setup or rotate the family code as part of publication.
- Never call production `/api/setup` for testing. Run secret-free `npm run smoke:production` after deployment.
- Preserve `sites()` and connector/auth wiring. Generated Wrangler bindings are local/build placeholders, not a direct production deployment target.
- Preserve user-gesture audio unlocking, microphone cleanup, background pause, and speaker echo prevention. Report whether a real iPhone conversation was tested; mocked tests do not establish speech quality.
- Keep applied migrations immutable. Code rollback does not undo migrations.
- Report the GitHub revision, saved Sites version, deployment result, and verification limits accurately. Do not call CI-only packaging automatic deployment.
