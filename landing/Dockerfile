# ─── Landing: static marketing page for openlore.xyz ──────────────
# Build context: repo root (consistent with the other Dockerfiles)
#
#   docker build -f landing/Dockerfile -t openlore-landing .
#   docker run -p 8080:80 openlore-landing
#
# No build step — the page is a single self-contained HTML file with
# its own inline CSS and canvas renderer. Only the fonts are remote.

FROM nginx:1.27-alpine

COPY landing/nginx.conf /etc/nginx/conf.d/default.conf

COPY landing/index.html   /usr/share/nginx/html/index.html
COPY landing/favicon.svg  /usr/share/nginx/html/favicon.svg
COPY landing/studio.png   /usr/share/nginx/html/studio.png
COPY landing/og.png       /usr/share/nginx/html/og.png

EXPOSE 80
