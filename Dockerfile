FROM node:20-alpine AS build
WORKDIR /app
# better-sqlite3 ships no musl prebuild; node-gyp compiles it here.
RUN apk add --no-cache python3 make g++ build-base
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY contract ./contract
COPY scripts ./scripts
RUN npm run build
# Prune to production deps in the SAME stage, so the rebuilt native binding
# is compiled by this toolchain rather than needing one at runtime.
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ARG GIT_SHA=unknown
RUN echo "$GIT_SHA" > /app/.git-sha
EXPOSE 3010
CMD ["node", "dist/src/index.js"]
