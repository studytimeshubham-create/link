#!/usr/bin/env bash
# Run as root on Amazon Linux 2023 (AWS Hong Kong, ap-east-1), from the unzipped project folder:
#   sudo bash deploy/setup-ec2.sh chat.example.com ~/serviceAccount.json
# Before running: point your domain's DNS A record at the instance's Elastic IP,
# and open ports 80 and 443 in the security group.
set -euo pipefail
DOMAIN="${1:?Usage: setup-ec2.sh <domain> <serviceAccount.json>}"
KEY="${2:?Usage: setup-ec2.sh <domain> <serviceAccount.json>}"
APP=/opt/secure-chat
SRC="$(cd "$(dirname "$0")/.." && pwd)"

# Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# App files and dependencies
id chat &>/dev/null || useradd --system --home "$APP" --shell /sbin/nologin chat
mkdir -p "$APP" && cp -a "$SRC/." "$APP/"
(cd "$APP" && npm install --omit=dev)
chown -R chat:chat "$APP"

# Secrets (never inside the app folder)
install -d -m 750 -o root -g chat /etc/secure-chat
install -m 640 -o root -g chat "$KEY" /etc/secure-chat/serviceAccount.json
if [ ! -f /etc/secure-chat/env ]; then
cat > /etc/secure-chat/env <<EOF
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
JWT_SECRET=$(openssl rand -hex 32)
GOOGLE_APPLICATION_CREDENTIALS=/etc/secure-chat/serviceAccount.json
ALLOWED_ORIGIN=https://$DOMAIN
EOF
chown root:chat /etc/secure-chat/env && chmod 640 /etc/secure-chat/env
fi

cat > /etc/systemd/system/secure-chat.service <<'EOF'
[Unit]
Description=Secure Chat gateway
After=network.target

[Service]
User=chat
WorkingDirectory=/opt/secure-chat
EnvironmentFile=/etc/secure-chat/env
ExecStart=/usr/bin/node server.js
Restart=always
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# Caddy: automatic HTTPS certificates + WebSocket proxying
ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && A=arm64 || A=amd64
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$A" -o /usr/local/bin/caddy
chmod +x /usr/local/bin/caddy
id caddy &>/dev/null || useradd --system --home /var/lib/caddy --shell /sbin/nologin caddy
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy web server
After=network.target

[Service]
User=caddy
StateDirectory=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now secure-chat caddy
sleep 3
curl -fs http://127.0.0.1:3000/health && echo " <- app is running"
echo "Open https://$DOMAIN (the certificate can take a minute once DNS points here)"
