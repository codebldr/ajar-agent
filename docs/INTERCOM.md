# The intercom, and what it actually does

Measured against a `DHI-VTO2211G-WP` on firmware `4.400.0000002.2.R`, not taken from a manual.
Dahua's behaviour varies by model and firmware, so anything here that surprises you on your own
device is worth re-measuring rather than working around.

## Running it by hand

```sh
node agent.mjs            # normal
node agent.mjs --setup    # ask everything again
node agent.mjs --discover # list what is on the network, then exit
node agent.mjs --watch    # print every event the intercom emits, and nothing else
```

`--setup` matters the day somebody changes the intercom's password. Without it the agent simply
goes quiet, and the way back is editing JSON by hand.

`--target=192.168.100.2` names an address directly, for a network the search does not reach.

Environment variables override the stored file, which is what containers need: `VTO_HOST`,
`VTO_PORT`, `VTO_USERNAME`, `VTO_PASSWORD`, `DEVICE_ID`, `WORKER_URL`, `AGENT_SECRET`,
`AJAR_CONFIG`. Set them and nothing is asked — which is also what happens when there is no
terminal to ask into.

## Finding it without being told

Dahua devices answer a broadcast on UDP 37810 with their address, model and serial number, and
they answer **without any credentials**. So the agent asks the network where the intercom is
instead of asking the person.

A broadcast dies at the first router, and in plenty of houses the intercom sits behind one — on
its own subnet, off the installer's second router, reachable but not audible. When the broadcast
comes back empty the agent asks every address instead: the networks this machine is on, then the
ranges consumer routers hand out by default. A few thousand small datagrams, sent once. Measured
across a double-NAT house, an intercom two subnets away answered in five seconds.

## Security

**The serial number was never a secret.** Anyone on the network reads it, the model and the
firmware version off that same broadcast, with no account. It is also printed on a sticker
facing the street. What protects a house is the pairing code, or reaching the agent on the
house's own network.

**The agent's secret never leaves the machine.** Generated locally; the Worker keeps only its
SHA-256 hash. A leak of the Worker's storage does not let anyone speak for a house.

**First agent to connect claims the device.** After that the same secret is required. Moving to
new hardware means removing the device in the app first, which needs an owner's phone.

**Pairing codes are rate limited.** Five wrong codes lock a device out for fifteen minutes and
burn the current code. Restarting the agent lifts the lockout immediately — that needs access to
the machine, a stronger claim than the code itself, so somebody else's guessing never leaves the
owner locked out. A second limit counts attempts per source address, so nobody can work through
serial numbers from one place.

**Give the agent its own intercom account.** It needs to open doors and read events, not to
administer the device. The agent authenticates as whatever `username` says, so `admin` is a
default rather than a requirement. If the config file is ever stolen, the damage stops at the
gate rather than the whole intercom.

**Anyone who can reach the machine can open the gate.** There is no way around this: the agent
exists to open gates and holds what it needs to do so. Treat the host the way you treat a key.

**No dependencies, on purpose.** Nothing is installed from npm, which removes the most common
way small tools get compromised. Worth keeping.

## Event codes

The codes that matter were found rather than assumed. `--watch` skips the Worker and prints
everything the intercom emits; press the doorbell, read the code, set the variable.

| Variable | Default | Meaning |
|---|---|---|
| `RING_CODES` | `Invite,VideoTalkCall,CallNoAnswered,DoorBell` | someone is at the gate |
| `ANSWER_CODES` | `RequestCallState,Answer,TalkStart` | someone picked up |
| `CANCEL_CODES` | `_CallNoAnswer_,PassiveHungup,Hangup,CallDeny,TalkEnd,CallEnd` | the call is over |
| `GATE_CODES` | `AccessControl,DoorStatus,DoorUnlock` | the gate opened |

### What this device actually emits

One press, answered from the manufacturer's app, gate opened during the call:

```
CallNoAnswered    Start     doorbell pressed
Invite            Pulse     five milliseconds later — the same press
RequestCallState  Start     when the call was picked up, but see below
AccessControl     Pulse     gate opened, during the call
PassiveHungup     Start     the other end hung up
```

An unanswered press ends with `_CallNoAnswer_` thirty seconds later, to the millisecond across
repeats.

`RequestCallState` reads like a client merely asking for the call state, so it was checked
before being trusted: a ring that reached a phone as a notification but was never answered
produced `CallNoAnswered`, `Invite` and `_CallNoAnswer_` and nothing else. The code only appears
when somebody picks up, so it is treated as the answer.

One narrower case is still untested: opening the app to look at the camera without answering. If
that emits the same code, the other phones would stop ringing while one person is only looking.
Worth confirming before release.

## Channel numbering

Channels start at one. `channel=1` is the first gate, `channel=2` the second; `channel=0` is
rejected outright, which is how the numbering was settled. On the tested intercom, channel 1 is
the pedestrian gate.

## Speaking to the gate

Not the audio endpoint, and not a call. `audio.cgi?action=postAudio` reaches the speaker only
while a call is up, and every way of starting one rings every screen in the house and plays its
own ringback over whoever is talking.

The answer is the **ONVIF backchannel**. Ask for it in `DESCRIBE` with
`Require: www.onvif.org/ver20/backchannel` and the SDP gains a third track — `trackID=5`,
`a=sendonly`, `L16/16000`. `SETUP` it, `PLAY`, then write interleaved RTP with **big-endian**
samples, because L16 is network order. Nothing rings, and the speaker plays while the intercom
sits idle.

Two details that cost an evening: `SETUP` wants the track appended with a **slash** —
`…subtype=1/trackID=5`, not `&` — or the camera answers `451 Parameter Not Understood`. And the
camera **ignores the interleaved channels you ask for**; it answered `10-11` here, so read them
back from the `Transport` header or the audio goes nowhere.

## Where the agent should live

Anything always on that sits on the intercom's network: a Raspberry Pi, an old phone, a machine
that never sleeps. A laptop works for testing and stops answering the doorbell when its lid
closes.
