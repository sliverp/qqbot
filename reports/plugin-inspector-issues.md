# OpenClaw Plugin Issue Findings

Generated: deterministic
Status: PASS

## Triage Summary

| Metric               | Value |
| -------------------- | ----- |
| Issue findings       | 5     |
| P0                   | 0     |
| P1                   | 1     |
| Live issues          | 0     |
| Live P0 issues       | 0     |
| Compat gaps          | 0     |
| Deprecation warnings | 1     |
| Inspector gaps       | 4     |
| Upstream metadata    | 0     |
| Contract probes      | 5     |

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

## Issues

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
