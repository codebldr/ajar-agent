#!/bin/sh
# Puts the Ajar agent somewhere permanent and keeps it running.
#
# Written in POSIX sh rather than bash, because the machines this is for are the ones already
# switched on in the house — a Raspberry Pi, a NAS, an old laptop — and several of them ship
# with something that is not bash. Nothing here needs more than sh gives.
#
# What it does, in order: check for Node, copy the agent somewhere it will survive a reboot,
# ask the questions the agent needs answered, and install a service so it comes back by itself.
#
# Either of these works:
#
#   sh install.sh            from a copy of this directory
#   curl -fsSL https://raw.githubusercontent.com/codebldr/ajar-agent/main/install.sh | sh
#                            from nothing at all
#
# It touches nothing outside the install directory, the configuration directory, and one
# service file.

set -eu

NODE_MINIMUM=18
SERVICE_NAME=ajar-agent

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── Where things go ────────────────────────────────────────────────────────
#
# Root installs to /opt because that is where software that is not the system's own belongs.
# Anybody else installs under their own home, which needs no permission and is no less durable.

if [ "$(id -u)" = 0 ]; then
  INSTALL_DIR=${AJAR_INSTALL_DIR:-/opt/ajar}
  RUN_AS=${SUDO_USER:-root}
else
  INSTALL_DIR=${AJAR_INSTALL_DIR:-$HOME/.local/share/ajar}
  RUN_AS=$(id -un)
fi

SOURCE_URL=${AJAR_SOURCE_URL:-https://github.com/codebldr/ajar-agent/archive/refs/heads/main.tar.gz}
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SOURCE_DIR=

# Piped through sh there is no directory to have been run from, so the agent is fetched. Run
# from a checkout, what is already on disk wins — that is the version somebody is working on.
if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/agent.mjs" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download the agent"
  command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack the agent"

  SOURCE_DIR=$(mktemp -d)
  trap 'rm -rf "$SOURCE_DIR"' EXIT INT TERM

  say "Fetching the agent…"
  curl -fsSL "$SOURCE_URL" | tar -xz -C "$SOURCE_DIR" --strip-components 1 ||
    fail "could not download the agent from $SOURCE_URL"

  [ -f "$SOURCE_DIR/agent.mjs" ] ||
    fail "the download did not contain agent.mjs"
fi

# ── Node ───────────────────────────────────────────────────────────────────
#
# Not installed automatically. Every one of these machines has its own idea of how software
# arrives — apt, a package centre, an add-on store — and a script that guesses wrong leaves
# somebody with two copies of Node and no idea which one is running.

find_node() {
  for candidate in "${NODE:-}" node /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    version=$("$candidate" --version 2>/dev/null | sed 's/^v//; s/\..*//')
    [ -n "$version" ] || continue
    [ "$version" -ge "$NODE_MINIMUM" ] 2>/dev/null || continue
    command -v "$candidate"
    return 0
  done
  return 1
}

NODE_BIN=$(find_node) || fail "Node $NODE_MINIMUM or newer is needed. See docs/INSTALL.md for how to get it on this machine."

say "Node: $NODE_BIN ($("$NODE_BIN" --version))"

# ── Copy ───────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
for file in "$SOURCE_DIR"/*.mjs; do
  cp "$file" "$INSTALL_DIR/"
done
say "Installed to $INSTALL_DIR"

# ── Configure ──────────────────────────────────────────────────────────────
#
# Interactive, and deliberately so: this is where somebody types the intercom's password, and
# it is the only thing the agent cannot work out for itself.

# The answers are written to the home directory of whoever runs the setup, and read back by
# whoever the service runs as. Installed with `sudo sh`, those are two different people — root
# answers the questions, and the service starts as the user who typed sudo and finds nothing.
# So the setup is run as the user the service will run as, and the two agree by construction.
run_setup() {
  if [ "$(id -u)" = 0 ] && [ "$RUN_AS" != root ]; then
    su "$RUN_AS" -c "$NODE_BIN $INSTALL_DIR/agent.mjs --setup"
  else
    "$NODE_BIN" "$INSTALL_DIR/agent.mjs" --setup
  fi
}

if [ "${AJAR_SKIP_SETUP:-}" = 1 ]; then
  say "Skipping setup (AJAR_SKIP_SETUP=1)"
elif [ -t 0 ]; then
  say ""
  run_setup
elif [ -r /dev/tty ]; then
  # Piped through sh, this script *is* standard input, so the setup questions would be answered
  # by whatever is left of it. The terminal is still there; it just has to be asked for.
  say ""
  run_setup < /dev/tty
else
  say ""
  say "No terminal to ask questions with. Finish the setup yourself, as $RUN_AS, with:"
  say "  $NODE_BIN $INSTALL_DIR/agent.mjs --setup"
  AJAR_SKIP_SERVICE=1
fi

# ── Keep it running ────────────────────────────────────────────────────────

install_systemd() {
  unit=/etc/systemd/system/$SERVICE_NAME.service

  cat > "$unit" <<UNIT
[Unit]
Description=Ajar intercom agent
Documentation=https://github.com/codebldr/ajar
# The agent's first act is to dial out, so it wants a network that is actually up rather than
# merely configured.
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE_BIN $INSTALL_DIR/agent.mjs
User=$RUN_AS
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"

  say ""
  say "Running as a service. Useful from here:"
  say "  systemctl status $SERVICE_NAME     is it up"
  say "  journalctl -u $SERVICE_NAME -f     watch it, and read the pairing code"
}

install_launchd() {
  label=ro.codebldr.ajar
  plist=$HOME/Library/LaunchAgents/$label.plist
  logs=$HOME/Library/Logs

  mkdir -p "$(dirname "$plist")" "$logs"

  # The log carries pairing codes, and a pairing code is a key to the gate for ten minutes.
  # Created here rather than left to launchd, which would make it readable by every account on
  # the machine.
  [ -f "$logs/ajar-agent.log" ] || : > "$logs/ajar-agent.log"
  chmod 600 "$logs/ajar-agent.log"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/agent.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$logs/ajar-agent.log</string>
  <key>StandardErrorPath</key><string>$logs/ajar-agent.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"

  say ""
  say "Running in the background. Useful from here:"
  say "  tail -f $logs/ajar-agent.log      watch it, and read the pairing code"
  say "  launchctl unload $plist           stop it"
}

if [ "${AJAR_SKIP_SERVICE:-}" = 1 ]; then
  say ""
  say "Not installing a service (AJAR_SKIP_SERVICE=1). Start it yourself with:"
  say "  $NODE_BIN $INSTALL_DIR/agent.mjs"
elif [ "$(uname -s)" = Darwin ]; then
  install_launchd
elif command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  install_systemd
elif command -v systemctl >/dev/null 2>&1; then
  say ""
  say "Nearly there. Installing the service needs root, so finish with:"
  say "  sudo sh $SOURCE_DIR/install.sh"
  say ""
  say "Or start it yourself, which works but will not survive a reboot:"
  say "  $NODE_BIN $INSTALL_DIR/agent.mjs"
else
  # A NAS without systemd, usually. Its own scheduler is the way in, and it has a screen for it.
  say ""
  say "No systemd here, so there is nothing standard to install into."
  say "Start it from this machine's own task scheduler, with:"
  say "  $NODE_BIN $INSTALL_DIR/agent.mjs"
  say "See docs/INSTALL.md for the NAS wording."
fi
