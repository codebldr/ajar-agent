#!/usr/bin/with-contenv bashio
# Turns the add-on's form into the environment the agent expects, and gets out of the way.

export VTO_USERNAME="$(bashio::config 'username')"
export VTO_PASSWORD="$(bashio::config 'password')"

# Empty means "go and find it", which is what the agent does when this is unset. Only a house
# with more than one intercom has to answer this.
if bashio::config.has_value 'host'; then
  export VTO_HOST="$(bashio::config 'host')"
fi

# Survives updates and restarts, unlike anything written inside the container.
export AJAR_CONFIG=/config/agent.json

# Recordings are large and are not settings.
#
# Left to itself the agent keeps them beside the configuration, which is right on a Pi and
# wrong here: this add-on's config folder goes into every Home Assistant backup, so a year of
# doorbell video would ride along in each one. `/media` is where Home Assistant expects files
# of this size, and it is a separate choice at backup time.
export AJAR_DATA=/media/ajar

if ! bashio::config.has_value 'password'; then
  bashio::log.fatal "Set the intercom's password in this add-on's configuration."
  bashio::exit.nok
fi

bashio::log.info "Starting the Ajar agent"

# The pairing code is printed here. It is how a phone is let in, and it is only good for ten
# minutes, so somebody has to be able to read this log — which is why it goes to stdout.
exec node /app/agent.mjs
