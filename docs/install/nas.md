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
| Volume | a named volume, or a folder → `/config` | Where the intercom's password, the agent's identity, and the recordings are kept. Without it, every update asks for the password again, your phone has to pair again, and the history is thrown away with the old container. |

If the container starts and says it found no intercom, it is the network mode. Every time.

**A folder has to be handed to the agent.** The agent runs as user `1001` inside the container,
not as root. A folder made in the NAS's own screens belongs to the NAS's user, so the agent stops
at once with `EACCES: permission denied, open '/config/agent.json'`. Give the folder to it, once,
from the NAS's terminal:

```sh
sudo chown -R 1001:1001 /volume1/docker/ajar/config
```

Nothing else — no `chmod`. The agent keeps its own files private, and `chmod 777`, which a web
search will offer, makes the intercom's password readable by everyone on the NAS. A named volume
(`ajar-config` below) needs none of this.

Only the password is needed. The agent finds the intercom by itself; set `VTO_HOST` only if it
says it found none, or more than one.

**Name the volume, or give it a folder.** Leaving it out does not fail loudly: Docker invents a
volume nobody named, the agent works, and then the usual update — remove the container, run it
again — starts a fresh one and abandons the old, along with however many gigabytes of doorbell
video it held. The agent says so in its log at startup if this is how it was started.

Recordings live beside the settings, in `/config/history`. A NAS is the best of the machines
this runs on for that: it is the one with room. The app decides how much of it to use — from
half a gigabyte to five, in *Settings → Recordings* — and the agent will not go past a tenth of
whatever was free when it started, nor write at all with under a gigabyte left on the disk.

---

## The short way: the NAS's terminal

Turn on SSH in the NAS's settings — Synology: *Control Panel → Terminal & SNMP*; QNAP:
*Control Panel → Telnet/SSH* — then log in and run (on Synology, with `sudo` in front):

```sh
docker run -d --name ajar \
  --network host \
  --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  ghcr.io/codebldr/ajar-agent
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

---

## The long way: the NAS's own screens

The image is published at `ghcr.io/codebldr/ajar-agent`, so nothing has to be built.

### Synology — Container Manager

A project is the one screen that takes everything at once, the named volume included:

1. **Container Manager → Project → Create**
2. Name: `ajar`. Path: any folder — it only holds the file below.
3. Source: *Create docker-compose.yml*, and paste:

   ```yaml
   services:
     ajar:
       image: ghcr.io/codebldr/ajar-agent
       container_name: ajar
       network_mode: host
       restart: unless-stopped
       volumes:
         - ajar-config:/config
       environment:
         VTO_PASSWORD: your-intercom-password

   volumes:
     ajar-config:
   ```

4. Next, Done. Then **Container → ajar → Log** for the pairing code.

To keep the settings in a folder you can see in File Station instead, write
`/volume1/docker/ajar/config:/config` in place of `ajar-config:/config`, drop the last two lines,
and run the `chown` above on that folder before starting.

### QNAP — Container Station

1. **Container Station → Create → search** `ghcr.io/codebldr/ajar-agent`
2. **Advanced Settings → Network**: mode **Host**
3. **Advanced Settings → Environment**: `VTO_PASSWORD` = the intercom's password
4. **Advanced Settings → Shared Folders**: a folder → `/config` — after the `chown` above
5. Create, then **Logs** for the pairing code

### Unraid — Docker tab

1. **Docker → Add Container**
2. Repository: `ghcr.io/codebldr/ajar-agent`
3. Network Type: **Host**
4. Add variable: `VTO_PASSWORD` = the intercom's password
5. Add path: `/mnt/user/appdata/ajar` → `/config` — after the `chown` above
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

**To update:** `docker pull ghcr.io/codebldr/ajar-agent`, then `docker rm -f ajar` and run it
again. On Synology, a project does the same with **Project → ajar → Action → Build**. The
`/config` volume carries your settings and your pairing across.

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
  ghcr.io/codebldr/ajar-agent
```

**"More than one intercom answered."** It lists them and stops rather than guessing which gate
to open. Add `-e VTO_HOST=` with the one you want.

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page. Add `-e VTO_USERNAME=…` if it is not `admin`.

**"EACCES: permission denied, open '/config/agent.json'".** `/config` is a NAS folder the agent
may not write in. Run the `chown` from [the top of this page](#two-settings-that-are-not-optional)
on it — the log prints the exact command — and start the container again.

**It asks for the password again after every update.** The `/config` volume is missing or points
somewhere new.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model. Stop
the container and watch what yours emits:

```sh
docker stop ajar
docker run --rm --network host -v ajar-config:/config ghcr.io/codebldr/ajar-agent --watch
```

Press the doorbell. [Open an issue][issues] with what it printed and it will be built in.

**Already running the agent elsewhere?** Stop that one first — see [moving it](moving.md). Two
agents on one intercom knock each other off in a loop.

[issues]: https://github.com/codebldr/ajar-agent/issues
