#!/bin/bash
# One-time setup of the school attendance backend on the Debian VM.
set -euo pipefail
APP=/opt/school-attendance
API_HOST_NAME=34-131-62-253.sslip.io

# Node.js 24 + Caddy (HTTPS reverse proxy for the portal API)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y caddy

id attendance >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin attendance
mkdir -p "$APP"
tar -xzf /tmp/sa-deploy.tgz -C "$APP"
cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund

if [ ! -f "$APP/backend/.env" ]; then
cat > "$APP/backend/.env" <<EOF
NODE_ENV=production
HEALTH_HOST=127.0.0.1
T800_TCP_PORT=8001
API_PORT=8081
API_HOST=127.0.0.1
API_KEY_PEPPER=$(openssl rand -hex 32)
CORS_ORIGINS=https://school-project-717c3.web.app,https://school-project-717c3.firebaseapp.com,http://localhost:5173
FIREBASE_PROJECT_ID=school-project-717c3
FIRESTORE_WRITES_ENABLED=true
T800_DEVICE_ID=T800_01
T800_CLOUD_ID=02010A964EDF2575
T800_DEVICE_NAME=Main Gate T800
T800_UTC_OFFSET=+05:30
EOF
fi
chown -R attendance:attendance "$APP"

cp "$APP/deploy/school-attendance.service" /etc/systemd/system/school-attendance.service
systemctl daemon-reload
systemctl enable school-attendance
systemctl restart school-attendance

cat > /etc/caddy/Caddyfile <<EOF
$API_HOST_NAME {
  reverse_proxy 127.0.0.1:8081
}
EOF
systemctl restart caddy

sleep 3
systemctl --no-pager --lines=8 status school-attendance | tail -8
ss -ltn | grep -E ':8001|:8081|:443'
