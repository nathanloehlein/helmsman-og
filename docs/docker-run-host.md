# Docker execution

Set `RUN_HOST=docker` and `HELMSMAN_DOCKER_IMAGE=helmsman/moonunit-adoption:test` after building:

```sh
docker build -t helmsman/moonunit-adoption:test -f docker/helmsman-runtime/Dockerfile .
```

The image pins Node's base digest, Codex 0.155.1 and Claude Code 2.1.278. No host home directory, SSH material, Git credential configuration, Docker socket, or long-lived API token is mounted. Generic offline commands use the durable Docker RunHost; coding and PR review keep their supervisor on the host and run individual agent stages in containers. The supervisor preserves existing exact-revision review gates and performs publication. Container GitHub access is read-only. Merges remain human actions.

Each agent stage uses a standalone Git clone, a private runtime directory, and the pinned skills directory mounted read-only. Review workspaces are read-only, with separate output files. The host verifies bounded regular output files, records immutable artifacts, and replaces guest Git configuration before invoking host Git. Each stage has an internal Docker network and a gateway relay. The relay forwards only to the authenticated host gateway; agent containers cannot connect directly to host services or the internet. Network and container identities carry the run ID for cleanup.

Configure `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` on the host. Dual-provider review requires both. The gateway defaults to port 8790 (`HELMSMAN_GATEWAY_PORT`); access requires a random per-run capability, stored as a hash in SQLite, valid only while that run is active. Capabilities expire within 24 hours and are revoked when the run completes. Upstream credentials stay in the host process. Codex uses its documented custom-provider configuration inside a fresh private `CODEX_HOME`; host authentication/configuration is not copied. Provider prices are never inferred.

Dependency installation cannot use unrestricted internet access. Provision the required dependency cache in the runtime image; private registries require an explicitly scoped future bridge.

Docker PR branch-update reruns currently fail preflight with an actionable instruction to use the trusted local host. Coding and standalone PR review are supported; local execution remains the default. Missing images, provider credentials, or required skills produce preflight errors rather than fallback to an unisolated host. No remote control channel is introduced: detached supervisors and Docker identities use the existing durable recovery protocol.

Validation: built the runtime image; exercised actual Docker launch, host-visible logs/exit code and liveness; exercised provider gateway behavior against fake upstreams without paid API calls. An actual provider-backed isolated coding/review run requires host API keys, which are not configured in this development session.

References: [Codex advanced configuration](https://developers.openai.com/codex/config-advanced/) and [configuration reference](https://developers.openai.com/codex/config-reference/), retrieved 18 September 2026.
