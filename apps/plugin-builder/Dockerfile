FROM node:22-bookworm-slim
WORKDIR /opt/weft-builder
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs patch.mjs ./
USER node
EXPOSE 8080
ENTRYPOINT ["node", "server.mjs"]
