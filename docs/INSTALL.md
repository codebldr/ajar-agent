# Installing the Ajar agent

The app on your phone does not talk to your intercom. Something in the house does, and this is
it: a small program that sits on any machine already switched on there, watches the gate, and
answers your phone wherever it is.

**Pick the machine you have.** Each guide is complete on its own — commands you can copy, the
questions you will be asked, and what to do when it does not work.

| Your machine | Guide |
|---|---|
| Raspberry Pi, Ubuntu, Debian, any Linux | **[Raspberry Pi](install/raspberry-pi.md)** |
| Synology, QNAP, Unraid, Asustor, TrueNAS | **[NAS](install/nas.md)** |
| Home Assistant OS or Supervised | **[Home Assistant](install/home-assistant.md)** — add this repository to the add-on store |
| Any Linux machine with Docker | **[Docker](install/docker.md)** |
| Mac | **[Mac](install/mac.md)** |
| Something else, or no service wanted | **[By hand](install/manual.md)** |

Already running it somewhere and want it elsewhere: **[moving it](install/moving.md)**. Stop the
old one first — that page says why.

---

## What every guide has in common

**You need one thing to hand:** the intercom's password — the one its own web page asks for, not
your Ajar account and not the manufacturer's app account. The agent finds the intercom's address
by itself, and asks the intercom for its serial number rather than making you find the sticker.

**The machine needs three things**, and no more:

- **Node 18 or newer**, except in Docker and Home Assistant, which bring their own.
- **The same network as the intercom.** The agent finds it by broadcasting, which does not cross
  routers. An intercom behind a second router can still be named directly.
- **An outbound internet connection.** The agent dials out; nothing dials in, so there are no
  ports to forward, no VPN, and no public address.

**And it always goes the same way:**

1. Install the agent.
2. Give it the intercom's password.
3. Read the **six-digit pairing code** out of the log.
4. Type that code into the Ajar app.

The code lasts ten minutes. Restart the agent for a new one — it prints one every time it
connects.

---

## Which machine to pick

| | Good for |
|---|---|
| **Raspberry Pi** | The answer for keeping it. Cheap, silent, never leaves the house. |
| **NAS** | Already on, already has Docker. Nothing extra to buy. |
| **Home Assistant** | Already on, and the add-on takes one form to fill in. |
| **A Mac or a laptop** | Trying it out. It takes the doorbell with it when it leaves. |

Anything switched on all the time will do. What it costs to run is a rounding error next to the
intercom itself.

---

## After it is installed

- **[docs/INTERCOM.md](INTERCOM.md)** — the intercom side: event codes, channel numbering, what
  a doorbell press actually emits, and the security reasoning behind every trust decision. All
  measured against real hardware rather than taken from a manual.
- `node agent.mjs --help` — every flag and every environment variable.
- A model whose doorbell does not come through: run the agent with `--watch`, press the button,
  and [open an issue](https://github.com/romeoonisim/ajar-agent/issues) with what it printed.
  The event codes are settings rather than code, so it is a small change.
