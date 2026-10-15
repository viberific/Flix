# Flix — one container: the app, qBittorrent-nox (BTN only allows whitelisted
# clients, and Flix talks to it at 127.0.0.1:8080) and ffmpeg for the
# remux/transcode HLS pipeline. All three share this filesystem, so the
# download path qBittorrent writes is the path Flix streams from.
FROM node:24-alpine

# ffmpeg/ffprobe: probe and remux/transcode to HLS.
# qbittorrent-nox: the torrent engine.
# tini: reap qBittorrent's children; node stays PID 1's exec.
RUN apk add --no-cache ffmpeg qbittorrent-nox tini

WORKDIR /app

# Dependencies first so code changes rebuild fast. tsx is a devDependency but
# npm start runs the TypeScript through it, so install everything.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Defaults; /data/.env (sourced by the entrypoint) overrides any of them.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    PORT=8096

COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/qb-config.mjs /qb-config.mjs
RUN chmod +x /entrypoint.sh

# /data: the sqlite db, qBittorrent's config and the .env with the keys.
# /downloads: the media. Both persist across app updates via APP_DATA_DIR.
VOLUME /data /downloads
EXPOSE 8096

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
