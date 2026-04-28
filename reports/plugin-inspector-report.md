# OpenClaw Plugin Compatibility Report

Generated: deterministic
Status: PASS

## Summary

| Metric                    | Value |
| ------------------------- | ----- |
| Fixtures                  | 1     |
| High-priority fixtures    | 1     |
| Hard breakages            | 0     |
| Warnings                  | 1     |
| Compatibility suggestions | 4     |
| Issue findings            | 5     |
| P0 issues                 | 0     |
| P1 issues                 | 1     |
| Live issues               | 0     |
| Live P0 issues            | 0     |
| Compat gaps               | 0     |
| Deprecation warnings      | 1     |
| Inspector gaps            | 4     |
| Upstream metadata         | 0     |
| Contract probes           | 5     |
| Decision rows             | 5     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                         |
| ------------------- | ----- | -- | --------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam. |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                          |
| deprecation-warning | 1     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                |
| inspector-gap       | 4     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments.                        |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.        |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                           |

## P0 Live Issues

_none_

## Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

- P2 **openclaw-qqbot** `deprecation-warning` `core-compat-adapter`
  - **legacy-root-sdk-import**: openclaw-qqbot: root plugin SDK barrel is still used by fixtures
  - state: open · compat:deprecated · deprecated
  - evidence:
    - openclaw/plugin-sdk @ index.ts:1
    - openclaw/plugin-sdk @ index.ts:2
    - openclaw/plugin-sdk @ src/approval-handler.ts:12
    - openclaw/plugin-sdk @ src/config.ts:2
    - openclaw/plugin-sdk @ src/onboarding.ts:13
    - openclaw/plugin-sdk @ src/proactive.ts:67
    - openclaw/plugin-sdk @ src/runtime.ts:1
    - openclaw/plugin-sdk @ src/tools/channel.ts:1
    - openclaw/plugin-sdk @ src/tools/remind.ts:1

## Inspector Proof Gaps

- P1 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: openclaw-qqbot: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: openclaw-qqbot: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: openclaw-qqbot: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - mpg123-decoder @ package.json
    - silk-wasm @ package.json
    - ws @ package.json
    - openclaw @ package.json

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: openclaw-qqbot: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ src/tools/channel.ts:138
    - registerTool @ src/tools/remind.ts:222

## Upstream Metadata Issues

_none_

## Hard Breakages

_none_

## Target OpenClaw Compat Records

| Metric                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured path          | /Users/vincentkoc/GIT/_Perso/openclaw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Status                   | ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat registry          | ../../openclaw/src/plugins/compat/registry.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Compat records           | 56                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Compat status counts     | active:13, deprecated:43                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Record ids               | activation-agent-harness-hint, activation-capability-hint, activation-channel-hint, activation-command-hint, activation-config-path-hint, activation-provider-hint, activation-route-hint, agent-harness-id-alias, agent-harness-sdk-alias, agent-tool-result-harness-alias, approval-capability-approvals-alias, bundled-channel-config-schema-legacy, bundled-plugin-allowlist, bundled-plugin-enablement, bundled-plugin-load-path-aliases, bundled-plugin-vitest-defaults, channel-env-vars, channel-exposure-legacy-aliases, channel-mention-gating-legacy-helpers, channel-native-message-schema-helpers, channel-route-key-aliases, channel-runtime-sdk-alias, channel-target-comparable-aliases, clawdbot-config-type-alias, command-auth-status-builders, disable-persisted-plugin-registry-env, embedded-harness-config-alias, generated-bundled-channel-config-fallback, hook-only-plugin-shape, legacy-before-agent-start, legacy-extension-api-import, legacy-implicit-startup-sidecar, legacy-root-sdk-import, memory-split-registration, openclaw-schema-type-alias, plugin-activate-entrypoint-alias, plugin-install-config-ledger, plugin-owned-web-fetch-config, plugin-owned-web-search-config, plugin-owned-x-search-config, plugin-registry-install-migration-env, plugin-sdk-test-utils-alias, plugin-sdk-testing-barrel, provider-auth-env-vars, provider-discovery-hook-alias, provider-discovery-type-aliases, provider-external-oauth-profiles-hook, provider-static-capabilities-bag, provider-thinking-policy-hooks, provider-web-search-core-wrapper, runtime-config-load-write, runtime-inbound-envelope-alias, runtime-stt-alias, runtime-subagent-get-session-alias, runtime-taskflow-legacy-alias, setup-runtime-fallback |
| Hook registry            | ../../openclaw/src/plugins/hook-types.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hook names               | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API builder              | ../../openclaw/src/plugins/api-builder.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API registrars           | 48                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Captured registration    | ../../openclaw/src/plugins/captured-registration.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Captured registrars      | 26                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Package metadata         | ../../openclaw/package.json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plugin SDK exports       | 292                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Manifest types           | ../../openclaw/src/plugins/manifest.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Manifest fields          | 35                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Manifest contract fields | 17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Warnings

| Fixture        | Code                   | Level   | Message                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                              | Compat record          |
| -------------- | ---------------------- | ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| openclaw-qqbot | legacy-root-sdk-import | warning | fixture imports the root plugin SDK barrel | openclaw/plugin-sdk @ index.ts:1, openclaw/plugin-sdk @ index.ts:2, openclaw/plugin-sdk @ src/approval-handler.ts:12, openclaw/plugin-sdk @ src/config.ts:2, openclaw/plugin-sdk @ src/onboarding.ts:13, openclaw/plugin-sdk @ src/proactive.ts:67, openclaw/plugin-sdk @ src/runtime.ts:1, openclaw/plugin-sdk @ src/tools/channel.ts:1, openclaw/plugin-sdk @ src/tools/remind.ts:1 | legacy-root-sdk-import |

## Suggestions To OpenClaw Compat Layer

| Fixture        | Code                                | Level      | Message                                                                                                      | Evidence                                                                                            | Compat record |
| -------------- | ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------- |
| openclaw-qqbot | package-dependency-install-required | suggestion | package declares runtime dependencies that must be installed before cold import                              | mpg123-decoder @ package.json, silk-wasm @ package.json, ws @ package.json, openclaw @ package.json | -             |
| openclaw-qqbot | registration-capture-gap            | suggestion | future inspector capture API should record lifecycle, route, gateway, command, and interactive registrations | registerChannel @ index.ts:16                                                                       | -             |
| openclaw-qqbot | channel-contract-probe              | suggestion | add channel envelope, config-schema, and runtime metadata probes                                             | registerChannel @ index.ts:16                                                                       | -             |
| openclaw-qqbot | runtime-tool-capture                | suggestion | tool shape is only visible after runtime registration capture                                                | registerTool @ src/tools/channel.ts:138, registerTool @ src/tools/remind.ts:222                     | -             |

## Issue Findings

- P1 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **registration-capture-gap**: openclaw-qqbot: runtime registrations need capture before contract judgment
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: openclaw-qqbot: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `deprecation-warning` `core-compat-adapter`
  - **legacy-root-sdk-import**: openclaw-qqbot: root plugin SDK barrel is still used by fixtures
  - state: open · compat:deprecated · deprecated
  - evidence:
    - openclaw/plugin-sdk @ index.ts:1
    - openclaw/plugin-sdk @ index.ts:2
    - openclaw/plugin-sdk @ src/approval-handler.ts:12
    - openclaw/plugin-sdk @ src/config.ts:2
    - openclaw/plugin-sdk @ src/onboarding.ts:13
    - openclaw/plugin-sdk @ src/proactive.ts:67
    - openclaw/plugin-sdk @ src/runtime.ts:1
    - openclaw/plugin-sdk @ src/tools/channel.ts:1
    - openclaw/plugin-sdk @ src/tools/remind.ts:1

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: openclaw-qqbot: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - mpg123-decoder @ package.json
    - silk-wasm @ package.json
    - ws @ package.json
    - openclaw @ package.json

- P2 **openclaw-qqbot** `inspector-gap` `inspector-follow-up`
  - **runtime-tool-capture**: openclaw-qqbot: runtime tool schema needs registration capture
  - state: open · compat:none
  - evidence:
    - registerTool @ src/tools/channel.ts:138
    - registerTool @ src/tools/remind.ts:222

## Contract Probe Backlog

- P1 **openclaw-qqbot** `inspector-capture-api`
  - contract: External inspector capture records service, route, gateway, command, and interactive registrations.
  - id: `api.capture.runtime-registrars:openclaw-qqbot`
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `channel-runtime`
  - contract: Channel setup, message envelope, sender metadata, and config schema remain stable.
  - id: `channel.runtime.envelope-config-metadata:openclaw-qqbot`
  - evidence:
    - registerChannel @ index.ts:16

- P2 **openclaw-qqbot** `package-loader`
  - contract: Inspector installs package dependencies in an isolated workspace before cold import.
  - id: `package.entrypoint.isolated-dependency-install:openclaw-qqbot`
  - evidence:
    - mpg123-decoder @ package.json
    - silk-wasm @ package.json
    - ws @ package.json
    - openclaw @ package.json

- P2 **openclaw-qqbot** `sdk-alias`
  - contract: Root plugin SDK barrel remains importable or has a machine-readable migration path.
  - id: `sdk.import.root-barrel-cold-import:openclaw-qqbot`
  - evidence:
    - openclaw/plugin-sdk @ index.ts:1
    - openclaw/plugin-sdk @ index.ts:2
    - openclaw/plugin-sdk @ src/approval-handler.ts:12
    - openclaw/plugin-sdk @ src/config.ts:2
    - openclaw/plugin-sdk @ src/onboarding.ts:13
    - openclaw/plugin-sdk @ src/proactive.ts:67
    - openclaw/plugin-sdk @ src/runtime.ts:1
    - openclaw/plugin-sdk @ src/tools/channel.ts:1
    - openclaw/plugin-sdk @ src/tools/remind.ts:1

- P2 **openclaw-qqbot** `tool-runtime`
  - contract: Registered runtime tools expose stable names, input schemas, and result metadata.
  - id: `tool.registration.schema-capture:openclaw-qqbot`
  - evidence:
    - registerTool @ src/tools/channel.ts:138
    - registerTool @ src/tools/remind.ts:222

## Fixture Seam Inventory

| Fixture        | Priority | Seams          | Hooks | Registrations                 | Manifest contracts |
| -------------- | -------- | -------------- | ----- | ----------------------------- | ------------------ |
| openclaw-qqbot | high     | plugin-runtime | -     | registerChannel, registerTool | -                  |

## Decision Matrix

| Fixture        | Decision            | Seam                 | Action                                                                                               | Evidence                                      |
| -------------- | ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| openclaw-qqbot | inspector-follow-up | cold-import          | Install runtime dependencies in an isolated workspace before executing this fixture entrypoint.      | mpg123-decoder, silk-wasm, ws, openclaw       |
| openclaw-qqbot | core-compat-adapter | sdk-import           | Keep the root SDK barrel stable or expose a machine-readable migration map before removing aliases.  | openclaw/plugin-sdk                           |
| openclaw-qqbot | inspector-follow-up | registration-capture | Expose or mirror a full public API capture shim before treating these runtime-only seams as covered. | registerChannel                               |
| openclaw-qqbot | inspector-follow-up | channel-runtime      | Probe channel setup and message envelope contracts before changing channel runtime payloads.         | registerChannel                               |
| openclaw-qqbot | inspector-follow-up | tool-schema          | Capture registered tool schemas from plugin register() before judging tool compatibility.            | registerTool without manifest contracts.tools |

## Raw Logs

| Fixture        | Code                    | Level | Message                                                                          | Evidence                                                     | Compat record          |
| -------------- | ----------------------- | ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| openclaw-qqbot | seam-inventory          | log   | observed 0 hooks, 2 registrations, and 0 manifest contracts                      | registration:registerChannel, registration:registerTool      | -                      |
| openclaw-qqbot | hook-names-present      | log   | all observed hooks exist in the target OpenClaw hook registry                    | -                                                            | -                      |
| openclaw-qqbot | api-registrars-present  | log   | all observed api.register* calls exist in the target OpenClaw plugin API builder | registerChannel, registerTool                                | -                      |
| openclaw-qqbot | sdk-exports-present     | log   | all observed plugin SDK imports exist in target OpenClaw package exports         | openclaw/plugin-sdk, openclaw/plugin-sdk/core                | -                      |
| openclaw-qqbot | manifest-fields-checked | log   | plugin manifest fields were compared with target OpenClaw manifest types         | openclaw.plugin.json                                         | -                      |
| openclaw-qqbot | package-metadata        | log   | selected package metadata for plugin contract checks                             | package.json, @tencent-connect/openclaw-qqbot, version:1.7.1 | -                      |
| openclaw-qqbot | compat-record-present   | log   | target OpenClaw checkout has a matching compat registry record                   | legacy-root-sdk-import, status:deprecated                    | legacy-root-sdk-import |
