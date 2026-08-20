#!/bin/bash
# Automated data-collection run for the macOS 26 window-collapse bug.
#
# Usage:
#   ./run.sh "Reflect-Probe.app.zip"   # or the unzipped "Reflect Probe.app"
#   ./run.sh --collect-only            # just zip logs from an earlier run
#
# What it does: unpacks/prepares the probe app, seeds a scenario plan, then
# launches the app, which relaunches itself through every scenario exactly
# like the auto-updater does. During the three "wait-user" phases this
# script drives REAL macOS window tiling through the app's Window menu via
# System Events (grant the Automation permission when macOS asks). At the
# end everything is zipped to the Desktop; send that zip back.
#
# The run takes about five minutes and flashes windows the whole time; do
# not use the machine for anything else while it runs.

set -u

CONFIG_DIR="$HOME/Library/Application Support/app.reflect.desktop.probe"
PROBE_DIR="$CONFIG_DIR/window-probe"
STATE_FILE="$CONFIG_DIR/.window-state.json"
OUT_ZIP="$HOME/Desktop/reflect-window-probe-$(date +%Y%m%d-%H%M%S).zip"
PROCESS_NAME="Reflect Probe"
DRIVER_LOG="$PROBE_DIR/driver.log"

log() {
  echo "[probe] $*"
  echo "$(date '+%H:%M:%S') $*" >>"$DRIVER_LOG" 2>/dev/null
}

collect() {
  log "collecting results into $OUT_ZIP"
  local staging
  staging=$(mktemp -d)
  mkdir -p "$staging/collected"
  cp -R "$PROBE_DIR" "$staging/collected/window-probe" 2>/dev/null
  cp "$STATE_FILE" "$staging/collected/window-state.final.json" 2>/dev/null
  sw_vers >"$staging/collected/sw_vers.txt" 2>&1
  system_profiler SPDisplaysDataType >"$staging/collected/displays.txt" 2>&1
  defaults read com.apple.WindowManager >"$staging/collected/windowmanager-defaults.txt" 2>&1
  uname -a >"$staging/collected/uname.txt" 2>&1
  if [ -n "${APP_PATH:-}" ]; then
    codesign -dvv "$APP_PATH" >"$staging/collected/codesign.txt" 2>&1
  fi
  (cd "$staging" && zip -qr "$OUT_ZIP" collected)
  rm -rf "$staging"
  log "DONE. Please send back: $OUT_ZIP"
}

if [ "${1:-}" = "--collect-only" ]; then
  APP_PATH=""
  collect
  exit 0
fi

APP_INPUT="${1:-Reflect-Probe.app.zip}"
if [[ "$APP_INPUT" == *.zip ]]; then
  UNPACK_DIR=$(mktemp -d)
  ditto -x -k "$APP_INPUT" "$UNPACK_DIR" || { echo "cannot unzip $APP_INPUT"; exit 1; }
  APP_PATH="$UNPACK_DIR/Reflect Probe.app"
else
  APP_PATH="$APP_INPUT"
fi
[ -d "$APP_PATH" ] || { echo "app not found at $APP_PATH"; exit 1; }

mkdir -p "$PROBE_DIR"
log "using app: $APP_PATH"

# Fresh probe state: keep nothing from earlier runs so every log line in the
# zip belongs to this run.
osascript -e "tell application \"$PROCESS_NAME\" to quit" >/dev/null 2>&1
sleep 1
rm -rf "$PROBE_DIR"
rm -f "$STATE_FILE"
mkdir -p "$PROBE_DIR"

# The artifact is unsigned: clear quarantine and re-seal ad-hoc so
# Gatekeeper lets it launch.
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null
codesign --force --deep -s - "$APP_PATH" 2>/dev/null

# The scenario chain. Every line is one app launch; the app relaunches
# itself between lines through the same code path the auto-updater uses.
# "wait-user" pauses for this script, which performs real tiling actions.
cat >"$PROBE_DIR/plan.txt" <<'PLAN'
plain
plain
zoom
zoom            # relaunch restores maximized:true onto a hidden window
unzoom
zoom
unzoom-race
zoom-race
hidden
minimized
fullscreen
fullscreen-exit-race
plain
wait-user       # driver tiles the window LEFT, then the app exits tiled
plain
wait-user       # driver FILLS the window, then the app exits filled
plain
wait-user       # driver un-tiles (Return to Previous Size), racing the exit
plain
plain
done
PLAN
echo 0 >"$PROBE_DIR/progress.txt"

# One tiling attempt: try each candidate menu item under the app's Window
# menu until one clicks. macOS injects the tiling items into every app's
# Window menu, but their names vary across macOS 26 point releases, so we
# probe a list. Requires the Automation permission (System Events).
tile_action() {
  local label="$1"; shift
  for item in "$@"; do
    result=$(osascript 2>>"$DRIVER_LOG" <<EOF
tell application "System Events"
  tell process "$PROCESS_NAME"
    set frontmost to true
    delay 0.4
    try
      click menu item "$item" of menu 1 of menu item "Move & Resize" of menu "Window" of menu bar 1
      return "ok submenu: $item"
    end try
    try
      click menu item "$item" of menu "Window" of menu bar 1
      return "ok direct: $item"
    end try
    return "miss: $item"
  end tell
end tell
EOF
    )
    log "tile[$label] $result"
    case "$result" in ok*) return 0 ;; esac
  done
  log "tile[$label] all candidates failed (Automation permission missing, or menu names differ; dump the Window menu with probe-menu.sh if present)"
  return 1
}

# Phase K of wait-user: perform the K-th tiling choreography.
run_tile_phase() {
  case "$1" in
    1) tile_action "left" "Left" "Left Half" ;;
    2) tile_action "fill" "Fill" "Fill Screen" ;;
    3) tile_action "revert" "Return to Previous Size" "Revert" "Restore" ;;
  esac
  sleep 2
}

log "launching probe app; the window will open and close repeatedly"
open -n "$APP_PATH" || { echo "failed to launch"; exit 1; }

PHASE_COUNT=0
DEADLINE=$(( $(date +%s) + 900 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$PROBE_DIR/done" ]; then
    log "plan complete"
    break
  fi
  if [ -f "$PROBE_DIR/phase" ]; then
    PHASE_COUNT=$((PHASE_COUNT + 1))
    log "wait-user phase $PHASE_COUNT: driving window tiling"
    run_tile_phase "$PHASE_COUNT"
    touch "$PROBE_DIR/continue"
    # Wait for the app to consume the signal before polling again.
    for _ in $(seq 1 40); do
      [ -f "$PROBE_DIR/phase" ] || break
      sleep 0.5
    done
  fi
  sleep 1
done
[ -f "$PROBE_DIR/done" ] || log "WARNING: timed out before the plan finished; collecting what exists"

sleep 2
osascript -e "tell application \"$PROCESS_NAME\" to quit" >/dev/null 2>&1
sleep 1
collect
