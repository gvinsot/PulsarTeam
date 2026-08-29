# pulsarteam-client — static SPA served by nginx.
#
# The runtime stage runs as the unprivileged `nginx` user (uid 101) rather than
# root. That forces two changes an operator has to know about:
#   * the server listens on 8080, not 80 — a non-root process cannot bind a
#     privileged port, and `no-new-privileges:true` makes the usual setcap
#     workaround a no-op. Compose maps 80:8080; Traefik targets 8080.
#   * pid file and temp dirs move under /tmp (see nginx-main.conf).
#
# Keeping this at the image level, not just in compose, means the image is still
# unprivileged when someone runs it outside this repo's compose file.

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ── Production stage ────────────────────────────────────────────────────────
FROM nginx:alpine AS production

COPY frontend/nginx-main.conf /etc/nginx/nginx.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# The `nginx` user only needs to read the site and its config; it must not be
# able to rewrite either. Temp dirs are created under /tmp on demand.
RUN chown -R root:root /usr/share/nginx/html /etc/nginx \
    && find /usr/share/nginx/html -type d -exec chmod 755 {} + \
    && find /usr/share/nginx/html -type f -exec chmod 644 {} +

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
