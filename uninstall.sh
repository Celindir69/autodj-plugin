#!/bin/bash

echo "Removing AutoDJ Continuous Play plugin"

# The boundary watcher service of install.sh (only our own, marked unit).
UNIT=/etc/systemd/system/volumio-autodj-watch.service
if grep -qs "^# AutoDJ plugin" "$UNIT"; then
  systemctl stop volumio-autodj-watch 2>/dev/null
  rm -f "$UNIT"
  systemctl daemon-reload 2>/dev/null
fi
rm -rf /tmp/volumio_autodj

# Nothing else beyond the plugin's own directory (removed by Volumio itself)
# to clean up - jq is left installed since other plugins/tools may use it, and
# /data/volumio_autodj_data (repeat-guard history, debug log) is left in
# place in case the plugin is reinstalled.

#requred to end the plugin uninstall
echo "pluginuninstallend"
