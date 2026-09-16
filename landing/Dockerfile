# ─── Landing: static page for openlore.xyz ────────────────────────
# Build context: repo root (so shared/ and game/client/ are accessible)
#
#   docker build -f landing/Dockerfile -t openlore-landing .
#   docker run -p 8080:80 openlore-landing
#
# The hero runs the real game client renderer, so this needs a JS build:
# landing/demo/ imports RoomScene and Avatar straight out of
# game/client/src/scene/ and bundles them with PixiJS into demo.js.

# ── Stage 1: Build the hero demo bundle ──────────────────────────

FROM node:22-alpine AS js-build

WORKDIR /src

COPY package.json yarn.lock tsconfig.base.json ./
COPY shared/pack/js/ shared/pack/js/
COPY game/client/ game/client/
COPY studio/app/package.json studio/app/package.json
COPY landing/demo/ landing/demo/

RUN yarn install

RUN yarn workspace @openlore/pack build
# Outputs /src/landing/demo.js (vite outDir is landing/).
RUN yarn workspace @openlore/landing-demo build

# ── Stage 2: Runtime ─────────────────────────────────────────────

FROM nginx:1.27-alpine

COPY landing/nginx.conf /etc/nginx/conf.d/default.conf

COPY landing/index.html   /usr/share/nginx/html/index.html
COPY landing/favicon.svg  /usr/share/nginx/html/favicon.svg
COPY landing/studio.png   /usr/share/nginx/html/studio.png
COPY landing/og.png       /usr/share/nginx/html/og.png
COPY landing/pack/        /usr/share/nginx/html/pack/

COPY --from=js-build /src/landing/demo.js /usr/share/nginx/html/demo.js

EXPOSE 80
