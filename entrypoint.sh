#!/bin/sh
# Hands the settings folder to the agent's own user, then runs the agent as that user.
#
# A NAS's own screens mount a folder that belongs to the NAS's user, and the agent — which runs
# as `ajar`, not root — was refused its first write and stopped. The fix was a chown in a
# terminal most NAS owners never open. Done here instead, it is one click less than nothing.
#
# Root is held only for the chown. Started with `--user` already, there is nothing to hand
# over and nothing to drop, and the agent simply runs.
set -e

if [ "$(id -u)" = "0" ]; then
  for dir in "$(dirname "${AJAR_CONFIG:-/config/agent.json}")" "${AJAR_DATA:-}"; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    # Only when it is somebody else's. A chown over gigabytes of recordings on every start
    # would make a restart slow for nothing.
    if [ "$(stat -c %u "$dir")" != "$(id -u ajar)" ]; then
      chown -R ajar:ajar "$dir"
    fi
  done
  exec su-exec ajar node /app/agent.mjs "$@"
fi

exec node /app/agent.mjs "$@"
