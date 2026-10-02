# Installing on a NAS

Ajar needs one small program — the agent — running at home, on the same network as the
intercom. A NAS is a good place for it: it is always on. This page sets it up from the NAS's own
screens, with no terminal.

**You need:**

- **A NAS that runs Docker.** Synology: most "+" models (DS220+, DS923+, DS1522+ …) — look for
  **Container Manager** in Package Center. The cheaper "j" models (DS223j …) have no Docker, and
  this page will not work on them. QNAP: **Container Station**. Unraid: the **Docker** tab.
- **The intercom's password** — the one its own web page asks for. Not your Ajar account, and
  not the account of the manufacturer's app.
- **The NAS on the same network as the intercom.**

It takes about five minutes.

---

## Synology

### 1. Install Container Manager

**Package Center** → search **Container Manager** → **Install**. Skip this if it is already there.

### 2. Make a folder for Ajar's settings

**File Station** → open the `docker` shared folder (Container Manager made it) → **Create** →
**Create folder** → name it `ajar`.

This is where Ajar keeps its settings and the recordings of your visits. Keep it: as long as the
folder is there, updating Ajar never asks you to set anything up again.

### 3. Download Ajar

**Container Manager** → **Registry** → search `codebldr/ajar-agent` → select it → **Download** →
tag `latest` → **Apply**.

### 4. Start it

**Container Manager** → **Image** → select `codebldr/ajar-agent` → **Run**, then:

1. **Container name:** `ajar`. Tick **Enable auto-restart**. **Next**.
2. **Volume Settings** → **Add Folder** → pick `docker/ajar` → mount path `/config`.
3. **Network** → choose **host**.
4. **Environment** → add a variable: name `VTO_PASSWORD`, value the intercom's password.
5. **Next** → **Done**.

### 5. Add it to your phone

Open the **Ajar** app on a phone **on your home Wi-Fi** → **Add device**. The app finds the
intercom by itself → **Add it**. That is all.

The first phone added runs the house. To add the rest of the family, use **Share** in that
phone's app.

---

## QNAP — Container Station

1. **Container Station** → **Create** → search `codebldr/ajar-agent` → **Install**.
2. **Advanced Settings → Network**: mode **Host**.
3. **Advanced Settings → Environment**: add `VTO_PASSWORD` = the intercom's password.
4. **Advanced Settings → Shared Folders**: a folder of yours → mount point `/config`.
5. **Create**. Then add it to your phone as in [step 5 above](#5-add-it-to-your-phone).

## Unraid — Docker tab

1. **Docker** → **Add Container**.
2. Repository: `codebldr/ajar-agent`.
3. Network Type: **Host**.
4. **Add another Path**: host path `/mnt/user/appdata/ajar` → container path `/config`.
5. **Add another Variable**: key `VTO_PASSWORD`, value the intercom's password.
6. **Apply**. Then add it to your phone as in [step 5 above](#5-add-it-to-your-phone).

## Asustor, TrueNAS and the rest

Any Docker screen works with the same four things: image `codebldr/ajar-agent`, network **host**,
a folder mounted on `/config`, and the variable `VTO_PASSWORD`. Turn on restarting automatically
if the screen offers it.

---

## Later

### Updating

Synology: **Registry** → `codebldr/ajar-agent` → **Download** → `latest` again. Then
**Container** → `ajar` → **Action** → **Stop**, then **Delete**, and start it again as in
[step 4](#4-start-it) with the same folder. Your settings and your phone's pairing are in the
folder, so nothing has to be set up again.

QNAP and Unraid: pull the image again and recreate the container with the same folder; Unraid
shows an **apply update** link on the Docker tab when there is one.

### The intercom's password changed

**Container** → `ajar` → **Action → Stop** → **Edit** → **Environment** → change
`VTO_PASSWORD` → **Save** → **Start**.

### Moving the agent from another machine

Stop the old one first — a Raspberry Pi, a Mac, another container. Two agents on one intercom
knock each other off in a loop. See [moving it](moving.md).

---

## When it does not work

Open the container's **Log**: Synology **Container → ajar → Log**; QNAP **Logs**; Unraid the
container's log icon. What it says decides the fix.

**The app does not find the intercom.** The phone is probably on a different Wi-Fi than the NAS —
a house with a second router, or a guest network. Either move the phone to the NAS's Wi-Fi, or
pair with a code: in the app choose **Enter serial manually**, then type the serial and the
**six-digit code** from the container's log (`Pairing code: …`). The code lasts ten minutes;
restarting the container prints a new one.

**"No intercom answered on this network."** Check that the network is **host** — it is the
cause almost every time. If it is, the intercom is probably behind a second router. Find its
address — the router's list of connected devices shows it, or whoever installed the intercom
knows it — and add a variable `VTO_HOST` with that address, for instance `192.168.100.2`.

**"More than one intercom answered."** The log lists them. Add `VTO_HOST` with the address of the
one you want.

**"The intercom refused the account."** `VTO_PASSWORD` is not the intercom's password — check it
by opening the intercom's own web page with it. If its user is not `admin`, add `VTO_USERNAME`.

**"EACCES: permission denied".** The image is older than October 2026 — download `latest` again
and start a new container. Or the container was given a user of its own in the NAS's screen;
clear that field.

**The doorbell rings at the gate but not on the phone.** Some intercom models name their events
differently. [Open an issue][issues] with the model, and we will help you read what it sends.

**It asks for the password again after every update.** The folder on `/config` is missing or
changed. Use the same folder each time.

---

## For the technically minded

### From a terminal

Turn on SSH (Synology: *Control Panel → Terminal & SNMP*; QNAP: *Control Panel → Telnet/SSH*),
then (with `sudo` in front on Synology):

```sh
docker run -d --name ajar \
  --network host \
  --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  codebldr/ajar-agent
```

Single quotes around the password, or a `$` or `!` in it is eaten by the shell.

```sh
docker logs -f ajar        # watch it, and read the pairing code
docker restart ajar        # restart, and print a new pairing code
docker pull codebldr/ajar-agent && docker rm -f ajar   # update, then run the line above again
docker run --rm --network host codebldr/ajar-agent --discover   # list the intercoms it can see
```

To print the intercom's raw events while the doorbell is pressed — useful for an issue:

```sh
docker stop ajar
docker run --rm --network host -v ajar-config:/config codebldr/ajar-agent --watch
```

### As a Synology project

**Container Manager → Project → Create**, any path, *Create docker-compose.yml*:

```yaml
services:
  ajar:
    image: codebldr/ajar-agent
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

### Why each setting

- **Network host.** The agent finds the intercom by broadcasting on the local network, and the
  phone finds the agent the same way. From behind a container's own address neither works.
- **A folder or a named volume on `/config`.** It holds the intercom's password, the agent's
  identity and the recordings. Without one, Docker makes an anonymous volume, and the usual update
  — remove the container, run it again — starts over with a new one: the phone has to pair again
  and the history is left behind. The agent says so in its log when started that way.
- **No `chown`, no `chmod`.** The container starts as root only long enough to hand `/config` to
  the agent's own user (`1001`), then runs the agent as that user. Do not `chmod 777` the folder:
  it makes the intercom's password readable by everyone on the NAS. Started with `--user`, the
  hand-over is skipped and the folder must already belong to that user.
- **Recordings** live in `/config/history`. The app decides how much room they take — half a
  gigabyte to five, in *Settings → Recordings* — and the agent never takes more than a tenth of the
  free space it found at start, nor writes with under a gigabyte left.
- The same image is on Docker Hub (`codebldr/ajar-agent`) and GitHub
  (`ghcr.io/codebldr/ajar-agent`), for x86, 64-bit ARM and 32-bit ARM.

[issues]: https://github.com/codebldr/ajar-agent/issues
