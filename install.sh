#!/bin/bash

echo "Installing AutoDJ Continuous Play plugin dependencies"

SCRIPTPATH="$(cd "$(dirname "$0")" && pwd -P)"
cd "$SCRIPTPATH" || exit 1
UNIT=/etc/systemd/system/volumio-autodj-watch.service
MARK="# AutoDJ plugin"

# A failed installation leaves nothing behind (no half-installed plugin in
# Volumio's list).
fail() {
  echo "AutoDJ installation failed: $1"
  grep -qs "^$MARK" "$UNIT" && rm -f "$UNIT" && systemctl daemon-reload
  case "$SCRIPTPATH" in /data/plugins/*) rm -rf "$SCRIPTPATH" ;; esac
  echo "plugininstallend"
  exit 1
}

# jq is required by the bundled volumio-autodj-local.sh but, unlike mpc/curl,
# is not part of Volumio's base image.
if ! command -v jq >/dev/null 2>&1; then
  apt-get update
  apt-get install -y jq --no-install-recommends || fail "apt-get install jq"
fi

if [ ! -d node_modules/kew ] || [ ! -d node_modules/v-conf ] || [ ! -d node_modules/fs-extra ]; then
  npm install --production --no-audit --no-fund || fail "npm install"
fi

chmod +x "$SCRIPTPATH/volumio-autodj-local.sh"

# Boundary watcher (replay gain / crossfade at the start of an AutoDJ track)
# as a systemd service: only defined here, the plugin starts and stops it.
# Only our own (marked) unit file is written or replaced.
if [ -e "$UNIT" ] && ! grep -qs "^$MARK" "$UNIT"; then
  echo "$UNIT exists and is not from this plugin, left unchanged"
else
  echo "Writing $UNIT"
  cat > "$UNIT" <<UNITFILE || fail "writing $UNIT"
$MARK (written by install.sh, started and stopped by the plugin, removed on uninstall)
[Unit]
Description=AutoDJ boundary watcher (Volumio plugin)
After=network-online.target

[Service]
User=volumio
Group=volumio
EnvironmentFile=-/tmp/volumio_autodj/watch.env
ExecStart=/bin/bash $SCRIPTPATH/volumio-autodj-local.sh --watch-boundary
Restart=always
RestartSec=10
UNITFILE
  systemctl daemon-reload || fail "systemctl daemon-reload"
fi

echo "AutoDJ Continuous Play plugin installed"

#requred to end the plugin install
echo "plugininstallend"
