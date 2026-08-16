# Security

This program opens a front gate. That is the whole reason it exists and the whole reason to be
careful with it.

## Reporting something

Email **5269394+romeoonisim@users.noreply.github.com** with what you found and how to reproduce it. Please do not open
a public issue for anything that would let somebody open a gate they do not own — a house is on
the other end of it.

You will get an answer within a week. If what you found is real, you will be told when it is
fixed and credited in the release unless you would rather not be.

There is no bounty. This is one person and a doorbell.

## What the agent trusts, and what it does not

Worth reading before deciding whether something is a bug:

- **The intercom's password** is held on your own machine in `~/.config/ajar/agent.json`, mode
  `0600`, and goes nowhere else. Not to the app, not to the Worker, not to any phone.
- **Phones never learn the intercom's password.** At home they are given a key for the agent's
  own local port; away from home they never touch the intercom at all.
- **The agent dials out.** Nothing dials in, so there is no port to forward and no service of
  ours exposed to the internet. The two ports it opens — TCP 8787 and UDP 8788 — are for the
  house network, and the beacon on 8788 answers private addresses only.
- **The Worker is trusted to relay, not to decide.** It can tell the agent to open a gate, which
  is what it is for. It cannot read your intercom's password, because it does not have it.
- **A phone on the house network is not more trusted than one on the far side of the world.** The
  same short list of commands is accepted from both, and opening the gate is not on it — that
  goes through the Worker, which knows who is paired.
- **Discovery is unauthenticated, and so is every Dahua intercom on the network.** Anything on
  the wifi can answer a discovery broadcast claiming to be an intercom. The setup lists the
  address a reply came from when it differs from the one it claims, because the next question
  asks for your intercom's password.
- **A pairing code handed out over the house network joins a household; it does not take it
  over.** Ownership comes from a code read off the screen of the machine the agent runs on.
- **Removing somebody changes the house key.** The agent cuts a new one, everyone watching is
  disconnected, and the phones still entitled to it collect the new key on their next
  connection.

## Known and accepted

- **Anyone who can reach the agent on the house network can ask to pair**, and will be given a
  code that joins them to the device as a guest. Being inside the house is the claim being made,
  and it is the same claim a Dahua intercom accepts from anybody on the wifi. If your wifi
  password is shared with people you would not give a key to, this is not the tool's problem to
  solve — but it is worth knowing.
- **The intercom itself speaks plain HTTP with digest authentication**, on your local network,
  because that is all its firmware offers. Anybody already able to watch that network can see the
  digest exchange. Nothing the agent does makes this better or worse.
- **A compromised Worker could open your gate.** So could a compromised phone. What it could not
  do is learn your intercom's password.

## Installing safely

The installer is `curl … | sh`, which means trusting this repository and GitHub's TLS. If you
would rather not, clone it and read `install.sh` first — it is one file and it says what it does,
and `sh install.sh` from that clone installs what you just read rather than fetching anything.

## Dependencies

There are none, and that is deliberate. No `npm install` runs, no lockfile decides what ends up
on the machine, and no package can be taken over and turned into a way into your house. Every
line the agent runs is in this repository.
