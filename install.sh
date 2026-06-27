#!/bin/bash

# Ensure running as root
if [ "$EUID" -ne 0 ]; then 
  echo "Please run as root (sudo ./install.sh)"
  exit 1
fi

echo "======================================"
echo "    CF Tunnel Pro - Installation      "
echo "======================================"

# Install dependencies
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
fi

# Install cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "Installing Cloudflared..."
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    dpkg -i cloudflared.deb
    rm cloudflared.deb
fi

echo "Installing NPM dependencies..."
npm install

echo "Configuration"
read -p "Enter a secure password for your dashboard (leave blank to auto-generate): " PASSWORD
if [ -z "$PASSWORD" ]; then
    PASSWORD=$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)
    echo "Generated Password: $PASSWORD"
fi

cat > config.json << EOF
{
  "port": 1215,
  "password": "$PASSWORD",
  "token": ""
}
EOF

echo "Setting up systemd service..."
SERVICE_PATH="/etc/systemd/system/cftunnelpro.service"
WORK_DIR=$(pwd)
NODE_BIN=$(which node)

cat > $SERVICE_PATH << EOF
[Unit]
Description=CF Tunnel Pro Background Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$WORK_DIR
ExecStart=$NODE_BIN src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cftunnelpro
systemctl start cftunnelpro

VPS_IP=$(curl -s ifconfig.me)

echo ""
echo "======================================"
echo "  Installation Complete! 🎉"
echo "======================================"
echo "Dashboard URL: http://$VPS_IP:1215"
echo "Password: $PASSWORD"
echo ""
echo "Use 'sudo systemctl status cftunnelpro' to check the daemon."
