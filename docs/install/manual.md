# Running it by hand

No installer, no service, nothing written outside two folders. For trying it out, for a machine
whose init system is its own business, or for reading what it does before letting it near your
gate.

```sh
git clone https://github.com/codebldr/ajar-agent.git
cd ajar-agent
node agent.mjs --setup     # once, to answer the questions
node agent.mjs             # to run it
```

Node 18 or newer. Nothing to install beyond it: the agent has no dependencies, which is the
point — see the README for why.

It will not survive a reboot this way. That is the only difference from the other guides.

The pairing code is printed to the screen when it connects, and lasts ten minutes. Stop it with
`Ctrl-C` and start it again for another.

---

## The flags

```
node agent.mjs             run it
node agent.mjs --setup     ask for the intercom and the password again
node agent.mjs --discover  list the intercoms on this network, then stop
node agent.mjs --watch     print intercom events without touching the Worker
node agent.mjs --target=192.168.100.2
                           look at an address directly, for an intercom behind a second router
node agent.mjs --help      all of the above
```

`--watch` is the one worth knowing. Dahua's event codes vary by model, and this prints what
yours actually emits — press the doorbell, open the gate, and watch the names go by.

## Settings

They live in `~/.config/ajar/agent.json`, written by `--setup` and readable by you alone. That
file holds the intercom's password and the agent's own secret, which is what identifies it to
the Worker. It is the file to copy when [moving the agent](moving.md) to another machine.

Environment variables win over it, which is what containers need:

| Variable | What it does |
|---|---|
| `VTO_PASSWORD` | The intercom's own password. |
| `VTO_USERNAME` | `admin` unless yours was changed. |
| `VTO_HOST` | The intercom's address. Left out, the agent finds it. |
| `VTO_PORT` | `80` unless the intercom's web page is elsewhere. |
| `CAMERA_CHANNEL` | `1`. A second gate is `2`. |
| `RTSP_PORT` | `554`. |
| `AJAR_CONFIG` | Somewhere else to keep the settings file. |
| `RING_CODES`, `ANSWER_CODES`, `CANCEL_CODES`, `GATE_CODES` | Which intercom events mean what, comma separated. Only needed for a model whose codes differ — find them with `--watch`. |

---

## Keeping it running yourself

If your machine has systemd, the installer writes this unit for you — but here it is, for a
machine where you would rather write it:

```ini
[Unit]
Description=Ajar intercom agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/ajar/agent.mjs
User=youruser
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`User=` must be whoever answered `--setup`, or the service looks for the settings in the wrong
home folder and finds nothing.

On a NAS without systemd, its own task scheduler — Synology's Task Scheduler, QNAP's crontab —
does the same job with a *run at startup* task. [Docker](docker.md) is usually the easier route
there.

---

## When it does not work

**"No intercom answered on this network."** `node agent.mjs --discover` says what it can see.
Nothing means the machine and the intercom are on different networks. Behind a second router, a
broadcast never crosses — `--target=192.168.100.2`.

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page — not your Ajar account.

**No pairing code.** Printed once, on connecting. Restart it.

**Already running the agent elsewhere?** Stop that one first — see [moving it](moving.md).
