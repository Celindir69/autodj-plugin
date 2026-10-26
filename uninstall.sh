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

# Debug log and runtime state go; only the repeat guard (artist and track
# history) stays in /data/volumio_autodj_data for a reinstall - delete that
# folder by hand to remove everything. jq is left installed since other
# plugins/tools may use it.
D="${AUTODJ_STATE_DIR:-/data/volumio_autodj_data}"   # AUTODJ_STATE_DIR: tests only
if [ -d "$D" ]; then
  rm -f "$D/autodj.debug.log" "$D/autodj.debug.log.1" "$D/replaygain_state.txt" "$D/crossfade_state.txt" \
        "$D/last_position.txt" "$D/mixed_boundary.txt" "$D/watch_last_position.txt" "$D"/*.tmp
fi

#requred to end the plugin uninstall
echo "pluginuninstallend"
