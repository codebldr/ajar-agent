# Installing on a NAS

Synology, QNAP, Unraid, Asustor, TrueNAS. All of them run Docker — under Container Manager,
Container Station, the Docker tab, or Apps — and all of them are already switched on, which is
the whole requirement.

**Before you start:**

- The intercom's password — the one its own web page asks for. Not your Ajar account, not the
  manufacturer's app account.
- The NAS on the **same network as the intercom**.
- Docker installed from your NAS's package centre.

---

## Two settings that are not optional

Whatever route you take below, these two decide whether it works at all:

| Setting | Value | Why |
|---|---|---|
| Network mode | **Host** | The agent finds your intercom by shouting on the local network, and serves your phone on it. From behind a container's own address it can do neither. |
| Volume | a folder → `/config` | Where the intercom's password and the agent's identity are kept. Without it, every update asks for the password again and your phone has to pair again. |

If the container starts and says it found no intercom, it is the network mode. Every time.

---

## The short way: the NAS's terminal

Turn on SSH in the NAS's settings — Synology: *Control Panel → Terminal & SNMP*; QNAP:
*Control Panel → Telnet/SSH* — then log in and run:

```sh
git clone https://github.com/romeoonisim/ajar-agent.git
cd ajar-agent
docker build -t ajar-agent .
```

Then start it:

```sh
docker run -d --name ajar \
  --network host \
  --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  ajar-agent
```

Mind the single quotes around the password — a NAS password with a `$` or a `!` in it is
otherwise eaten by the shell before Docker ever sees it.

**Read the pairing code:**

```sh
docker logs -f ajar
```

```
  Pairing code: 169086
  Enter it in the Ajar app within 10 minutes.
```

Six digits into the Ajar app, and you are done. Missed the ten minutes? `docker restart ajar`
prints a new one.

If Docker on your NAS refuses `git`, download the source instead:

```sh
curl -fsSL https://github.com/romeoonisim/ajar-agent/archive/refs/heads/main.tar.gz | tar -xz
cd ajar-agent-main
```

---

## The long way: the NAS's own screens

The image still has to be built once from the terminal above — there is no published image yet.
After that, everything is clickable.

### Synology — Container Manager

1. **Container Manager → Container → Create**
2. Image: **ajar-agent**
3. **Network**: tick *Use the same network as Docker Host*
4. **Advanced → Environment**: add `VTO_PASSWORD` = the intercom's password
5. **Advanced → Volume**: *Add Folder* → any folder on the NAS → mount path `/config`
6. **Auto-restart**: on
7. Create, start, then open the container's **Log** tab for the pairing code

### QNAP — Container Station

1. **Container Station → Create → search local images → ajar-agent**
2. **Advanced Settings → Network**: mode **Host**
3. **Advanced Settings → Environment**: `VTO_PASSWORD` = the intercom's password
4. **Advanced Settings → Shared Folders**: a folder → `/config`
5. Create, then **Logs** for the pairing code

### Unraid — Docker tab

1. **Docker → Add Container**
2. Repository: `ajar-agent`
3. Network Type: **Host**
4. Add variable: `VTO_PASSWORD` = the intercom's password
5. Add path: `/mnt/user/appdata/ajar` → `/config`
6. Apply, then the container's **Log** for the pairing code

---

## Living with it

```sh
docker logs -f ajar        # watch it, and read the pairing code
docker restart ajar        # restart, and print a new pairing code
docker stop ajar           # stop it
docker rm -f ajar          # remove it; the /config volume survives
```

**When the intercom's password changes**, recreate the container with the new
`-e VTO_PASSWORD=…`, or change it in the NAS's own screen and restart. The environment variable
wins over what is stored, so it is enough.

**To update:** `git pull`, `docker build -t ajar-agent .`, then `docker rm -f ajar` and run it
again. The `/config` volume carries your settings and your pairing across.

---

## When it does not work

**"No intercom answered on this network."** Host network. Check it — this prints `host` if it is
right:

```sh
docker inspect -f '{{.HostConfig.NetworkMode}}' ajar
```

If it is right and the intercom still is not found, the NAS and the intercom are on different
networks, or the intercom sits behind a second router. Name it directly:

```sh
docker rm -f ajar
docker run -d --name ajar --network host --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  -e VTO_HOST=192.168.100.2 \
  ajar-agent
```

**"More than one intercom answered."** It lists them and stops rather than guessing which gate
to open. Add `-e VTO_HOST=` with the one you want.

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page. Add `-e VTO_USERNAME=…` if it is not `admin`.

**It asks for the password again after every update.** The `/config` volume is missing or points
somewhere new.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model. Stop
the container and watch what yours emits:

```sh
docker stop ajar
docker run --rm --network host -v ajar-config:/config ajar-agent --watch
```

Press the doorbell. [Open an issue][issues] with what it printed and it will be built in.

**Already running the agent elsewhere?** Stop that one first — see [moving it](moving.md). Two
agents on one intercom knock each other off in a loop.

[issues]: https://github.com/romeoonisim/ajar-agent/issues
