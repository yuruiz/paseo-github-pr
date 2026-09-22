# Validation

The plugin targets the published Paseo 0.8.0 SDK and daemon. The manifest additionally admits the specifically checked 0.9.0-beta.1 and 0.9.0-beta.2 clients.

## Local checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run format:check
npx vitest run tests/tracking.test.ts --maxWorkers=1 --bail=1
```

Run only the test files relevant to a change, with one worker. Tests use temporary directories and synthetic accounts and repositories. They do not need GitHub credentials. State tests require Linux `flock`.

## Isolated daemon check

Set `PASEO_TEST_CLI_ROOT` to an installed `@getpaseo/cli` 0.8.0 package directory and `PASEO_SOURCE_ROOT` to a matching Paseo v0.8.0 source checkout with dependencies installed. Run from this plugin directory:

```sh
node scripts/verify-daemon.mjs
PASEO_TEST_AUTH=1 node scripts/verify-daemon.mjs
```

The script starts its own loopback daemon on an ephemeral port, with temporary state, Git repositories, a fake agent provider, and synthetic GitHub responses. It installs without a bootstrap file and checks automatic address discovery, daemon identity, plugin compilation, RPCs, SDK operations, event dispatch, review workspaces, approval invalidation, and recovery across plugin reload and isolated daemon restart on a different port. It verifies discovery before the first plugin RPC. `PASEO_TEST_AUTH=1` also checks a password-protected daemon using a generated temporary password. The fixture writes the PID descriptor that the normal Paseo supervisor owns. It does not connect to the user's main daemon or contact GitHub.

The fake provider source comes from the explicitly supplied Paseo checkout. Keep that checkout at the matching release; the fixture is not a public SDK contract.

## Client and layout checks

```sh
npm exec -- playwright install chromium
node scripts/verify-ui.mjs
node scripts/verify-beta-client.mjs 0.9.0-beta.1
node scripts/verify-beta-client.mjs 0.9.0-beta.2
```

The beta loader check uses `PASEO_TEST_CLI_ROOT` and `PASEO_SOURCE_ROOT` as above; the source checkout must contain the selected release tag. It compiles the plugin using the 0.8.0 daemon compiler, then runs the tagged beta client evaluator and version checker. Platform UI services are fixtures.

The layout check renders React Native components through React Native Web at desktop, narrow, and compact sizes in light and dark themes. It checks navigation, repository groups, actions and previews, Markdown, overflow, and JavaScript errors. `UI_SNAPSHOT` may point to a private local snapshot for read-only rendering; never commit snapshots or their resulting screenshots.

Each script prints its temporary artifact directory and writes a report there. `TMPDIR` can select another temporary filesystem. Generated reports, logs, screenshots, and snapshots are excluded from the published repository.

## Limits

These checks do not validate real model output, provider authentication, native sandbox enforcement, real GitHub writes, or full Electron/iOS/Android behavior. The daemon check validates public SDK and plugin transport behavior with synthetic external services. The beta check validates registration and cleanup, not a complete remote-app session.

Automated responses remain disabled by default. GitHub writes require confirmation of the exact preview. Existing tests cover stale approvals, duplicate sends, interrupted writes, repository identity, occupied checkouts, and stack progression.
