# Baut den Server samt eingebetteter Web-App:
#   docker build --build-context app=../antatime-app -t antatime-server .
# (docker compose setzt den Kontext `app` automatisch.)

ARG FLUTTER_VERSION=3.47.9

# --- Web-App: Flutter-Web-Build der App -------------------------------------
FROM debian:trixie-slim AS web
ARG FLUTTER_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl unzip xz-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${FLUTTER_VERSION} https://github.com/flutter/flutter.git /opt/flutter
ENV PATH=/opt/flutter/bin:$PATH
RUN flutter config --no-analytics --no-cli-animations && flutter precache --web
WORKDIR /app
COPY --from=app pubspec.yaml pubspec.lock analysis_options.yaml ./
RUN flutter pub get
COPY --from=app lib ./lib
COPY --from=app web ./web
RUN flutter build web --release

# --- Server: bündelt alles in eine Datei --------------------------------------
FROM node:26-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json build.mjs ./
COPY src ./src
COPY --from=web /app/build/web /web-build
RUN WEB_BUILD=/web-build npm run build

# --- Laufzeit: nur Node und das Bundle, keine node_modules --------------------
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /src/dist/antatime-server.cjs ./antatime-server.cjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "antatime-server.cjs"]
