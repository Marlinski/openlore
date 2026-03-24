# ─── Game: Go server with embedded Preact frontend ────────────────
# Build context: repo root (so shared/ is accessible)
#
#   docker build -f game/Dockerfile -t openlore-game .
#   docker run -p 3001:3001 -v ./data/game:/data openlore-game

# ── Stage 1: Build JS frontend ───────────────────────────────────

FROM node:22-alpine AS js-build

WORKDIR /src

COPY package.json yarn.lock ./
COPY shared/pack/js/ shared/pack/js/
COPY game/client/ game/client/
COPY studio/app/package.json studio/app/package.json
COPY tsconfig.base.json ./

RUN yarn install

RUN yarn workspace @openlore/pack build
RUN yarn workspace @openlore/client build

# ── Stage 2: Build Go server ─────────────────────────────────────

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

# Embed the built frontend into the Go binary
COPY --from=js-build /src/game/client/dist/ game/server/cmd/game/dist/

WORKDIR /src/game/server
RUN CGO_ENABLED=0 go build -o /game-server ./cmd/game

# ── Stage 3: Runtime ──────────────────────────────────────────────

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=go-build /game-server /usr/local/bin/game-server

ENV GAME_DATA_DIR=/data
ENV GAME_PORT=3001

EXPOSE 3001

ENTRYPOINT ["game-server"]
