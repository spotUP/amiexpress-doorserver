# The browser UI is built first, in its own stage: it needs no native
# toolchain, and keeping it separate means a UI change cannot invalidate the
# (slow) better-sqlite3 compile below.
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

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
# better-sqlite3 has no musl prebuild and is compiled from source in the
# build stage. A bad binding fails at require time, not build time, so
# prove it loads here - a broken image then fails to BUILD rather than
# failing on the host at first start.
RUN node -e "require('better-sqlite3'); console.log('[OK] native binding loads')"
COPY --from=build /app/dist ./dist
# The built site sits beside the compiled server, where app.ts looks for it.
COPY --from=web /dist/web ./dist/web
COPY package.json ./
# Prove the compiled server actually loads, the same way the native binding
# is proved above. A plain .js file that lives in src/ (lha.js) is not
# emitted by tsc and has to be copied by the build script; forgetting that
# passes every test, builds a clean image, and then crash-loops on the host
# with MODULE_NOT_FOUND. It has happened once. Now it fails the BUILD.
RUN node -e "require('./dist/src/app.js'); console.log('[OK] compiled server loads')" 
ARG GIT_SHA=unknown
RUN echo "$GIT_SHA" > /app/.git-sha
EXPOSE 3010
CMD ["node", "dist/src/index.js"]
