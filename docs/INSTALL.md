# Installing the Ajar agent

The app on your phone does not talk to your intercom. Something in the house does, and this is
it: a small program that sits on any machine already switched on there, watches the gate, and
answers your phone wherever it is.

It needs somewhere to live because an intercom cannot dial out on its own. Give it a Raspberry
Pi, a NAS, a Home Assistant box, or an old laptop — anything that stays on.

**What you need before you start:** the intercom's password. That is all. The agent finds the
intercom's address by itself, and asks the intercom for its serial number rather than making
you find it.

---

## Raspberry Pi, or any Linux machine

One line:

```sh
curl -fsSL https://ajar.sh/install | sh
```

It checks for Node, installs the agent, asks which intercom it found and what the password is,
and sets it up to start again by itself after a power cut.

Add `sudo` if you want it to run as a system service rather than only while you are logged in:

```sh
curl -fsSL https://ajar.sh/install | sudo sh
```

### If Node is missing

The installer will not install Node for you — every one of these machines has its own idea of
where software comes from, and a script that guesses wrong leaves you with two copies and no
idea which is running.

On Raspberry Pi OS and Debian:

```sh
sudo apt install nodejs
```

Version 18 or newer. Check with `node --version`. If your distribution ships something older,
[NodeSource](https://github.com/nodesource/distributions) has current builds.

### Afterwards

```sh
sudo systemctl status ajar-agent    # is it running
sudo journalctl -u ajar-agent -f    # watch it, and read the pairing code
```

The **pairing code** is six digits, printed when the agent connects. Type it into the Ajar app
to link your phone. It expires after ten minutes; restart the agent for a new one.

---

## NAS — Synology, QNAP, Unraid

Use Docker. Every one of these has it, under Container Manager, Container Station, or the
Docker tab.

Two settings matter and neither is optional:

- **Network: host.** The agent finds your intercom by shouting on the local network, and serves
  your phone on it. From behind a container's own address it can do neither.
- **A volume for `/config`.** Otherwise every update asks for the intercom's password again.

From a terminal on the NAS:

```sh
docker build -t ajar-agent .
docker run -d --name ajar \
  --network host \
  --restart unless-stopped \
  -v ajar-config:/config \
  -e VTO_PASSWORD='your-intercom-password' \
  ajar-agent
```

Then read the pairing code:

```sh
docker logs -f ajar
```

If your NAS has more than one intercom on the network, the agent will list what it found and
stop; add `-e VTO_HOST=192.168.1.50` with the one you want.

If the username is not `admin`, add `-e VTO_USERNAME=...`.

### Through the NAS's own interface

The same three things, in whatever the interface calls them:

| What to set | Value |
|---|---|
| Network mode | Host |
| Volume | any folder → `/config` |
| Environment variable | `VTO_PASSWORD` = the intercom's password |
| Restart policy | Always, or Unless stopped |

---

## Home Assistant

Copy the `ha-addon` folder into the `addons` folder on your Home Assistant machine, renaming it
to `ajar`. Then:

1. **Settings → Add-ons → Add-on Store**
2. Three dots, top right → **Check for updates**
3. **Ajar** appears under *Local add-ons*
4. Install it, open **Configuration**, type the intercom's password, save
5. **Start**, then open the **Log** tab and read the six-digit pairing code

Leave *host* empty unless you have more than one intercom.

The add-on shares the host network, for the same reason the NAS container does.

---

## Any machine, by hand

If you would rather not have a service installed:

```sh
node agent.mjs --setup     # once, to answer the questions
node agent.mjs             # to run it
```

It will not survive a reboot this way. That is the only difference.

To change intercom or password later, `node agent.mjs --setup` again.

---

## When it does not work

**"No intercom answered on this network."** The agent and the intercom are not on the same
network. In Docker or Home Assistant this is almost always the host-network setting. Otherwise
the machine is on a different wifi from the intercom.

**The phone sees the camera away from home but not at home.** Some routers stop devices on the
wifi from talking to each other — "client isolation" or "AP isolation" — and some houses have
two access points that do not bridge to each other. The app handles this: it tries the short
way, and quietly uses the long way round when it cannot. You lose speed, not the camera. A
machine plugged in with a cable rather than on wifi usually avoids it entirely.

**"The intercom refused that username and password."** The account is the intercom's own — the
one you use on its web page — not your Ajar account and not the manufacturer's app account.

**No pairing code in the log.** The agent prints it once, on connecting. Restart it.
