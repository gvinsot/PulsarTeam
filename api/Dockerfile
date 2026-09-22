# team-api — Express + Socket.IO control plane.
#
# The image is split so the production stage carries *only* what the server
# needs at runtime. The compiler toolchain (gcc/g++/make/musl-dev) exists to let
# `npm ci` build native addons and never reaches the shipped image; docker-cli,
# python and the shell-tool grab bag are gone entirely — the API never shells
# out to a child process (no child_process import anywhere in api/src).
#
# The production stage runs as an unprivileged user. Do not rely on the
# compose/swarm cap_drop for that: an image has to be safe on its own, because
# nothing guarantees it is deployed with this repo's compose file.
#
# DEPLOY NOTE: the process no longer runs as root, so /run/secrets/* must be
# readable by uid 10001. Docker's default secret mode (0444) already is; if the
# deployment system mounts secrets 0400 root-only, give it `uid: "10001"` or
# mode 0444, otherwise readSecret() silently falls back to env vars.

# ── Build stage: full toolchain, dev dependencies, TypeScript compile ────────
FROM node:24-alpine AS build

WORKDIR /app

# Needed by node-gyp for any dependency that ships a native addon.
RUN apk add --no-cache python3 make gcc g++ musl-dev

COPY api/package*.json ./
RUN npm ci

COPY api/tsconfig.json ./
COPY api/src ./src
RUN npx tsc

# ── Test stage: keeps dev dependencies and sources (never shipped) ───────────
#
# This stage is also the SwiftProof sandbox image (`sandbox.image` in
# .swiftproof.json): the review runs its checks in the very image the pipeline
# tests in, rather than in a separate container built on the side. Two things
# are needed for that, both below — the binary, and dependencies reachable from
# the sandbox workspace.
FROM build AS test
# Integration fixtures create real repositories and exercise commits/pushes.
RUN apk add --no-cache git

# SwiftProof, pinned by version and checksum. The release ships a statically
# linked Go binary, so it runs on musl as-is. The sandbox has no network and
# never installs anything at review time (`docker run --pull=never`, `--network
# none`), which is exactly why this is baked in here.
ARG TARGETARCH
ARG SWIFTPROOF_VERSION=v0.2.0
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha=fce4fdf345bf36ead40b8b6c232b4dcd3c40106a186ed350434755d20a0ef6d1 ;; \
      arm64) sha=ba2302e778ce157dfb5497b2e73f722a5cde91b14ff68237337a90fbe388e3d1 ;; \
      *) echo "SwiftProof publishes linux amd64/arm64 only, not $arch" >&2; exit 1 ;; \
    esac; \
    dir="swiftproof-${SWIFTPROOF_VERSION}-linux-${arch}"; \
    wget -qO /tmp/swiftproof.tar.gz \
      "https://github.com/gvinsot/SwiftProof/releases/download/${SWIFTPROOF_VERSION}/${dir}.tar.gz"; \
    echo "$sha  /tmp/swiftproof.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/swiftproof.tar.gz -C /tmp; \
    install -m 0755 "/tmp/${dir}/swiftproof" /usr/local/bin/swiftproof; \
    rm -rf /tmp/swiftproof.tar.gz "/tmp/${dir}"; \
    swiftproof version

# The sandbox copies a snapshot of the TRACKED files into a tmpfs /workspace and
# runs the checks from there as uid 65534 with a read-only rootfs — so
# `api/node_modules` is never in that snapshot (it is git-ignored) and no
# install can rescue it without a network. Node, tsc and `npm run` all walk the
# ancestors of /workspace/api looking for node_modules and a .bin, and / is the
# last ancestor: this symlink is what makes the image's own dependencies the
# ones the checks resolve. Without it every check dies on `tsc: not found`.
RUN ln -s /app/node_modules /node_modules

CMD ["npm", "test"]

# ── Prune stage: strip dev dependencies from node_modules ───────────────────
FROM build AS prod-deps
RUN npm prune --omit=dev

# ── Production stage ────────────────────────────────────────────────────────
FROM node:24-alpine AS production

# git + openssh-client: the entrypoint records a git identity and the code-index
# service reads git-provided remotes. ca-certificates/curl/wget: outbound TLS to
# LLM and OAuth providers, plus the compose healthcheck. Nothing else.
RUN apk add --no-cache git openssh-client ca-certificates curl wget

# Unprivileged runtime user. A fixed high UID/GID keeps file ownership stable
# across rebuilds and does not collide with host users.
RUN addgroup -g 10001 -S pulsar \
    && adduser -u 10001 -S -G pulsar -h /home/pulsar -s /bin/sh pulsar

WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/home/pulsar

# ZVEC native binary requires glibc but Alpine uses musl — always use the
# in-memory vector store.
ENV CODE_SEARCH_VECTOR_BACKEND=memory

# Git identity is configured at runtime by the entrypoint.
ENV GIT_USER_NAME=""
ENV GIT_USER_EMAIL=""

COPY --from=prod-deps --chown=pulsar:pulsar /app/node_modules ./node_modules
COPY --from=build --chown=pulsar:pulsar /app/dist ./dist
COPY --from=build --chown=pulsar:pulsar /app/package.json ./package.json
COPY api/entrypoint.sh /entrypoint.sh

# GitHub's SSH host keys, in the runtime user's home (not /root, which the
# unprivileged user cannot read). The entrypoint is read+execute only — a
# compromised process running as `pulsar` must not be able to rewrite it.
RUN chmod 0555 /entrypoint.sh \
    && mkdir -p /home/pulsar/.ssh \
    && ssh-keyscan github.com > /home/pulsar/.ssh/known_hosts 2>/dev/null \
    && chmod 700 /home/pulsar/.ssh \
    && chmod 600 /home/pulsar/.ssh/known_hosts \
    && chown -R pulsar:pulsar /home/pulsar

USER pulsar

EXPOSE 3001

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
