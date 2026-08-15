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

# No dependencies to install — that is the point of the agent having none. Only the source.
WORKDIR /app
COPY *.mjs ./

# Somewhere for the configuration that is not inside the image.
ENV AJAR_CONFIG=/config/agent.json
VOLUME /config

# Nothing here needs root: the agent opens one high port and reads its own configuration.
RUN adduser -D -H ajar && mkdir -p /config && chown ajar /config
USER ajar

ENTRYPOINT ["node", "/app/agent.mjs"]
