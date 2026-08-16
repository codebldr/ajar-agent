# Installing with Docker

On any Linux machine with Docker — a home server, a mini PC, a VM. For a NAS with its own Docker
screens, [nas.md](nas.md) has the clicking as well as the commands.

**Docker Desktop on Mac and Windows will not work.** It runs Docker inside a virtual machine
with a network of its own, so `--network host` gets you the VM's network rather than the house's
— the agent never finds the intercom, and your phone never finds the agent. On a Mac, use
[mac.md](mac.md).

---

## 1. Build it

There is no published image yet, so build from source:

```sh
git clone https://github.com/romeoonisim/ajar-agent.git
cd ajar-agent
docker build -t ajar-agent .
```

## 2. Run it

```sh
docker run -d --name ajar \
  --network host \
  --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  ajar-agent
```

Neither flag is decoration:

- **`--network host`** — the agent finds the intercom by broadcasting on the local network and
  serves your phone on it. From behind a container's own address it can do neither.
- **`-v ajar-config:/config`** — the intercom's password and the agent's identity. Without it,
  every update asks for the password again and every phone has to pair again.

Single quotes around the password, or a `$` in it disappears before Docker sees it.

## 3. Read the pairing code

```sh
docker logs -f ajar
```

```
  Pairing code: 169086
  Enter it in the Ajar app within 10 minutes.
```

Six digits into the Ajar app. Missed the ten minutes: `docker restart ajar` prints a new one.

---

## docker compose

Same thing, if you would rather keep it in a file:

```yaml
services:
  ajar:
    build: .
    container_name: ajar
    network_mode: host
    restart: unless-stopped
    volumes:
      - ajar-config:/config
    environment:
      VTO_PASSWORD: your-intercom-password
      # Only when more than one intercom answers, or it sits behind another router:
      # VTO_HOST: 192.168.100.2
      # Only if the intercom's account is not `admin`:
      # VTO_USERNAME: admin

volumes:
  ajar-config:
```

```sh
docker compose up -d
docker compose logs -f
```

---

## Everything it takes

All optional except the password.

| Variable | What it does |
|---|---|
| `VTO_PASSWORD` | The intercom's own password. The only thing it cannot work out for itself. |
| `VTO_USERNAME` | `admin` unless yours was changed. |
| `VTO_HOST` | The intercom's address. Left out, the agent goes and finds it. |
| `VTO_PORT` | `80` unless the intercom's web page is somewhere else. |
| `CAMERA_CHANNEL` | `1`. A second gate is `2`. |
| `RTSP_PORT` | `554`. |
| `AJAR_CONFIG` | Where settings are kept. Already `/config/agent.json` in the image. |

`docker run --rm ajar-agent --help` lists the rest.

---

## Living with it

```sh
docker logs -f ajar        # watch it, and read the pairing code
docker restart ajar        # restart, and print a new pairing code
docker stop ajar           # stop it
docker rm -f ajar          # remove it; the ajar-config volume survives
```

**To update:**

```sh
git pull
docker build -t ajar-agent .
docker rm -f ajar
# then the same docker run as above
```

Settings and paired phones come back with the volume.

---

## When it does not work

**"No intercom answered on this network."** Almost always the network mode. This prints `host`
when it is right:

```sh
docker inspect -f '{{.HostConfig.NetworkMode}}' ajar
```

If it is right, see what the agent can actually see:

```sh
docker run --rm --network host ajar-agent --discover
```

Nothing listed means the machine and the intercom are on different networks, or the intercom is
behind a second router — a broadcast never crosses one. Name it: `-e VTO_HOST=192.168.100.2`.

**"More than one intercom answered."** It lists them and stops rather than guessing which gate
to open. `-e VTO_HOST=` with the one you want.

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page at `http://192.168.x.x`, not your Ajar account.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model:

```sh
docker stop ajar
docker run --rm --network host -v ajar-config:/config ajar-agent --watch
```

Press the doorbell, then [open an issue][issues] with what it printed. The codes are settings
rather than code — `RING_CODES`, `ANSWER_CODES`, `CANCEL_CODES`, `GATE_CODES` — so it is a small
change.

**Already running the agent elsewhere?** Stop that one first — see [moving it](moving.md). Two
agents on one intercom knock each other off in a loop.

[issues]: https://github.com/romeoonisim/ajar-agent/issues
