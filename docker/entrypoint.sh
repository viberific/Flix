#!/bin/sh
# Flix entrypoint: qBittorrent-nox on 127.0.0.1:8080, then the app.
# Config comes from /data/.env (KEY=value lines, survives app updates),
# falling back to the image defaults.

set -e

mkdir -p /data/qbittorrent/qBittorrent/config /downloads

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

# qBittorrent's Web UI: bound to localhost inside the container (never
# published), auth on, and the password re-seeded from QB_PASS on every boot —
# the .env is the single source of truth, so a forgotten password is fixed by
# editing the file and restarting the app. Flix logs in with QB_USER/QB_PASS.
QB_CONF=/data/qbittorrent/qBittorrent/config/qBittorrent.conf
HASH=$(node -e '
const crypto = require("node:crypto")
const salt = crypto.randomBytes(16)
const hash = crypto.pbkdf2Sync(process.argv[1] ?? "", salt, 100000, 64, "sha512")
process.stdout.write(salt.toString("base64") + ":" + hash.toString("base64"))
' "$QB_PASS")

if [ ! -f "$QB_CONF" ]; then
  cat > "$QB_CONF" <<EOF
[AutoRun]
enabled=false

[BitTorrent]
Session\\DefaultSavePath=/downloads
Session\\Port=6881
Session\\TempPathEnabled=false

[LegalNotice]
Accepted=true

[Network]
PortRange=6881-6889

[Preferences]
WebUI\\Address=*
WebUI\\Port=${QB_PORT}
WebUI\\Username=${QB_USER}
WebUI\\Password_PBKDF2="@ByteArray(${HASH})"
WebUI\\LocalHostAuth=true
WebUI\\HostHeaderValidation=false
WebUI\\CSRFProtection=true
WebUI\\BanDuration=0
EOF
else
  # Keep the user's other settings, but re-apply username and password from
  # the .env every boot.
  sed -i \
    -e "s|^WebUI\\\\Username=.*|WebUI\\\\Username=${QB_USER}|" \
    -e "s|^WebUI\\\\Password_PBKDF2=.*|WebUI\\\\Password_PBKDF2=\"@ByteArray(${HASH})\"|" \
    -e "s|^WebUI\\\\Port=.*|WebUI\\\\Port=${QB_PORT}|" \
    "$QB_CONF"
fi

# qBittorrent-nox in the background.
qbittorrent-nox \
  --profile=/data/qbittorrent \
  --configuration=qBittorrent \
  --webui-port="${QB_PORT}" \
  >/proc/1/fd/1 2>&1 &

# Wait for the Web UI before starting Flix.
i=0
while [ $i -lt 30 ]; do
  if nc -z 127.0.0.1 "${QB_PORT}" 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 1
done

exec node --import tsx src/server.ts
