# Installing on a Synology, from Package Center

The simplest way onto a Synology: a package, installed like any other, with one question — the
intercom's password. No Docker, so it is also meant for the models without it, the "j" series
included — wherever Package Center offers Node.js, which the package uses.

> **Beta.** The package is new and has not yet been through every DSM version. If something on
> your screen does not match this page, [open an issue][issues] with a screenshot.

**You need:**

- DSM 7.0 or newer.
- The intercom's password — the one its own web page asks for. Not your Ajar account.
- The NAS on the same network as the intercom.
- No other Ajar agent running for the same intercom — a Raspberry Pi, a Docker container, a Mac.
  Two agents on one intercom knock each other off in a loop. See [moving it](moving.md).

---

## 1. Download the package

From the [latest release][releases], download `ajar-….spk` — there is one file, for every
Synology.

## 2. Install it

1. **Package Center** → **Manual Install** (top right) → choose the `.spk` → **Next**.
2. DSM warns that the package is from a third party. **Agree** — it is ours, and it is not
   distributed through Synology yet.
3. If Node.js is not installed, Package Center installs it as well. Let it.
4. **Intercom password**: type it. Leave **Intercom address** empty.
5. **Next** → **Done**.

## 3. Add it to your phone

Open the **Ajar** app on a phone on your home Wi-Fi → **Add device**. It finds the intercom by
itself → **Add it**. That is all.

The first phone added runs the house. To add the rest of the family, use **Share** in that
phone's app.

---

## Later

**Updating.** Download the new `.spk` and install it the same way, over the old one. Nothing is
asked again; your settings stay.

**The intercom's password changed.** Package Center → Ajar → **Uninstall**, then install the
`.spk` again: the wizard asks for the password again, and only that changes. The `ajar` folder
stays, so the phone stays paired.

**Where things are.** Ajar keeps its settings and the recordings of your visits in a shared folder
called `ajar`. It stays when the package is uninstalled, so a reinstall carries on as the same
agent with nothing to pair again. Delete the folder in File Station only if you are done with Ajar
for good — after removing the device in the app.

---

## When it does not work

**Package Center → Ajar → View log** shows what the agent is doing.

**The app does not find the intercom.** The phone is probably on a different Wi-Fi than the NAS.
Either move it to the NAS's Wi-Fi, or pair with a code: in the app choose **Enter serial
manually**, then type the serial and the **six-digit code** from the log (`Pairing code: …`).
The code lasts ten minutes; **Stop** and **Run** the package for a new one.

**"No intercom answered on this network."** The agent looks on its own network and then on the
addresses home routers usually hand out. If it still finds nothing, the intercom is on an unusual
address: find it in your router's list of connected devices, then uninstall and install the
`.spk` again, typing it into **Intercom address**.

**"The intercom refused the account."** The password is not the intercom's — check it by opening
the intercom's own web page with it, then uninstall and install the `.spk` again with the right
one.

**"Node.js is not installed."** Package Center → search **Node.js** → install **Node.js v22** →
**Run** Ajar again.

[releases]: https://github.com/codebldr/ajar-agent/releases/latest
[issues]: https://github.com/codebldr/ajar-agent/issues
