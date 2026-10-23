# The container-shell backend of a Weft workspace: Computer's computerd daemon
# in a Debian userland with the tools Agents expect from a real Linux shell.
# computerd mounts the workspace volume at /workspace over FUSE and serves the
# Durable Object's sync and exec sessions; its version must match the
# @cloudflare/computer package (scripts/workspace-container.mjs checks it).
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.7.0 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git ripgrep python3 python3-pip python3-venv jq unzip procps bubblewrap tini make g++ \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
WORKDIR /opt/weft
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apt-get purge -y make g++ && apt-get autoremove -y && npm cache clean --force
COPY .generated/processd.mjs ./processd.mjs
COPY .generated/runner.mjs ./runner.mjs
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080 8081

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/weft/entrypoint.sh"]
