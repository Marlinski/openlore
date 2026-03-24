# ─── Studio: Go server with embedded Preact frontend ─────────────
# Build context: repo root (so shared/ is accessible)
#
#   docker build -f studio/Dockerfile -t openlore-studio .
#   docker run -p 4000:4000 -v ./data/studio:/data openlore-studio

# ── Stage 1: Build JS frontend ───────────────────────────────────

FROM node:22-alpine AS js-build

WORKDIR /src

# Copy workspace root files + all workspace package.json files for install
COPY package.json yarn.lock ./
COPY shared/pack/js/package.json shared/pack/js/
COPY studio/app/package.json studio/app/

# Stub game/client so yarn workspaces doesn't fail
RUN mkdir -p game/client && echo '{"name":"@openlore/client","version":"0.0.0","private":true}' > game/client/package.json

RUN yarn install --frozen-lockfile

# Copy source and build
COPY shared/pack/js/ shared/pack/js/
COPY studio/app/ studio/app/
COPY tsconfig.base.json ./

RUN yarn workspace @openlore/pack build
RUN yarn workspace @openlore/studio build

# ── Stage 2: Build Go server ─────────────────────────────────────

FROM golang:1.25-alpine AS go-build

WORKDIR /src

# Copy Go modules first for layer caching
COPY shared/pack/go/go.mod shared/pack/go/go.sum shared/pack/go/
COPY studio/server/go.mod studio/server/go.sum studio/server/

WORKDIR /src/studio/server
RUN go mod download

# Copy source
WORKDIR /src
COPY shared/pack/go/ shared/pack/go/
COPY studio/server/ studio/server/

# Embed the built frontend into the Go binary
COPY --from=js-build /src/studio/app/dist/ studio/server/cmd/studio/dist/

WORKDIR /src/studio/server
RUN CGO_ENABLED=0 go build -o /studio ./cmd/studio

# ── Stage 3: Runtime ──────────────────────────────────────────────

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=go-build /studio /usr/local/bin/studio

ENV STUDIO_DIR=/data

EXPOSE 4000

ENTRYPOINT ["studio", "serve", "--studio-dir", "/data", "--port", "4000"]
