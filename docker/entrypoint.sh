#!/bin/sh
# Flix entrypoint: qBittorrent-nox on 127.0.0.1:8080, then the app.
# Config comes from /data/.env (KEY=value lines, survives app updates),
# falling back to the image defaults.
set -e

mkdir -p /data/qbittorrent /downloads

if [ -f /data/.env ]; then
  set -a
  . /data/.env
  set +a
fi

# Defaults the .env can override.
QB_USER="${QB_USER:-admin}"
QB_PASS="${QB_PASS:-}"
QB_PORT="${QB_PORT:-8080}"
export BTN_API_KEY TMDB_API_KEY PORT DATA_DIR DOWNLOAD_DIR QB_USER QB_PASS

QB_PROFILE=/data/qbittorrent
QB_ARGS="--profile=${QB_PROFILE} --configuration=qBittorrent"

# qBittorrent's Web UI is bound to the container's own localhost and its port
# is never published, so it is not reachable from outside the container.
#
# Two things had to be worked around here, both found in qBittorrent's own log
# (in the app data dir, <config>/data/logs/qbittorrent.log):
#
#  1. qBittorrent 5.x does not use "$QB_PROFILE/qBittorrent/config" for the
#     profile above; it reports "Using config directory:
#     /data/qbittorrent/qBittorrent_qBittorrent/config". A config written to
#     the other path is ignored, so its login stayed on the built-in
#     credentials ("WebAPI login failure ... invalid credentials"). Our
#     settings are therefore put into the file qBittorrent itself creates,
#     which is found rather than assumed, by docker/qb-config.mjs.
#
#  2. A container that stops leaves "lockfile" and "ipc-socket" behind in that
#     config directory. The next start reads them as a running instance and
#     shuts itself down a second later ("qBittorrent termination initiated"),
#     so the Web UI is never there for Flix. Nothing else can be running at
#     this point in a fresh container, so they are cleared first.
find /data/qbittorrent \( -name lockfile -o -name ipc-socket \) -exec rm -f {} \; 2>/dev/null || true

start_qb() {
  # shellcheck disable=SC2086
  qbittorrent-nox $QB_ARGS >/proc/1/fd/1 2>&1 &
  QB_PID=$!
}

stop_qb() {
  kill "$QB_PID" 2>/dev/null || true
  wait "$QB_PID" 2>/dev/null || true
}

# Wait for the Web UI to answer on 127.0.0.1:$QB_PORT. The image has no nc, so
# this is node (which the image has anyway); 30 seconds at the most.
wait_for_webui() {
  node -e '
    const net = require("node:net")
    const port = Number(process.argv[1])
    const deadline = Date.now() + 30000
    const once = () => new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port })
      s.once("connect", () => { s.destroy(); resolve(true) })
      s.once("error", () => { s.destroy(); resolve(false) })
    })
    void (async () => {
      while (Date.now() < deadline) {
        if (await once()) process.exit(0)
        await new Promise((r) => setTimeout(r, 500))
      }
      process.exit(1)
    })()
  ' "$QB_PORT"
}

find_conf() {
  find "$QB_PROFILE" -name qBittorrent.conf 2>/dev/null | head -n 1
}

start_qb

# On a fresh profile there is no config yet: qBittorrent writes one, and only
# then can our settings go into it (and it has to be restarted to read them).
QB_CONF=$(find_conf)
i=0
while [ -z "$QB_CONF" ] && [ "$i" -lt 20 ]; do
  i=$((i + 1))
  sleep 1
  QB_CONF=$(find_conf)
done

if [ -z "$QB_CONF" ]; then
  echo "entrypoint: qBittorrent wrote no config file in $QB_PROFILE; leaving its own settings alone" >&2
elif ! grep -q 'WebUI\\LocalHostAuth=false' "$QB_CONF"; then
  stop_qb
  node /qb-config.mjs "$QB_CONF" "$QB_PORT"
  start_qb
fi

if ! wait_for_webui; then
  echo "entrypoint: qBittorrent's Web UI did not answer on 127.0.0.1:${QB_PORT} within 30s" >&2
fi

exec node --import tsx src/server.ts
