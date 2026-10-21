# Flix — one container: the app, qBittorrent-nox (BTN only allows whitelisted
# clients, and Flix talks to it at 127.0.0.1:8080) and ffmpeg for the
# remux/transcode HLS pipeline. All three share this filesystem, so the
# download path qBittorrent writes is the path Flix streams from.
FROM node:24-alpine

# ffmpeg/ffprobe: probe and remux/transcode to HLS.
# qbittorrent-nox: the torrent engine.
# tini: reap qBittorrent's children; node stays PID 1's exec.
# intel-media-driver (amd64 only): the iHD VAAPI driver, so ffmpeg can reach Quick Sync when the container
# is given /dev/dri. Alpine has no oneVPL GPU runtime, so on Gen12 parts (the N95) h264_vaapi is the one
# expected to open, not h264_qsv -- the same encoder block either way. Without /dev/dri nothing changes:
# encode.ts probes and uses x264.
RUN apk add --no-cache ffmpeg qbittorrent-nox tini \
 && if [ "$(apk --print-arch)" = x86_64 ]; then apk add --no-cache intel-media-driver; fi

WORKDIR /app

# Dependencies first so code changes rebuild fast. tsx is a devDependency but
# npm start runs the TypeScript through it, so install everything.
COPY package.json package-lock.json ./
# npm writes the install time into every file it creates, so this layer's bytes
# differed on every build even when package-lock.json had not changed. Docker
# could not reuse it, and every release re-downloaded the whole ~95 MB layer --
# which is a quarter of an hour on a slow link to ghcr. The contents are already
# reproducible (checked: two installs, identical file hashes); only the
# timestamps are not, so pinning them to one fixed date makes the layer
# byte-identical between builds and lets later releases pull just the source.
RUN npm ci && find /app/node_modules -exec touch -h -d @1735689600 {} +

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
