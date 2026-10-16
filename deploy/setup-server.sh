#!/usr/bin/env bash
# one-time setup of a view-only encore library on a small linux vps (ubuntu/debian or amazon linux).
# run on the server from the copied encore folder:  sudo bash deploy/setup-server.sh <domain> <publish-token>
# serves https://<domain> through caddy; encore itself listens on 127.0.0.1:8765 only.
set -euo pipefail

DOMAIN="${1:?pakai: sudo bash deploy/setup-server.sh <domain> <publish-token>}"
TOKEN="${2:?token publish wajib diisi}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"
CADDY_VERSION=2.8.4

echo "== paket sistem"
if command -v apt-get >/dev/null; then
  apt-get update -q && apt-get install -yq curl libsndfile1 ffmpeg
else
  dnf install -yq curl libsndfile || true  # amazon linux has no ffmpeg; only needed for old results
fi

echo "== uv + python (sebagai $APP_USER)"
sudo -u "$APP_USER" bash -lc 'command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'
UV="$(sudo -u "$APP_USER" bash -lc 'echo $HOME')/.local/bin/uv"
cd "$APP_DIR"
if [ ! -x .venv/bin/uvicorn ]; then
  sudo -u "$APP_USER" "$UV" venv --python 3.14 .venv
  sudo -u "$APP_USER" "$UV" pip install --python .venv/bin/python -r requirements-server.txt
fi

echo "== service encore"
cat > /etc/systemd/system/encore.service <<EOF
[Unit]
Description=Encore library (view-only)
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=ENCORE_MODE=server
Environment=ENCORE_ANALYSIS=off
Environment=ENCORE_PUBLISH_TOKEN=$TOKEN
ExecStart=$APP_DIR/.venv/bin/uvicorn --app-dir $APP_DIR/backend app:app --host 127.0.0.1 --port 8765 --log-level warning
Restart=always
MemoryMax=400M

[Install]
WantedBy=multi-user.target
EOF
chmod 600 /etc/systemd/system/encore.service  # holds the token

echo "== caddy (https otomatis)"
if ! command -v caddy >/dev/null; then
  arch=$(uname -m); case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$arch.tar.gz" \
    | tar -xz -C /usr/local/bin caddy
  id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
fi
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	request_body /api/publish/* {
		max_size 300MB
	}
	reverse_proxy 127.0.0.1:8765
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now encore caddy
systemctl restart encore caddy
sleep 3
curl -fsS http://127.0.0.1:8765/api/health && echo
echo "== selesai: https://$DOMAIN  (pastikan port 80 dan 443 terbuka di firewall / security group)"
