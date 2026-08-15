ARG BUILD_FROM
FROM $BUILD_FROM

# The agent is fetched rather than copied in, so this folder never holds a second copy of the
# source to drift out of step with the first. Pinned to a tag: an add-on that quietly rebuilds
# itself into a different version is not something to leave in somebody's house.
ARG AGENT_REF=main
ARG AGENT_REPO=https://github.com/romeoonisim/ajar-agent

# No dependencies beyond Node itself — the agent has none, which is most of why it is safe to
# hand to a stranger who is about to point it at their front gate.
RUN apk add --no-cache nodejs curl tar \
  && mkdir -p /app \
  && curl -fsSL "${AGENT_REPO}/archive/refs/heads/${AGENT_REF}.tar.gz" \
    | tar -xz --strip-components 1 -C /app \
  && apk del curl tar

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
