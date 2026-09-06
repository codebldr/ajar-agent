# Ajar agent

Your Dahua intercom, on your phone, from anywhere — without the manufacturer's cloud.

This is the piece that lives in your house. It watches the intercom for a doorbell press, pulls
the camera when somebody wants to look, opens the gate when you ask, and carries your voice back
to whoever is standing at it. The phone app talks to this; it never talks to your intercom
directly, and it never learns your intercom's password.

It runs on anything already switched on in the house: a
[Raspberry Pi](docs/install/raspberry-pi.md), a [NAS](docs/install/nas.md), a
[Home Assistant](docs/install/home-assistant.md) box, a [Mac](docs/install/mac.md), or
[Docker](docs/install/docker.md) on whatever else you have.

## Installing

**Pick the machine you have.** Each guide stands on its own — the commands to copy, the
questions you will be asked, and what to do when it does not work.

| Where it runs | | How it goes in |
|---|---|---|
| Raspberry Pi, and any Linux | **[Install guide →](docs/install/raspberry-pi.md)** | one command, then a service that survives a power cut |
| NAS — Synology, QNAP, Unraid, Asustor | **[Install guide →](docs/install/nas.md)** | Docker, with the clicking for each brand |
| Home Assistant | **[Install guide →](docs/install/home-assistant.md)** | an add-on — this repository is its store |
| Docker, anywhere else | **[Install guide →](docs/install/docker.md)** | `docker run`, or compose |
| Mac | **[Install guide →](docs/install/mac.md)** | one command; good for trying it out |
| Anything else | **[Install guide →](docs/install/manual.md)** | `node agent.mjs`, no service, nothing installed |

Moving it from one machine to another later: **[here](docs/install/moving.md)**. Stop the old one
first — two agents on the same intercom knock each other off in a loop.

### The short version, on a Pi

```sh
curl -fsSL https://raw.githubusercontent.com/codebldr/ajar-agent/main/install.sh | sudo sh
```

It asks for the intercom's password, then prints a **six-digit pairing code**. Type that into the
Ajar app and you are done. To see it again later:

```sh
sudo journalctl -u ajar-agent -f
```

### The short version, in Docker

Both flags matter: without them the agent cannot find your intercom, and it forgets its settings
on every update.

```sh
git clone https://github.com/codebldr/ajar-agent.git
cd ajar-agent
docker build -t ajar-agent .
docker run -d --name ajar --network host --restart unless-stopped \
  -v ajar-config:/config -e VTO_PASSWORD='your-intercom-password' ajar-agent
docker logs -f ajar
```

The only thing you need to hand is **your intercom's password** — the one its own web page asks
for. The agent finds the intercom on your network by itself, and asks the intercom for its serial
number rather than making you find the sticker. `node agent.mjs --help` lists the flags.

## What it needs

- **Node 18 or newer.** Nothing else. No npm install, no dependencies — see below.
- **The same network as the intercom.** It finds it by broadcasting, which does not cross
  routers.
- **An outbound internet connection.** The agent dials out; nothing needs to dial in, so there
  are no ports to forward and no VPN to set up.

## No dependencies, on purpose

This program opens a gate. Every package it installed would be another way into your house, and
a supply chain you did not choose to trust. So the WebSocket client, the RTSP client, the digest
authentication and the device discovery are all written out by hand, in files you can read in a
sitting.

| File | What it is |
|---|---|
| `agent.mjs` | The whole program: events, camera, gate, talk |
| `discover.mjs` | Finding the intercom without being told where it is |
| `digest.mjs` | HTTP digest auth, which is what the intercom speaks |
| `rtsp.mjs` | Pulling the camera |
| `backchannel.mjs` | Speaking to the gate — see below |
| `local.mjs` | Serving phones on your own network, and pairing them |
| `ws.mjs` | The connection out |

## Talking to the gate

Getting a voice out of a Dahua door station is the part everyone gets stuck on. The answer is
not the audio endpoint and not a call: it is the **ONVIF backchannel**, a `sendonly` track the
camera offers if you ask for it in `DESCRIBE`. Write RTP into it and the gate speaker plays it,
with no call up, so nothing rings inside the house.

Two details cost a whole evening and are worth writing down. `SETUP` wants the track appended
with a **slash** — `…subtype=1/trackID=5`, not `&` — or the camera answers `451`. And the camera
**ignores the interleaved channels you ask for**; read them back from the `Transport` header or
your audio goes nowhere.

## Going deeper

**[docs/INTERCOM.md](docs/INTERCOM.md)** has the rest: the flags, the event codes and what this
device actually emits when a doorbell is pressed, the channel numbering, how it is found across
a router, and the security reasoning behind every trust decision in here. All measured against
real hardware rather than taken from a manual.

## Security

Found something? **[SECURITY.md](SECURITY.md)** says where to send it, and — worth reading first
— what the agent trusts, what it does not, and which weaknesses are known and accepted.

The parts a stranger can knock on have tests, and they need nothing installed:

```sh
node --test "tests/*.test.mjs"
```

They cover the house network server — the key, the size ceilings, the connection cap, and the
rekey that a revoked phone must not survive — and the WebSocket handshake. Every one of those
limits looks like paranoia until it is removed, which is why they are written down as tests
rather than left as comments.

## Privacy

The agent holds your intercom's password on your own machine, in
`~/.config/ajar/agent.json`, and hands it to nobody. Phones are given a key for the local
network and nothing else. Video and audio go to your phone; they are not stored anywhere along
the way.

## Status

Early. It runs a real house every day, which is a different thing from being finished.

## Licence

**[Apache License 2.0](LICENSE)** — do what you like with it, including commercially. The parts
worth knowing: it grants you a patent licence from everyone who contributed, it does not hand you
the Ajar name along with the code, and it comes with no warranty of any kind. That last one is not
a formality when the software opens a gate.
