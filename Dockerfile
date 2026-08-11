FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json biome.json ./
COPY src ./src
RUN pnpm build:server && pnpm prune --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCHAFFA_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/server.js"]
