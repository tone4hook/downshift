FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS node-toolchain

FROM rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS bridge-builder

ENV CARGO_NET_GIT_FETCH_WITH_CLI="true"

WORKDIR /build

COPY rust/switchyard-bridge/Cargo.toml rust/switchyard-bridge/Cargo.lock ./
COPY rust/switchyard-bridge/src ./src
RUN cargo build --locked --release

FROM node-toolchain AS node-dependencies

RUN corepack enable pnpm && corepack prepare pnpm@10.18.3 --activate

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node-dependencies AS application-builder

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc --project tsconfig.build.json

FROM application-builder AS provenance-builder
COPY . /inputs
RUN node --input-type=module -e 'import { sourceContentHash } from "/build/dist/evaluation/records.js"; import { writeFile } from "node:fs/promises"; await writeFile("/build/source-content.sha256", await sourceContentHash("/inputs"));'

FROM rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS dev

COPY --from=node-toolchain /usr/local/ /usr/local/

ENV PATH="/usr/local/cargo/bin:${PATH}" \
    RUSTUP_HOME="/usr/local/rustup" \
    CARGO_HOME="/usr/local/cargo" \
    PI_OFFLINE="1" \
    CARGO_NET_GIT_FETCH_WITH_CLI="true"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git ripgrep tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm \
    && corepack prepare pnpm@10.18.3 --activate

WORKDIR /lab

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["bash"]

FROM node-dependencies AS production-dependencies

RUN pnpm prune --prod

FROM node-toolchain AS runtime-base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git ripgrep tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.18.3 \
    && npm cache clean --force \
    && groupadd --gid 10001 lab \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin lab

COPY docker/container-entrypoint.sh /usr/local/bin/container-entrypoint
COPY --from=provenance-builder /build/source-content.sha256 /app/source-content.sha256
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY licenses /licenses/upstream

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-entrypoint"]

FROM runtime-base AS agent

ENV LAB_CONTAINER_ROLE="agent" \
    LAB_PROJECT_ID="unset" \
    LAB_INVOCATION_ID="unset" \
    PI_OFFLINE="1" \
    SWITCHYARD_BRIDGE="/usr/local/bin/switchyard-bridge" \
    PATH="/app/node_modules/.bin:${PATH}"

WORKDIR /workspace

COPY --from=production-dependencies /build/node_modules /app/node_modules
COPY --from=application-builder /build/dist/artifacts /app/dist/artifacts
COPY --from=application-builder /build/dist/bridge /app/dist/bridge
COPY --from=application-builder /build/dist/config /app/dist/config
COPY --from=application-builder /build/dist/container /app/dist/container
COPY --from=application-builder /build/dist/launcher /app/dist/launcher
COPY --from=application-builder /build/dist/pi /app/dist/pi
COPY --from=application-builder /build/package.json /app/package.json
COPY --from=bridge-builder /build/target/release/switchyard-bridge /usr/local/bin/switchyard-bridge

RUN mkdir -p /pi-profile /project-state /workspace/node_modules

CMD ["node", "/app/dist/container/agent.js", "--check"]

FROM runtime-base AS evaluator

ENV LAB_CONTAINER_ROLE="evaluator"

WORKDIR /evaluation

COPY --from=production-dependencies /build/node_modules /app/node_modules
COPY --from=node-dependencies /build/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript /app/node_modules/typescript
COPY --from=application-builder /build/dist/artifacts /app/dist/artifacts
COPY --from=application-builder /build/dist/bridge /app/dist/bridge
COPY --from=application-builder /build/dist/config /app/dist/config
COPY --from=application-builder /build/dist/evaluation /app/dist/evaluation
COPY --from=application-builder /build/dist/pi /app/dist/pi
COPY --from=application-builder /build/package.json /app/package.json
COPY tasks /evaluation/tasks
COPY fixtures/public /evaluation/fixtures/public
COPY evaluator /evaluation/evaluator

CMD ["node", "/app/dist/evaluation/cli.js", "ready"]

FROM runtime-base AS mock

ENV LAB_CONTAINER_ROLE="mock" \
    MOCK_PORT="8080"

WORKDIR /mock

COPY --from=application-builder /build/dist/mock/server.js /mock/server.js

USER 10001:10001

CMD ["node", "/mock/server.js"]
