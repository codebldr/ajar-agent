# Installing on a Mac

Good for trying it out on a machine you already have. Less good for keeping it: a laptop that
goes to a café takes the doorbell with it, and a Mac asleep answers nobody. A Mac mini that
never moves is a fine permanent home; a MacBook is not. See [raspberry-pi.md](raspberry-pi.md)
when you are ready to move it.

**Before you start:** the intercom's password — the one its own web page asks for — and the Mac
on the same network as the intercom.

---

## 1. Node, version 18 or newer

```sh
node --version
```

Nothing, or below 18:

```sh
brew install node
```

No Homebrew? The installer at [nodejs.org](https://nodejs.org) does the same job.

## 2. Install the agent

```sh
curl -fsSL https://raw.githubusercontent.com/romeoonisim/ajar-agent/main/install.sh | sh
```

No `sudo`. It installs into `~/.local/share/ajar` and registers a login item, so the agent
starts with the Mac.

## 3. Answer two questions

```
Looking for intercoms on this network…

  1. DHI-VTO2211G-WP  192.168.100.2  7B00D79PAJ0702C

Intercom username [admin]: 
Intercom password: 
Checking the account… yes.
```

Enter for `admin`, then the intercom's password. It is checked against the intercom immediately,
so a wrong one is a sentence on screen rather than a doorbell that never rings.

## 4. Read the pairing code

```sh
tail -f ~/Library/Logs/ajar-agent.log
```

```
  Pairing code: 169086
  Enter it in the Ajar app within 10 minutes.
```

Six digits into the Ajar app. `Ctrl-C` stops watching the log, not the agent.

---

## Living with it

```sh
tail -f ~/Library/Logs/ajar-agent.log                              # watch it
launchctl unload ~/Library/LaunchAgents/ro.codebldr.ajar.plist     # stop it
launchctl load ~/Library/LaunchAgents/ro.codebldr.ajar.plist       # start it, new pairing code
node ~/.local/share/ajar/agent.mjs --setup                         # change intercom or password
```

**Sleep stops it.** *System Settings → Battery / Energy Saver* → prevent sleep when plugged in,
or the doorbell only reaches your phone while the lid is open.

**macOS will ask for permission** to accept incoming connections the first time — that is your
phone reaching the agent on the house wifi. Allow it, or the app falls back to the long way
round and the camera is slower at home than away.

**To remove it:**

```sh
launchctl unload ~/Library/LaunchAgents/ro.codebldr.ajar.plist
rm ~/Library/LaunchAgents/ro.codebldr.ajar.plist
rm -rf ~/.local/share/ajar ~/.config/ajar
```

---

## When it does not work

**"No intercom answered on this network."** See what it can find:

```sh
node ~/.local/share/ajar/agent.mjs --discover
```

Nothing listed means the Mac is on a different network from the intercom — a guest wifi, or a
second access point that does not bridge. If the intercom is behind another router, name it:

```sh
node ~/.local/share/ajar/agent.mjs --setup --target=192.168.100.2
```

**"The intercom refused that username and password."** That account is the intercom's own — the
one that opens its web page — not your Ajar account. `--setup` asks again.

**The doorbell rings at the gate but not on the phone.** Dahua's event codes vary by model. Stop
the agent, then `node ~/.local/share/ajar/agent.mjs --watch` and press the doorbell.
[Open an issue][issues] with what it printed.

**Do not use Docker Desktop for this.** Its containers live in a virtual machine with a network
of their own, so the agent cannot see the intercom and your phone cannot see the agent.

**Already running the agent on another machine?** Stop that one first — see
[moving it](moving.md). Two agents on one intercom knock each other off in a loop.

[issues]: https://github.com/romeoonisim/ajar-agent/issues
