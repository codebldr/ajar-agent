# Ajar agent

Your Dahua intercom, on your phone, from anywhere — without the manufacturer's cloud.

This is the piece that lives in your house. It watches the intercom for a doorbell press, pulls
the camera when somebody wants to look, opens the gate when you ask, and carries your voice back
to whoever is standing at it. The phone app talks to this; it never talks to your intercom
directly, and it never learns your intercom's password.

It runs on anything already switched on in the house: a Raspberry Pi, a NAS, a Home Assistant
box, an old laptop.

## Installing

```sh
curl -fsSL https://ajar.sh/install | sh
```

For a NAS, Home Assistant, or the longer version of any of it, see
**[docs/INSTALL.md](docs/INSTALL.md)**.

The only thing you need to hand is **your intercom's password** — the one its own web page asks
for. The agent finds the intercom on your network by itself, and asks the intercom for its serial
number rather than making you find the sticker.

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

## Privacy

The agent holds your intercom's password on your own machine, in
`~/.config/ajar/agent.json`, and hands it to nobody. Phones are given a key for the local
network and nothing else. Video and audio go to your phone; they are not stored anywhere along
the way.

## Status

Early. It runs a real house every day, which is a different thing from being finished.
