# Moving the agent to another machine

Trying it on a laptop and then moving it to a Pi is the usual path. There is one rule, and
breaking it is loud.

## Stop the old one first

**Only one agent may hold an intercom.** Two of them set up for the same device knock each other
off the Worker in a loop — several times a second, each one printing a new pairing code as it
reconnects — and while that is happening the gate answers nobody:

```
worker: connected
  Pairing code: 169086
worker: disconnected (1000) — retrying in 1000ms
worker: connected
  Pairing code: 493191
worker: disconnected (1000) — retrying in 1000ms
```

A log that looks like that is two agents, not a broken network. Stop one:

```sh
sudo systemctl stop ajar-agent                                     # Linux, Raspberry Pi
launchctl unload ~/Library/LaunchAgents/ro.codebldr.ajar.plist     # Mac
docker stop ajar                                                   # Docker, NAS
```

Home Assistant: **Stop** on the add-on's page, and turn *Start on boot* off.

---

## Then either start fresh, or carry the settings across

### Fresh — simplest, and every phone pairs again

Install on the new machine with its own guide, type the intercom's password, and enter the new
pairing code in the Ajar app. Everyone else in the house pairs again too.

### Carry the settings — nobody pairs again

The whole identity of an agent is one file:

```
~/.config/ajar/agent.json
```

It holds the intercom's address and password, the device's serial number, and the agent's own
secret — the secret is what the Worker recognises. Same file, same agent, as far as everything
else is concerned.

With the old agent stopped:

```sh
# from the old machine
scp ~/.config/ajar/agent.json pi@raspberrypi.local:~/.config/ajar/agent.json
```

If the folder does not exist yet on the new machine:

```sh
# on the new machine, first
mkdir -p ~/.config/ajar
chmod 700 ~/.config/ajar
```

Then install the agent on the new machine as its guide describes, and **skip the setup** — it
only asks when something is missing. Start it, and the phones that were already paired stay
paired.

Check the file kept its permissions afterwards; it holds a password:

```sh
chmod 600 ~/.config/ajar/agent.json
ls -l ~/.config/ajar/agent.json     # -rw-------
```

### Out of a container

The same file lives in the volume:

```sh
docker cp ajar:/config/agent.json ./agent.json
```

And into one:

```sh
docker cp ./agent.json ajar:/config/agent.json
docker restart ajar
```

Home Assistant keeps it in the add-on's own configuration folder — from the SSH add-on, look in
`/addon_configs/local_ajar/agent.json`. A Supervisor backup of the add-on carries it too.

---

## Which machine to choose

| | Good for |
|---|---|
| **Raspberry Pi** | The answer for keeping it. Cheap, silent, never leaves the house. |
| **NAS** | Already on, already has Docker. Nothing extra to buy. |
| **Home Assistant** | Already on, and the add-on takes one form to fill in. |
| **A Mac or a laptop** | Trying it out. It takes the doorbell with it when it leaves. |

The requirement is only this: switched on all the time, on the same network as the intercom,
and with an outbound internet connection. The agent dials out, so there is nothing to forward
and nothing to expose.
