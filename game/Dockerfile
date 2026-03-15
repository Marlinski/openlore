# ─── Game: Go server + Preact client served by nginx ─────────────
# Build context: repo root (so shared/ is accessible)
#
#   docker build -f game/Dockerfile -t offisims-game .
#   docker run -p 3001:3001 -v ./data/game:/data offisims-game

# ── Stage 1: Build Go server ──────────────────────────────────────

FROM golang:1.24-alpine AS go-build

WORKDIR /src

# Copy Go modules first for layer caching
COPY shared/pack/go/go.mod shared/pack/go/go.sum shared/pack/go/
COPY game/server/go.mod game/server/go.sum game/server/

WORKDIR /src/game/server
RUN go mod download

# Copy source
WORKDIR /src
COPY shared/pack/go/ shared/pack/go/
COPY game/server/ game/server/

WORKDIR /src/game/server
RUN CGO_ENABLED=0 go build -o /game-server ./cmd/game

# ── Stage 2: Build JS client ─────────────────────────────────────

FROM node:22-alpine AS js-build

WORKDIR /src

# Copy workspace root files + all workspace package.json files for install
COPY package.json yarn.lock ./
COPY shared/pack/js/package.json shared/pack/js/
COPY game/client/package.json game/client/

# Stub studio/app so yarn workspaces doesn't fail
RUN mkdir -p studio/app && echo '{"name":"@offisims/studio","version":"0.0.0","private":true}' > studio/app/package.json

RUN yarn install --frozen-lockfile

# Copy source and build
COPY shared/pack/js/ shared/pack/js/
COPY game/client/ game/client/
COPY tsconfig.base.json ./

RUN yarn workspace @offisims/pack build
RUN yarn workspace @offisims/client build

# ── Stage 3: Runtime ──────────────────────────────────────────────

FROM nginx:alpine

# Install gettext for envsubst in entrypoint
RUN apk add --no-cache gettext

# Copy game server binary
COPY --from=go-build /game-server /usr/local/bin/game-server

# Copy built client
COPY --from=js-build /src/game/client/dist /usr/share/nginx/html

# Nginx config template — GAME_PORT is substituted at runtime
COPY game/nginx.conf.template /etc/nginx/templates/default.conf.template

# Entrypoint: start game server in background, nginx in foreground
COPY game/docker-entrypoint.sh /docker-entrypoint-game.sh
RUN chmod +x /docker-entrypoint-game.sh

ENV GAME_DATA_DIR=/data
ENV GAME_PORT=3001

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint-game.sh"]
