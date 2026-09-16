# ─── Studio Embedder: Rust CLIP embedding server ──────────────────
# Build context: studio/embedder/
#
#   docker build -f studio/embedder/Dockerfile studio/embedder/ -t openlore-clip-embedder
#   docker run -p 7997:7997 openlore-clip-embedder

# ── Stage 1: Build Rust binary ────────────────────────────────────

FROM rust:1.88-alpine AS build

# musl-dev: C toolchain; g++: esaxx-rs (via tokenizers) builds C++ sources and
# cc-rs aborts with ToolNotFound without it; openssl-dev + openssl-libs-static:
# the musl target links OpenSSL statically, so the .a files must be present or
# ld fails with "cannot find -lssl"; oniguruma-dev: tokenizers onig feature
RUN apk add --no-cache musl-dev g++ openssl-dev openssl-libs-static pkgconfig oniguruma-dev

WORKDIR /src

COPY Cargo.toml Cargo.lock* ./
COPY src/ src/

RUN cargo build --release

# ── Stage 2: Runtime ──────────────────────────────────────────────

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=build /src/target/release/clip-embedder /usr/local/bin/clip-embedder

EXPOSE 7997

ENTRYPOINT ["clip-embedder"]
