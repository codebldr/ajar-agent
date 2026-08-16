# Installing on a Raspberry Pi

Also Ubuntu, Debian, or any Linux machine with systemd. Fifteen minutes, most of it the Pi
writing its own card.

A Pi is the machine this was built for: it costs little, draws less power than the intercom
itself, and it is never away from the house when the doorbell rings.

**Before you start:**

- The intercom's password — the one its own web page asks for. Not your Ajar account, not the
  manufacturer's app account.
- The Pi on the **same network as the intercom**, ideally on a cable.
- Raspberry Pi OS, or any Linux. A Pi 3 is plenty; a Pi Zero 2 W works.

---

## 1. Node, version 18 or newer

```sh
node --version
```

If that prints nothing, or a number below 18:

```sh
sudo apt update
sudo apt install -y nodejs
```

Check it again. If your Raspberry Pi OS is old enough to ship Node 12,
[NodeSource](https://github.com/nodesource/distributions) has current builds:

```sh
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

The Ajar installer will not install Node for you, on purpose. Every one of these machines has
its own idea of where software comes from, and a script that guesses wrong leaves you with two
copies of Node and no idea which one is running your gate.

## 2. Install the agent

```sh
curl -fsSL https://raw.githubusercontent.com/romeoonisim/ajar-agent/main/install.sh | sudo sh
```

It puts the agent in `/opt/ajar`, asks its questions, and installs a service called
`ajar-agent` so it comes back by itself after a power cut.

Without `sudo` it still installs and runs — into your home folder — but there is no service, so
it stops when you log out and does not return after a reboot. On a Pi that sits in a cupboard,
use `sudo`.

## 3. Answer two questions

The installer searches the network and shows what it found:

```
Looking for intercoms on this network…

  1. DHI-VTO2211G-WP  192.168.100.2  7B00D79PAJ0702C

Intercom username [admin]: 
Intercom password: 
Checking the account… yes.

Saved to /home/pi/.config/ajar/agent.json
```

Press enter for `admin`, then type the intercom's password. It is checked against the intercom
there and then, so a wrong one is a sentence on screen rather than a doorbell that never rings.
Nothing else is asked — the address, the model and the serial number all come off the wire.

Only if more than one intercom answers does it ask **which one**.

If it finds nothing, see [when it does not work](#when-it-does-not-work) below.

## 4. Read the pairing code

```sh
sudo journalctl -u ajar-agent -f
```

Among the first lines:

```
  Pairing code: 169086
  Enter it in the Ajar app within 10 minutes.
```

Type those six digits into the Ajar app, and the gate is on your phone. `Ctrl-C` stops watching
the log; it does not stop the agent.

Missed it, or the ten minutes ran out:

```sh
sudo systemctl restart ajar-agent
```

A new code is printed each time it connects.

---

## Living with it

```sh
sudo systemctl status ajar-agent      # is it running
sudo systemctl restart ajar-agent     # restart, and print a new pairing code
sudo systemctl stop ajar-agent        # stop it
sudo journalctl -u ajar-agent -f      # watch it work
sudo journalctl -u ajar-agent -n 200  # the last 200 lines
```

**When the intercom's password changes**, or you point it at a different intercom:

```sh
node /opt/ajar/agent.mjs --setup
sudo systemctl restart ajar-agent
```

**To update:** run the install command again. Your settings are kept — they live in
`~/.config/ajar/agent.json`, not in `/opt/ajar`.

**To remove it entirely:**

```sh
sudo systemctl disable --now ajar-agent
sudo rm /etc/systemd/system/ajar-agent.service
sudo rm -rf /opt/ajar
rm -rf ~/.config/ajar
```

---

## When it does not work

**"No intercom answered on this network."** The Pi and the intercom are not on the same network.
See what the Pi can see:

```sh
node /opt/ajar/agent.mjs --discover
```

If the intercom sits behind a second router, a broadcast never crosses it — give the address
directly:

```sh
node /opt/ajar/agent.mjs --setup --target=192.168.100.2
```

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page at `http://192.168.x.x`. The username is `admin` on almost all of
them; `node /opt/ajar/agent.mjs --setup` asks again.

**The service will not start.** `sudo journalctl -u ajar-agent -n 50` says why. The usual cause
is a setup that was never finished, which shows as the agent asking questions nobody can answer.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model. Stop
the service, then:

```sh
sudo systemctl stop ajar-agent
node /opt/ajar/agent.mjs --watch
```

Press the doorbell and see what it prints. Those codes are settings, not code — `RING_CODES`,
`ANSWER_CODES`, `CANCEL_CODES`, `GATE_CODES`. [Open an issue][issues] with what you saw and it
will be built in.

**Already running the agent on another machine?** Stop that one first — see
[moving it](moving.md). Two agents on one intercom knock each other off in a loop.

[issues]: https://github.com/romeoonisim/ajar-agent/issues
