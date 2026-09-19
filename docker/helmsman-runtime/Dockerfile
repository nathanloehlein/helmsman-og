FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install --yes --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.155.1 @anthropic-ai/claude-code@2.1.278
COPY --chmod=0555 docker/helmsman-runtime/gh.mjs /usr/local/bin/gh
RUN codex --version && claude --version && git --version
WORKDIR /worktree
