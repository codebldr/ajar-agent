# The agent, in a box.
#
# This is the shape a NAS and a Home Assistant box both understand, so one image serves both.
#
# Two things about it are not optional. It must run with the host's network — the agent finds
# the intercom by shouting on the local network, and serves phones on it, and neither works
# from behind a container's own address. And the configuration must outlive the container, or
# every update asks for the intercom's password again.
#
#   docker run -d --name ajar --network host \
#     -v ajar-config:/config -e AJAR_CONFIG=/config/agent.json \
#     --restart unless-stopped ajar-agent
#
# The pairing code is printed to the log: docker logs -f ajar

FROM node:20-alpine

# No dependencies to install — that is the point of the agent having none. Only the source,
# and su-exec, which is how the entrypoint lets go of root.
WORKDIR /app
COPY *.mjs ./
COPY entrypoint.sh /entrypoint.sh
RUN apk add --no-cache su-exec && chmod 755 /entrypoint.sh

# Somewhere for the configuration that is not inside the image.
ENV AJAR_CONFIG=/config/agent.json
VOLUME /config

# The agent itself needs no root: it opens one high port and reads its own configuration. The
# container starts as root only so the entrypoint can hand a mounted folder to `ajar` — see
# entrypoint.sh — and the agent then runs as `ajar`, as it always has.
RUN adduser -D -H ajar && mkdir -p /config && chown ajar /config

ENTRYPOINT ["/entrypoint.sh"]
