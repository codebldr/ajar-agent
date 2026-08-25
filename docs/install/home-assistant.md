# Installing on Home Assistant

As an add-on, from this repository. Home Assistant OS, or Supervised — anything with an
**Add-on Store**. If you run Home Assistant Container or Core, there is no add-on system; use
[Docker](docker.md) instead.

Nothing to download and no terminal: you add this repository's address once, and Ajar appears in
the store beside the official add-ons.

**Before you start:**

- The intercom's password — the one its own web page asks for. Not your Ajar account, not the
  manufacturer's app account.
- Home Assistant on the **same network as the intercom**.

The agent is not a Home Assistant integration — nothing appears under Devices, and there are no
entities. It is the Ajar agent, running on the machine you already have on. Your phone talks to
the Ajar app, not to Home Assistant.

---

## 1. Add the repository

1. **Settings → Add-ons → Add-on Store**
2. Three dots, top right → **Repositories**
3. Paste this and **Add**:

   ```
   https://github.com/romeoonisim/ajar-agent
   ```

4. **Close**

Or use [this link][my-link], which opens the same box with the address already in it.

Once added, Home Assistant checks it for updates by itself — a new version of the add-on turns
up the same way an official one does.

## 2. Install it

1. Still in the **Add-on Store**, scroll to the **Ajar** repository at the bottom of the page
2. **Ajar** → **Install**

It builds the image on your own machine, which takes a couple of minutes on a Pi, longer on a
Pi Zero. There is no image downloaded from anywhere — the add-on fetches the agent's source and
builds it in front of you.

[my-link]: https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository=https%3A%2F%2Fgithub.com%2Fromeoonisim%2Fajar-agent

## 3. Configure it

On the **Configuration** tab:

| Field | What to put |
|---|---|
| `password` | the intercom's password |
| `username` | `admin`, unless yours was changed |
| `host` | **leave empty** — the agent finds the intercom itself |

**Save**.

Fill `host` in only if the log later says more than one intercom answered, or if the intercom
sits behind a second router where a broadcast cannot reach it.

## 4. Start it, and read the pairing code

**Start**, then the **Log** tab:

```
  Pairing code: 169086
  Enter it in the Ajar app within 10 minutes.
```

Six digits into the Ajar app, and the gate is on your phone.

The code lasts ten minutes. Missed it: **Restart** the add-on and a new one is printed.

Leave *Start on boot* and *Watchdog* on, which is what makes it survive a power cut.

---

## Living with it

- **The Log tab** is where everything shows: the pairing code, doorbell presses, the gate
  opening.
- **The password changed?** Change it on the Configuration tab and restart the add-on. The form
  wins over anything stored.
- **Updating:** an **Update** button appears on the add-on's page when a new version is
  published, the same as for any official add-on. Your settings and your paired phones survive —
  they live in the add-on's own storage, not in the image. If it does not show, three dots in
  the store → *Check for updates*.

## Where the recordings go

In **`/media/ajar`**, not in the add-on's own folder — deliberately.

Every visit keeps a picture and a short video, which over a year is a few gigabytes. The add-on's
configuration folder is swept into every Home Assistant backup, so keeping video there would make
each backup carry the whole history and grow month after month. `/media` is where Home Assistant
expects files of this size, is its own tick in the backup dialog, and can be browsed and played
from Home Assistant's own **Media** panel.

How much of it to use is set from the Ajar app — *Settings → Recordings* — along with how long a
visit is recorded for and whether to record at all. Whatever is chosen there, the agent will not
take more than a tenth of the space that was free when it started, and stops recording entirely
with under a gigabyte left. On a Home Assistant box with a small card that matters more than the
history does.

## Why it wants the host network

The add-on runs with `host_network: true`, and it will not work without it. The agent finds the
intercom by broadcasting on the local network, and serves your phone directly when the phone is
at home. From behind the add-on's own address it can do neither. That is the same access the
manufacturer's app has on a phone, and less than most camera integrations take.

## Without adding the repository

If you would rather Home Assistant did not follow a repository of ours, install it as a local
add-on instead. With the **Advanced SSH & Web Terminal** add-on:

```sh
git clone https://github.com/romeoonisim/ajar-agent.git /tmp/ajar-agent
cp -r /tmp/ajar-agent/ha-addon /addons/ajar
rm -rf /tmp/ajar-agent
```

Or over **Samba**: open the `addons` share, make a folder called `ajar`, and drag in the three
files from `ha-addon` — `config.yaml`, `Dockerfile`, `run.sh`. You should end up with
`/addons/ajar/config.yaml`.

Then three dots in the store → *Check for updates*, and **Ajar** appears under *Local add-ons*.
Everything from step 3 onwards is the same. Updates are yours to do: copy the folder over again
and press **Rebuild**.

---

## When it does not work

**Ajar does not appear in the store.** Reload the page — the store caches. Then three dots →
*Check for updates*. The repository sits at the very bottom of the store page, under its own
heading, below every official one.

**"Invalid repository" when adding it.** The address is the repository itself,
`https://github.com/romeoonisim/ajar-agent` — not a link to a file inside it, and no `.git` on
the end.

**The build fails.** It downloads the agent from GitHub while building, so the Home Assistant
box needs to reach the internet. The Supervisor log says which step failed.

**"Set the intercom's password in this add-on's configuration."** The password field is empty.
Fill it in on the Configuration tab and save before starting.

**"No intercom answered on this network."** Home Assistant and the intercom are on different
networks — a separate VLAN for cameras is the usual reason. Put the intercom's address into the
`host` field.

**"More than one intercom answered."** It lists them and stops rather than guessing which gate
to open. Put the one you want into `host`.

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page. Check `username`; it is `admin` on almost all of them.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model.
[Open an issue][issues] with your model number; the codes are settings rather than code, so it
is a small change.

**Already running the agent on another machine?** Stop that one first — see
[moving it](moving.md). Two agents on one intercom knock each other off in a loop.

[issues]: https://github.com/romeoonisim/ajar-agent/issues
