// The Ajar home agent.
//
// It sits on the intercom's own network and dials out to the Worker, so nothing at the
// house is reachable from the internet — no port forwarding, no exposed intercom.
//
// Three jobs:
//   1. Hold the intercom's event channel open and report a doorbell press upward.
//   2. Take gate commands from the Worker and press the relay.
//   3. Relay the gate camera while somebody away from the house is watching it.
//
//   VTO_HOST=192.168.100.2 VTO_PASSWORD=... DEVICE_ID=... \
//   WORKER_URL=https://ajar-api.example.workers.dev AGENT_SECRET=... node agent.mjs
//
// `--watch` skips the Worker entirely and just prints intercom events, which is how the
// doorbell's own event code was identified.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'

import { openBackchannel } from './backchannel.mjs'
import { Rpc } from './rpc.mjs'
import { digestGet } from './digest.mjs'
import { discover, isIntercom } from './discover.mjs'
import { History } from './history.mjs'
import { IntercomRecords, merge } from './records.mjs'
import { LocalServer, LOCAL_PORT, localAddresses, startBeacon } from './local.mjs'
import { openStream } from './rtsp.mjs'
import { WebSocketClient as WebSocket } from './ws.mjs'

/**
 * Where the Worker lives. Built in rather than asked for: it is the same address for every
 * house, and a question with one right answer is a question that should not be asked.
 */
const DEFAULT_WORKER_URL = 'https://ajar-api.codebldr.workers.dev'

/**
 * Settings live in a file rather than the environment because the intercom password would
 * otherwise sit in shell history and in the process list, where anyone on the machine can
 * read it. Environment variables still win when set, which is what containers need.
 */
const CONFIG_PATH =
  process.env.AJAR_CONFIG ?? join(homedir(), '.config', 'ajar', 'agent.json')

/**
 * Where visits are kept: the index, the clips, the pictures.
 *
 * Beside the settings by default, which puts it in the right place on every installation
 * without asking — a Pi writes to its own card, and a container writes to the folder its owner
 * already mounted for the settings, which on a NAS is the big disk. Home Assistant is the one
 * that needs telling: its add-on config folder is swept into every backup, so the add-on points
 * this at `/media` instead, where large files belong and where Home Assistant can play them.
 */
const DATA_PATH = process.env.AJAR_DATA ?? join(dirname(CONFIG_PATH), 'history')

const stored = readConfigFile(CONFIG_PATH)

const config = {
  host: process.env.VTO_HOST ?? stored.host ?? '',
  port: Number(process.env.VTO_PORT ?? stored.port ?? 80),
  username: process.env.VTO_USERNAME ?? stored.username ?? 'admin',
  password: process.env.VTO_PASSWORD ?? stored.password ?? '',
  deviceId: process.env.DEVICE_ID ?? stored.deviceId ?? '',
  workerUrl: process.env.WORKER_URL ?? stored.workerUrl ?? DEFAULT_WORKER_URL,
  agentSecret: process.env.AGENT_SECRET ?? stored.agentSecret ?? '',
  /** What a phone on the house network shows to be let at the camera. */
  localKey: stored.localKey ?? '',
  rtspPort: Number(process.env.RTSP_PORT ?? stored.rtspPort ?? 554),
  cameraChannel: Number(process.env.CAMERA_CHANNEL ?? stored.cameraChannel ?? 1),

  // Set from the app rather than here, and kept so a restart does not forget what was chosen.
  // The environment still wins, which is what the Home Assistant add-on needs: its own form is
  // where those users expect to find settings, and it passes them in this way.
  historyEnabled: envFlag(process.env.HISTORY_ENABLED) ?? stored.historyEnabled ?? true,
  historySeconds: Number(process.env.HISTORY_SECONDS ?? stored.historySeconds ?? 0) || null,
  historyMaxBytes: Number(process.env.HISTORY_MAX_MB ?? 0) * 1024 * 1024 ||
    stored.historyMaxBytes ||
    null,
  /**
   * Which stream recordings are made from — `sd` or `hd`.
   *
   * Small by default. It is a quarter of the picture and an eighth of the disk, and for the
   * question a doorbell recording usually answers — was that the courier, did they leave it by
   * the gate — it is enough. A household that wants to read a face turns it up.
   */
  historyQuality: process.env.HISTORY_QUALITY ?? stored.historyQuality ?? 'sd',
}

/** `HISTORY_ENABLED=false` should mean false, which `Boolean('false')` does not. */
function envFlag(value) {
  if (value === undefined) return null
  return !/^(0|false|no|off)$/i.test(value.trim())
}

/**
 * Two streams, and the difference matters to whoever is paying for the data: the substream is
 * 352x288 at 256 kbps, the main one 1280x720 at 2 Mbps. Eight times the traffic for a picture
 * that usually only has to answer "who is that".
 */
const STREAM_SUBTYPE = { sd: 1, hd: 0 }

const streamPath = (quality) =>
  `/cam/realmonitor?channel=${config.cameraChannel}&subtype=${STREAM_SUBTYPE[quality] ?? 1}`

function readConfigFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No file yet, or not readable. Environment variables may still supply everything.
    return {}
  }
}

/**
 * Merges into whatever is on disk rather than over it. Setup and the secret are written at
 * different moments, and the second write must not lose the first.
 */
function writeConfig(patch) {
  const current = readConfigFile(CONFIG_PATH)

  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...patch }, null, 2), {
    mode: 0o600,
  })
  chmodSync(CONFIG_PATH, 0o600)
}

/**
 * The secret is generated here and never travels except to the Worker, which stores only its
 * hash. The first agent to present one for a device claims it; nobody else can take it
 * afterwards without an owner removing the device from the app.
 */
function ensureAgentSecret() {
  if (config.agentSecret) return

  config.agentSecret = randomBytes(32).toString('base64url')
  writeConfig({ agentSecret: config.agentSecret })

  log(`generated a new agent secret, saved to ${CONFIG_PATH}`)
}

/**
 * The house network server, once it exists.
 *
 * Held here rather than passed around because the Worker link is built before it and still has
 * to reach it: a key rotation arrives on that socket and has to change the lock on this one.
 */
let localServer = null

/**
 * The connection out to the Worker, once it exists.
 *
 * Module scope for the same reason as the server above: a phone on the house network can ask
 * for something that has to travel upward — a test ring — and the handler for that runs long
 * before `main` has finished building anything.
 */
let link = null

/**
 * Kept across restarts rather than minted per run: a phone holding yesterday's key would be
 * turned away at the door of a house it is still paired with, for no reason it could see.
 *
 * Replaced only when somebody is removed from the device — see `rotate-local-key`.
 */
function ensureLocalKey() {
  if (config.localKey) return
  config.localKey = randomBytes(32).toString('base64url')
  writeConfig({ localKey: config.localKey })
}

/**
 * Whether somebody knows the intercom's own admin password.
 *
 * The question behind a phone on the house wifi asking to run the household. Everyone in the
 * building can reach this machine; only the household knows what is typed into the intercom's
 * own web page, and it is a thing they can find without an SSH client.
 *
 * The password on file is checked first, and not to save a round trip: the intercom locks itself
 * out after a handful of wrong answers, and a household that got its own password right should
 * never be able to lock its front door against itself by typing it twice. Anything else is put
 * to the device, which is the only authority on the subject — and a password that works there
 * and not here means somebody changed it, so it is kept. Without that the agent goes deaf on
 * its next reconnect, which is the fault this whole path exists to undo.
 */
async function intercomAccepts(password) {
  if (!password) return false
  if (sameSecret(password, config.password)) return true
  if (!config.host) return false

  try {
    await digestGet({
      host: config.host,
      port: config.port,
      username: config.username,
      password,
      path: '/cgi-bin/magicBox.cgi?action=getSerialNo',
      timeoutMs: 6_000,
    })
  } catch {
    return false
  }

  config.password = password
  writeConfig({ password })
  log('the intercom accepted a password this agent did not have; keeping it')

  return true
}

/** Compared without letting the time it takes say how much of it was right. */
function sameSecret(offered, known) {
  const a = Buffer.from(String(offered), 'utf8')
  const b = Buffer.from(String(known ?? ''), 'utf8')
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

const watchOnly = process.argv.includes('--watch')
const discoverOnly = process.argv.includes('--discover')

/**
 * Asks again even when everything is already answered.
 *
 * Needed the day somebody changes the intercom's password: without it the agent simply goes
 * quiet, and the only way back is editing a JSON file by hand — which is not a thing to ask
 * of the person whose doorbell has stopped working.
 */
const forceSetup = process.argv.includes('--setup')

/**
 * An address to ask directly, for the house whose intercom sits behind a second router. A
 * broadcast never crosses that boundary; a packet addressed at the device still does.
 */
const explicitTargets = process.argv
  .filter((argument) => argument.startsWith('--target='))
  .map((argument) => argument.slice('--target='.length))
  .filter(Boolean)

/**
 * Printed rather than pointed at a manual, because the moment somebody needs this is the moment
 * they are on a NAS over SSH with no browser to hand.
 */
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Ajar agent — your Dahua intercom, on your phone, from anywhere.

  node agent.mjs             run it
  node agent.mjs --setup     ask for the intercom and the password again
  node agent.mjs --discover  list the intercoms on this network, then stop
  node agent.mjs --watch     print intercom events without touching the Worker
  node agent.mjs --target=192.168.1.50
                             look at an address directly, for an intercom behind a second router

Settings live in ${CONFIG_PATH}, readable by you alone. Environment variables win over it:
VTO_HOST, VTO_PORT, VTO_USERNAME, VTO_PASSWORD, DEVICE_ID, WORKER_URL, AGENT_SECRET,
RTSP_PORT, CAMERA_CHANNEL, AJAR_CONFIG.

The six-digit pairing code is printed when the agent connects. It lasts ten minutes; restart
the agent for another. Installing: https://github.com/codebldr/ajar-agent`)
  process.exit(0)
}

/**
 * Which intercom events mean what. Dahua's codes vary by model and firmware, so these are
 * overridable without touching code — run `--watch`, press the button, and set what shows.
 */
const codes = {
  // A single press emits `CallNoAnswered` and `Invite` six milliseconds apart. Both are
  // listed because either one alone would be enough, and the Worker collapses the pair
  // into one call anyway.
  ring: split(process.env.RING_CODES, ['Invite', 'VideoTalkCall', 'CallNoAnswered', 'DoorBell']),
  // `RequestCallState` fires when a call is picked up. It is not merely the app showing the
  // call: an unanswered ring that did reach the phone as a notification never produced it.
  answered: split(process.env.ANSWER_CODES, ['RequestCallState', 'Answer', 'TalkStart']),
  // `_CallNoAnswer_` arrives thirty seconds after an unanswered press — the intercom giving
  // up. Without it the phones would keep ringing until the Worker's own timeout.
  // `PassiveHungup` is the peer hanging up — confirmed on a real call answered from DMSS.
  cancelled: split(process.env.CANCEL_CODES, [
    '_CallNoAnswer_',
    'PassiveHungup',
    'Hangup',
    'CallDeny',
    'TalkEnd',
    'CallEnd',
  ]),
  gateOpened: split(process.env.GATE_CODES, ['AccessControl', 'DoorStatus', 'DoorUnlock']),
}

function split(value, fallback) {
  const parsed = (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : fallback
}

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

// ── Intercom ─────────────────────────────────────────────────────────────

/**
 * Presses the relay. Channels are numbered from one: `1` is the first gate, `2` the second.
 * Channel `0` is rejected outright by the intercom, which is how the numbering was settled.
 */
async function openDoor(channel) {
  const path =
    `/cgi-bin/accessControl.cgi?action=openDoor` +
    `&channel=${encodeURIComponent(channel)}&UserID=101&Type=Remote`

  const body = await digestGet({ ...config, path, timeoutMs: 6_000 })

  // The intercom answers `OK` on success and `Error` with a reason on failure.
  if (!/\bOK\b/i.test(body)) {
    throw new Error(body.trim().split('\n')[0] || 'Intercom refused the command')
  }
}

/**
 * Asks the intercom what shape its picture really is.
 *
 * The substream is stored as 352x288 but covers the same view as the 1280x720 main stream,
 * so it is squeezed rather than cropped — and the encoder does not say so anywhere in the
 * stream itself. Shown at its stored size, everyone in it looks tall and thin. The main
 * stream's own resolution is the honest answer, so it is read once and passed to the phone.
 */
async function cameraAspect() {
  try {
    const body = await digestGet({
      ...config,
      path: '/cgi-bin/configManager.cgi?action=getConfig&name=Encode',
      timeoutMs: 6_000,
    })

    const width = Number(/MainFormat\[0\]\.Video\.Width=(\d+)/.exec(body)?.[1])
    const height = Number(/MainFormat\[0\]\.Video\.Height=(\d+)/.exec(body)?.[1])

    if (width > 0 && height > 0) return width / height
  } catch (error) {
    log(`camera: could not read the picture shape — ${error.message}`)
  }
  return null
}

/**
 * One still picture from the gate, as JPEG.
 *
 * The intercom draws this itself and hands it over in about a fifth of a second, which is the
 * cheap way to a thumbnail: pulling one out of the video would mean decoding H.264 here, and
 * this agent's whole approach to video is to never decode any of it.
 */
async function gateSnapshot() {
  const chunks = []

  await digestGet({
    ...config,
    path: `/cgi-bin/snapshot.cgi?channel=${config.cameraChannel}`,
    timeoutMs: 6_000,
    onStream: (response) =>
      new Promise((resolve, reject) => {
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
          // A picture this large is not a picture. Half a megabyte is already four times what
          // this camera sends.
          if (bytes > 2 * 1024 * 1024) {
            response.destroy()
            reject(new Error('the picture was larger than it should be'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', resolve)
        response.on('error', reject)
      }),
  })

  const image = Buffer.concat(chunks)
  // JPEGs start with these two bytes. Anything else is an error page.
  if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error('that was not a picture')
  return image
}

/**
 * Holds the event channel open and calls back for every event. The intercom sends a
 * multipart stream that never ends, so this only returns when the connection breaks.
 */
function attachEvents(onEvent, signal) {
  const path = '/cgi-bin/eventManager.cgi?action=attach&codes=%5BAll%5D'

  return digestGet({
    ...config,
    path,
    signal,
    timeoutMs: 15_000,
    onStream: (response) =>
      new Promise((resolve, reject) => {
        let buffer = ''
        response.setEncoding('utf8')

        response.on('data', (chunk) => {
          buffer += chunk

          // Events are line oriented inside the multipart envelope; the boundary and
          // headers are noise here, so anything without a Code= is skipped.
          let newline
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line.startsWith('Code=')) onEvent(parseEvent(line))
          }
        })

        response.on('end', () => reject(new Error('Event channel closed by the intercom')))
        response.on('error', reject)
        signal?.addEventListener('abort', () => {
          response.destroy()
          resolve()
        })
      }),
  })
}

/** `Code=Invite;action=Start;index=0;data={...}` */
function parseEvent(line) {
  const event = { code: '', action: '', index: '', raw: line }
  const dataAt = line.indexOf(';data=')
  const head = dataAt === -1 ? line : line.slice(0, dataAt)

  for (const pair of head.split(';')) {
    const equals = pair.indexOf('=')
    if (equals === -1) continue
    const key = pair.slice(0, equals).trim().toLowerCase()
    const value = pair.slice(equals + 1).trim()
    if (key === 'code') event.code = value
    else if (key === 'action') event.action = value
    else if (key === 'index') event.index = value
  }

  if (dataAt !== -1) {
    try {
      event.data = JSON.parse(line.slice(dataAt + 6))
    } catch {
      // Some firmware splits the JSON across chunks. The code and action are what drive
      // decisions here, so a partial payload is not worth failing over.
    }
  }

  return event
}

// ── Worker link ──────────────────────────────────────────────────────────

class WorkerLink {
  #socket = null
  #backoffMs = 1_000
  #closed = false
  /** Whoever is waiting on a pairing code right now. See `requestPairingCode`. */
  #pairWaiting = []
  /** This link, seen as one viewer among however many the house network is carrying. */
  #sink = {
    send: (payload) => this.send(payload),
    sendBinary: (chunk) => this.sendBinary(chunk),
  }

  connect() {
    if (this.#closed) return

    const url = `${config.workerUrl.replace(/\/$/, '')}/v1/agent?deviceId=${encodeURIComponent(config.deviceId)}`
    const wsUrl = url.replace(/^http/, 'ws')

    log(`worker: connecting to ${wsUrl}`)

    // The secret rides as a subprotocol rather than in the URL, which keeps it out of
    // request logs on the way up.
    const socket = new WebSocket(wsUrl, ['ajar-agent', config.agentSecret])
    // Voices arrive as binary; without this they would turn up as blobs needing a round trip
    // through a promise before they could be written to the gate.
    socket.binaryType = 'arraybuffer'
    this.#socket = socket

    // Whichever of the two paths below runs first wins. Without this a stalled socket that
    // later fired `close` would start a second connection alongside the replacement.
    let retried = false
    const retryOnce = () => {
      if (retried) return
      retried = true
      this.#retry()
    }

    // A connection that neither opens nor fails leaves the agent silent for as long as it
    // lasts, with no doorbell reaching anyone and nothing in the log to say why. Seen once
    // in testing, which is once more than a doorbell can afford.
    const handshake = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) return
      log('worker: handshake stalled, starting over')
      // A stalled socket may never fire `close` either, so the retry does not wait for it.
      socket.close()
      retryOnce()
    }, HANDSHAKE_TIMEOUT_MS)

    socket.addEventListener('open', () => {
      clearTimeout(handshake)
      this.#backoffMs = 1_000
      log('worker: connected')

      // Where to find this machine on the house network, and what to say at the door. The
      // Worker passes both only to phones already paired with this device, so a phone at
      // home can take the short way to the camera instead of paying for the long one.
      this.#announceLocal()
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        // Everything binary on this socket is somebody talking; the first byte says so and
        // the rest goes straight to the gate.
        const chunk = Buffer.from(event.data)
        if (chunk.length > 1 && chunk[0] === FRAME_TALK) {
          talkback.write(chunk.subarray(1))
        }
        return
      }
      // Parsed inside the try because this runs on the socket's own data event: anything that
      // throws here is an uncaught exception, and an uncaught exception is a doorbell that
      // stops working until somebody notices. One malformed frame is not worth the house.
      try {
        void this.#handle(JSON.parse(event.data))
      } catch (error) {
        log(`worker: ignoring a message that made no sense — ${error.message}`)
      }
    })

    socket.addEventListener('close', (event) => {
      clearTimeout(handshake)
      log(`worker: disconnected (${event.code}) — retrying in ${this.#backoffMs}ms`)
      // Whoever was watching through the Worker cannot see anything now, and the reconnect
      // will be told again if they are still there. Somebody watching from the house network
      // is unaffected, which is the point of that path existing. A voice cut off mid-sentence
      // must not leave the gate holding an open channel either.
      audience.remove(this.#sink)
      talkback.stop()
      retryOnce()
    })

    // A failed connection also fires `close`, so the retry lives there only.
    socket.addEventListener('error', () => {})
  }

  #retry() {
    if (this.#closed) return
    setTimeout(() => this.connect(), this.#backoffMs)
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000)
  }

  /**
   * Asks the Worker for a code, for handing to a phone that reached this machine over the
   * house network.
   *
   * That phone has proved something a code read off a screen cannot prove: it is inside the
   * house. Passing it a code is how that proof is turned into something the Worker will accept,
   * without teaching the Worker a second way to trust anybody.
   */
  requestPairingCode(via = 'local') {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected to the server'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pairWaiting = this.#pairWaiting.filter((waiter) => waiter.timer !== timer)
        reject(new Error('the server did not answer'))
      }, PAIR_REQUEST_TIMEOUT_MS)

      this.#pairWaiting.push({ resolve, timer })
      // Said out loud, because the Worker treats the two claims differently. `local` means a
      // phone that reached this machine across the house network and nothing more, and joins a
      // household as somebody waiting to be let in. Anything else means a claim the wifi cannot
      // make — a code read off this machine's own screen, or the intercom's admin password
      // proved against the intercom — and becomes an admin.
      this.send({ type: 'pair-request', via })
    })
  }

  async #handle(message) {
    if (message.type === 'pairing') {
      const waiting = this.#pairWaiting
      this.#pairWaiting = []

      // Asked for by a phone rather than by whoever is reading this log: handed over, and not
      // printed. A code on its way to one phone is not news for everybody with log access.
      if (waiting.length > 0) {
        waiting.forEach(({ resolve, timer }) => {
          clearTimeout(timer)
          resolve(message.code)
        })
        return
      }

      console.log(
        `\n  Pairing code: ${message.code}` +
          `\n  Enter it in the Ajar app within ${Math.round(message.expiresInSec / 60)} minutes.\n`
      )
      return
    }

    // Somebody picked up in the app. Hanging up at the intercom is what frees the gate
    // speaker for them to be heard through, and what stops every other screen in the house
    // ringing — the two halves of what answering means.
    if (message.type === 'call-answered') {
      // Written down before the hanging up, because hanging up is what ends the visit and the
      // note belongs to the visit it happened in.
      history.noteAnswered(message.by)
      if (callInProgress) await endCallAtGate()
      return
    }

    // Somebody was removed from this device, or it changed hands. The key that gets a phone in
    // over the house network is replaced, because revoking upstairs cannot reach a phone that
    // already holds it — nothing upstairs stands between that phone and this machine.
    if (message.type === 'rotate-local-key') {
      this.#rekeyLocal()
      return
    }

    if (message.type === 'stream-start') {
      audience.add(this.#sink)
      return
    }

    if (message.type === 'stream-stop') {
      audience.remove(this.#sink)
      return
    }

    if (message.type === 'stream-quality') {
      camera.setQuality(message.quality)
      return
    }

    if (message.type === 'talk-start') {
      await talkback.start()
      return
    }

    if (message.type === 'talk-stop') {
      talkback.stop()
      return
    }

    // How long to record and how much room to use. Only through the Worker, and only from the
    // phone it says owns this house: a guest may watch the gate and open it, and neither of
    // those quietly deletes six months of what the household remembers.
    //
    // A phone at home talks straight to this machine over the house network, where every key
    // holder looks the same — so the app sends this the long way round even from the hallway,
    // and this end simply does not offer it on the short one.
    if (message.type === 'history-configure') {
      if (message.role !== 'owner') {
        log('history: refused a settings change that did not come from the owner')
        return
      }
      const settings = history.configure(message.settings ?? {})
      this.#sink.send({ type: 'history-settings', reqId: message.reqId, settings })
      return
    }

    // Everything else the history screen asks for.
    //
    // The same handler as a phone on the house network uses, given a way back that stamps the
    // Worker's question id onto whatever it answers — one socket carries every phone's
    // questions, and the id is what tells their answers apart at the other end.
    if (message.type?.startsWith('history-')) {
      const sink = this.#sink
      const reqId = message.reqId
      await handleViewerMessage(message, {
        send: (payload) => sink.send(reqId ? { ...payload, reqId } : payload),
        sendBinary: (chunk) => sink.sendBinary(chunk),
      })
      return
    }

    if (message.type !== 'open') return

    const startedAt = Date.now()
    // Claimed before the relay is pressed rather than after: the intercom has reported the
    // opening in as little as 65 milliseconds, which is sooner than the reply to this request
    // comes back.
    recentRemoteOpen = {
      by: message.by ?? 'a phone',
      at: startedAt,
      // Which gate, so the history can show the household's own name and icon for it rather
      // than one word for both.
      channel: Number(message.channelId ?? 1),
    }

    try {
      await openDoor(message.channelId ?? '1')
      const elapsedMs = Date.now() - startedAt
      log(`gate: opened channel ${message.channelId} in ${elapsedMs}ms`)
      this.send({ type: 'ack', reqId: message.reqId, ok: true, elapsedMs })

      // Letting somebody in is an answer. Leaving the intercom ringing after it would have
      // the house chiming at a visitor already walking up the path, until the device gives up
      // on its own half a minute later. Only when a call is actually in progress — opening
      // the gate on the way home should disturb nothing.
      if (callInProgress) await endCallAtGate()
    } catch (error) {
      log(`gate: failed — ${error.message}`)
      this.send({ type: 'ack', reqId: message.reqId, ok: false, error: error.message })
    }
  }

  /**
   * Cuts a new house key and tells the Worker about it.
   *
   * The order matters: the key is written to disk before it is announced, so a machine that
   * loses power between the two comes back with the key it handed out rather than one nobody
   * knows. Announced only after the local server has taken it, for the same reason in the
   * other direction.
   */
  #rekeyLocal() {
    config.localKey = randomBytes(32).toString('base64url')
    writeConfig({ localKey: config.localKey })
    localServer?.rekey(config.localKey)
    this.#announceLocal()
  }

  /** Where this machine can be reached on the house network, and what to say at that door. */
  #announceLocal() {
    const addresses = localAddresses()
    if (addresses.length === 0) return

    this.send({
      type: 'local',
      addresses,
      port: LOCAL_PORT,
      key: config.localKey,
    })
  }

  send(payload) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false
    this.#socket.send(JSON.stringify(payload))
    return true
  }

  sendBinary(chunk) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false
    this.#socket.send(chunk)
    return true
  }

  close() {
    this.#closed = true
    audience.remove(this.#sink)
    this.#socket?.close()
  }
}

// ── Camera ───────────────────────────────────────────────────────────────

/** Frame kinds on the wire. Small integers because every frame carries one. */
const FRAME_VIDEO_KEY = 1
const FRAME_VIDEO = 2
const FRAME_AUDIO = 3
/** The only kind that travels the other way: a voice going out to the gate. */
const FRAME_TALK = 4

/** A still picture from the history: kind, timestamp, one byte of id length, the id, the JPEG. */
const FRAME_THUMBNAIL = 5

/** Long enough for a slow phone network, short enough that a stall is not a night of silence. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** Longer than anybody says one thing, shorter than the intercom's own patience. */
const TALK_LIMIT_MS = 60_000

/** A phone is standing there waiting for this, so it fails fast rather than hanging. */
const PAIR_REQUEST_TIMEOUT_MS = 10_000

/**
 * Everyone currently watching, wherever they are watching from.
 *
 * There are two ways to reach this camera — up through the Worker from anywhere, or straight
 * across the house network — and the intercom must not be asked for two streams to serve
 * them. It is one RTSP session, fanned out here, opened when the first person looks and
 * closed when the last one stops.
 */
class Audience {
  #sinks = new Set()
  #camera = null

  attach(camera) {
    this.#camera = camera
  }

  add(sink) {
    this.#sinks.add(sink)

    // The parameter sets arrive once, at the start of a stream, and a viewer that joined
    // later cannot decode a single frame without them.
    const config = this.#camera?.config
    if (config) sink.send(config)

    this.#camera?.start()
  }

  remove(sink) {
    if (!this.#sinks.delete(sink)) return
    if (this.#sinks.size > 0) return

    this.#camera?.stop()

    // A held button whose socket died never sends its release. The talk channel would stay
    // open on the intercom, which is not merely untidy: it holds the one audio channel the
    // device has, and the manufacturer's own app then fails to get a voice at all.
    talkback.stop()
  }

  get size() {
    return this.#sinks.size
  }

  send(payload) {
    for (const sink of this.#sinks) sink.send(payload)
  }

  sendBinary(chunk) {
    for (const sink of this.#sinks) sink.sendBinary(chunk)
  }
}

const audience = new Audience()

/**
 * Pulls the camera only while somebody is watching, and pushes it up the socket the agent
 * already holds.
 *
 * Frames go out one per message rather than batched. Batching would cut the message count,
 * which is what the relay bills for, but it also adds its own delay to every frame — and the
 * whole value of this is answering "who is at my gate" while they are still standing there.
 * At twenty-five frames a second the count is affordable; the delay would not be.
 */
class Camera {
  #link
  #stream = null
  #config = null
  #frames = 0
  #startedAt = 0
  #quality = 'sd'
  #aspect = null

  constructor(link) {
    this.#link = link
  }

  /** What a viewer joining mid-stream needs before it can decode anything. */
  get config() {
    return this.#stream ? this.#config : null
  }

  /** Switching between the small stream and the large one means opening a new session. */
  setQuality(quality) {
    if (quality !== 'sd' && quality !== 'hd') return
    if (quality === this.#quality) return

    log(`camera: switching to ${quality}`)
    this.#quality = quality

    if (this.#stream) {
      this.#teardown()
      this.start()
    }
  }

  start() {
    // Already running. Whoever just arrived was handed the parameter sets on the way in.
    if (this.#stream) return

    log(`camera: a viewer is watching, opening the ${this.#quality} stream`)
    this.#startedAt = Date.now()
    this.#frames = 0

    // Read once and remembered: it does not change, and a request per viewer would be a
    // request the intercom did not need to answer.
    if (this.#aspect === null) {
      cameraAspect().then((aspect) => {
        this.#aspect = aspect ?? 0
      })
    }

    this.#stream = openStream({
      host: config.host,
      port: config.rtspPort,
      path: streamPath(this.#quality),
      username: config.username,
      password: config.password,
      onConfig: ({ sps, pps }) => {
        this.#config = {
          type: 'stream-config',
          codec: 'h264',
          quality: this.#quality,
          sps: sps?.toString('base64') ?? '',
          pps: pps?.toString('base64') ?? '',
          // Zero means "no idea, use whatever the stream says". Anything else overrides it.
          displayAspect: this.#aspect ?? 0,
          audio: { codec: 'pcm', sampleRate: 16000, bigEndian: true },
        }
        this.#link.send(this.#config)
      },
      onVideo: ({ data, keyframe, timestamp }) => {
        this.#frames += 1
        this.#link.sendBinary(
          frame(keyframe ? FRAME_VIDEO_KEY : FRAME_VIDEO, timestamp, data)
        )
      },
      onAudio: ({ data, timestamp }) => {
        this.#link.sendBinary(frame(FRAME_AUDIO, timestamp, data))
      },
      onError: (error) => {
        log(`camera: ${error.message}`)
        this.#stream = null
        this.#config = null
      },
      onClose: () => {
        this.#stream = null
        this.#config = null
      },
    })
  }

  stop() {
    if (!this.#stream) return

    const seconds = Math.max(1, Math.round((Date.now() - this.#startedAt) / 1000))
    log(`camera: nobody watching, closing after ${seconds}s and ${this.#frames} frames`)

    this.#teardown()
  }

  #teardown() {
    this.#stream?.close()
    this.#stream = null
    this.#config = null
  }
}

/**
 * Carries a voice from the phone to the speaker at the gate.
 *
 * One direction at a time, which is what makes this simple: with only one microphone open,
 * there is no echo to cancel and no clock to keep in step. It is how a walkie talkie works,
 * and how the manufacturer's own app works too.
 *
 * The long way round was `audio.cgi?action=postAudio`, which the intercom accepts, answers
 * with 200, and — with no call up — throws away. Making a call to give it somewhere to go
 * meant ringing every screen in the house to speak one sentence to a courier. The stream's own
 * ONVIF talk track has neither problem: no call, no ringing, and the speaker plays whatever is
 * written to it. See `backchannel.mjs`.
 */
/** Whether the intercom is ringing or in a call, tracked from its own event channel. */
let callInProgress = false

/**
 * Hangs up whatever call the intercom has, so the speaker is free to be spoken through.
 *
 * Best effort on purpose: if this fails the talk channel is still opened, because a voice that
 * might not be heard is worth more than refusing to try. The failure is logged so it is not a
 * mystery when nobody at the gate hears anything.
 */
async function endCallAtGate() {
  callInProgress = false

  let rpc
  try {
    rpc = await new Rpc({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    }).login()
  } catch (error) {
    log(`talk: could not reach the intercom to hang up — ${error.message}`)
    return
  }

  try {
    const instance = await rpc.call('VideoTalkPhone.factory.instance')
    const phone = instance.result

    // Read on both sides of the hang-up rather than announcing success. An earlier version of
    // this line claimed the house had stopped ringing, which nothing here had checked — and
    // the intercom's own thirty second timeout kept firing afterwards, which is what a call
    // that was never cancelled looks like.
    const before = await rpc.call('VideoTalkPhone.getCallState', null, phone)
    await rpc.call('VideoTalkPhone.endCall', null, phone)
    const after = await rpc.call('VideoTalkPhone.getCallState', null, phone)

    const state = after.params?.callState
    log(`talk: hung up — state ${before.params?.callState ?? '?'} → ${state ?? '?'}`)
  } catch (error) {
    log(`talk: VideoTalkPhone would not hang up — ${error.message}`)
  }

  // Both, always, and this is the correction of an earlier belief.
  //
  // `endCall` was treated as sufficient because it moves the intercom's own call state to Idle,
  // which it does. But the indoor monitor kept ringing anyway, and the intercom's thirty second
  // no-answer timer still fired afterwards — the signature of a call that was ended at this end
  // and never cancelled at the other. `endCall` closes the talk session; the console's `hc`,
  // hang call, is what the device itself does when somebody puts the handset down.
  //
  // It is also the more portable of the two: the widely used Home Assistant integration drives
  // everything from a VTO2000 to a VTO9541D with it.
  try {
    const hung = await rpc.call('console.runCmd', { command: 'hc' })
    log(`talk: hang call — ${JSON.stringify(hung.result)}`)
  } catch (error) {
    log(`talk: the console would not hang up — ${error.message}`)
  }
}

class Talkback {
  #speaker = null
  #opening = false
  #deadline = null

  async start() {
    if (this.#speaker || this.#opening) return
    this.#opening = true

    try {
      // A call owns the gate speaker. Anything written to the talk channel while one is up is
      // held back and played once it ends, which is worse than useless — the visitor hears an
      // answer to a question they asked a minute ago. So speaking takes the call over.
      //
      // That also stops every screen in the house ringing, which is what a person means when
      // they pick up: I am dealing with this.
      if (callInProgress) await endCallAtGate()

      this.#speaker = await openBackchannel({
        host: config.host,
        port: config.rtspPort,
        path: streamPath('sd'),
        username: config.username,
        password: config.password,
        onError: (error) => {
          if (!this.#speaker) return
          log(`talk: the channel dropped — ${error.message}`)
          this.#speaker = null
          clearTimeout(this.#deadline)
          this.#deadline = null
        },
      })
      log('talk: speaking to the gate')

      // Last line of defence. Nobody holds a talk button for a minute, and whatever is still
      // holding this one has stopped being a person.
      this.#deadline = setTimeout(() => {
        log('talk: nobody let go — closing the channel')
        this.stop()
      }, TALK_LIMIT_MS)
      this.#deadline.unref?.()
    } catch (error) {
      log(`talk: could not open the channel — ${error.message}`)
      this.#speaker = null
    } finally {
      this.#opening = false
    }
  }

  write(chunk) {
    // Audio that arrives before the channel is open is dropped rather than queued: a voice
    // played late is worse than a voice that lost its first syllable.
    this.#speaker?.write(chunk)
  }

  stop() {
    clearTimeout(this.#deadline)
    this.#deadline = null

    const speaker = this.#speaker
    if (!speaker) return
    this.#speaker = null

    log('talk: finished')
    void speaker.close()
  }
}

/** One byte of kind, four of timestamp, then the payload. */
function frame(kind, timestamp, payload) {
  const header = Buffer.alloc(5)
  header[0] = kind
  header.writeUInt32BE(timestamp >>> 0, 1)
  return Buffer.concat([header, payload])
}

/**
 * The stream that exists to be written down, separate from the one people watch.
 *
 * Sharing the viewers' stream was the obvious thing and the wrong one. It ties two decisions
 * together that belong apart: a recording is watched later, on a big screen, to see a face —
 * while a phone watching live over mobile data wants the small picture. Worse, it made the
 * recording follow whatever the viewers did to it. Somebody tapping HD mid visit changed the
 * picture's size halfway through the file, and the clip decoded as rubble from that point on.
 *
 * So this opens its own session for the length of the visit. The intercom serves both without
 * complaint — it is rated far above the two put together — and the second one never leaves the
 * house, so it costs nobody's data.
 */
class Recorder {
  #stream = null

  get recording() {
    return this.#stream !== null
  }

  start(sink, quality) {
    this.stop()

    log(`history: recording the ${quality} stream`)

    this.#stream = openStream({
      host: config.host,
      port: config.rtspPort,
      path: streamPath(quality),
      username: config.username,
      password: config.password,
      onConfig: ({ sps, pps }) => {
        sink.send({
          type: 'stream-config',
          codec: 'h264',
          quality,
          sps: sps?.toString('base64') ?? '',
          pps: pps?.toString('base64') ?? '',
          displayAspect: 0,
          audio: { codec: 'pcm', sampleRate: 16000, bigEndian: true },
        })
      },
      onVideo: ({ data, keyframe, timestamp }) => {
        sink.sendBinary(frame(keyframe ? FRAME_VIDEO_KEY : FRAME_VIDEO, timestamp, data))
      },
      onAudio: ({ data, timestamp }) => {
        sink.sendBinary(frame(FRAME_AUDIO, timestamp, data))
      },
      onError: (error) => {
        log(`history: the recording stream stopped — ${error.message}`)
        this.#stream = null
      },
      onClose: () => {
        this.#stream = null
      },
    })
  }

  stop() {
    this.#stream?.close()
    this.#stream = null
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────

/**
 * One of each, shared by both ways in. There is one intercom and one microphone at the gate,
 * so a viewer arriving through the Worker and one arriving across the house network are two
 * audiences for the same thing rather than two reasons to open it twice.
 */
const camera = new Camera(audience)
const talkback = new Talkback()
audience.attach(camera)

/**
 * The house's own memory of the gate.
 *
 * It joins the audience when the doorbell rings, which is what opens the camera, and leaves
 * when the visit is over. To everything else here it is simply another viewer — one that
 * happens to write what it sees to a disk instead of a screen.
 */
const history = new History({
  dir: DATA_PATH,
  log,
  snapshot: gateSnapshot,
  enabled: config.historyEnabled,
  quality: config.historyQuality,
  recordMs: config.historySeconds ? config.historySeconds * 1000 : null,
  maxBytes: config.historyMaxBytes,
  onVisitEnd: () => recorder.stop(),
  onSettings: ({ enabled, recordSeconds, maxBytes, quality }) => {
    config.historyEnabled = enabled
    config.historySeconds = recordSeconds
    config.historyMaxBytes = maxBytes
    config.historyQuality = quality
    writeConfig({
      historyEnabled: enabled,
      historySeconds: recordSeconds,
      historyMaxBytes: maxBytes,
      historyQuality: quality,
    })
  },
})

/** Its own stream, for the length of a visit. See `Recorder`. */
const recorder = new Recorder()

/**
 * The intercom's own two logs, which cover what this agent cannot see.
 *
 * A card held to the reader opens the gate with no phone involved and no way for us to say who
 * it was — the intercom knows, and it is the only one who does. Its call log is read for a
 * different reason: it reaches back years, to before this machine was plugged in.
 */
const records = new IntercomRecords({ config, log })

/** Playbacks in progress, so a viewer that leaves stops the clip it asked for. */
const playing = new Map()

/**
 * The last gate command this agent carried out, waiting for the intercom to report it.
 *
 * The intercom's event says a gate opened, never who opened it, and the relay we press looks
 * exactly like a card held to the reader. Three seconds is far longer than the gap measured
 * between pressing and being told about it — around 70 milliseconds — and far shorter than the
 * time between two people arriving.
 */
const REMOTE_OPEN_WINDOW_MS = 3_000
let recentRemoteOpen = null

function stopPlayback(viewer) {
  const cancel = playing.get(viewer)
  if (!cancel) return
  playing.delete(viewer)
  cancel()
}

/**
 * What a viewer is allowed to ask for, from either direction.
 *
 * Deliberately the same short list on both: a phone on the house network is closer to the
 * gate but is not more trusted than one on the far side of the world, and this is the only
 * place that decides what a viewer can do at all.
 */
async function handleViewerMessage(message, viewer = null) {
  switch (message.type) {
    case 'stream-quality':
      camera.setQuality(message.quality)
      return

    // What happened at this gate, newest first. The pictures are not in it — a list of fifty
    // visits carrying fifty photographs is two megabytes for a screen showing six of them, so
    // each is asked for separately as it comes into view.
    // A page of what happened, newest first.
    //
    // `before` is the oldest moment already on the phone's screen, so asking again with it is
    // how the next page is had — an offset would slide under a doorbell that rang while
    // somebody was scrolling, and show them a row twice or not at all.
    case 'history-list': {
      if (!viewer) return

      const limit = Math.min(Math.max(Number(message.limit) || 30, 1), 200)
      const before = Number(message.before) || null
      const kind = message.kind === 'ring' || message.kind === 'gate' ? message.kind : null

      // Merged whole and then cut, rather than paged from each source: the two lists are one
      // story told from two sides, and a page taken from either alone would be missing the
      // other's rows in the middle of it.
      const all = merge(history.list({ limit: 500 }), records.entries())
      const page = all
        .filter((entry) => (kind ? entry.kind === kind : true))
        .filter((entry) => (before ? entry.at < before : true))
        .slice(0, limit)

      viewer.send({
        type: 'history',
        entries: page,
        // Said plainly rather than left to be guessed from a short page: a page can be short
        // because the list ended, or because a filter thinned it out.
        more: page.length === limit,
      })
      return
    }

    // The picture belonging to one visit. The id travels inside the payload rather than in a
    // message before it, so two of these crossing on the wire cannot be mixed up.
    case 'history-thumb': {
      if (!viewer) return
      const path = history.thumbPath(String(message.id ?? ''))
      if (!path) {
        // Only worth saying when somebody is waiting for a reply. A phone on the house network
        // is asking as the row scrolls into view and can simply show nothing.
        if (message.inline) viewer.send({ type: 'history-thumb', id: message.id, jpeg: null })
        return
      }

      const id = Buffer.from(String(message.id), 'utf8')
      const image = readFileSync(path)

      // Through the Worker there is no way to hand back a lump of bytes on its own — the
      // question came in as a message and the answer goes back as one. Fifty kilobytes as text
      // is sixty-seven, which is a fair price for not building a second channel.
      if (message.inline) {
        viewer.send({ type: 'history-thumb', id: message.id, jpeg: image.toString('base64') })
        return
      }

      const header = Buffer.alloc(6)
      header[0] = FRAME_THUMBNAIL
      header.writeUInt32BE(0, 1)
      header.writeUInt8(Math.min(255, id.length), 5)
      viewer.sendBinary(Buffer.concat([header, id, image]))
      return
    }

    // A piece of a recording, as text, for the phone that is not on this network.
    case 'history-clip': {
      if (!viewer) return
      const slice = history.read(message.id, message.offset, message.length)
      if (!slice) {
        viewer.send({ type: 'history-clip', id: message.id, error: 'no recording' })
        return
      }

      viewer.send({
        type: 'history-clip',
        id: message.id,
        offset: slice.offset,
        size: slice.size,
        codec: slice.codec,
        bytes: slice.bytes.toString('base64'),
      })
      return
    }

    case 'history-play': {
      if (!viewer) return
      stopPlayback(viewer)
      playing.set(viewer, history.play(String(message.id ?? ''), viewer))
      return
    }

    case 'history-stop':
      if (viewer) stopPlayback(viewer)
      return

    // Readable by anyone who can watch the camera; changed only through the Worker, which is
    // the only place that knows an owner from a guest. See `WorkerLink.#handle`.
    case 'history-settings':
      viewer?.send({ type: 'history-settings', settings: history.settings() })
      return
    case 'talk-start':
      await talkback.start()
      return
    case 'talk-stop':
      talkback.stop()
      return

    // A doorbell press that nobody had to walk to the gate to make.
    //
    // It reports a ring upward exactly as a real press does, so everything downstream of this
    // machine is genuinely exercised: the Worker, the push, the notification, the sound, the
    // screen. What it does not do is touch the intercom — no call is opened, so nothing sounds
    // in the street and nothing rings on the screens inside the house.
    //
    // Only a phone that presented the house key can ask, which is the same standard as watching
    // the camera. The worst somebody could do with it is make their own phone ring.
    case 'test-ring':
      if (!link) return
      log('test: reporting a doorbell press that did not happen')

      // Recorded like any other visit, so a rehearsal exercises the camera, the disk and the
      // limits rather than only the notification. It is marked as what it was — the code is
      // kept with the visit — so nobody reading the history later mistakes it for a caller.
      {
        const visit = history.beginVisit({ code: 'AjarTestRing' })
        if (visit.clip) recorder.start(history.sink, history.quality)
      }

      link.send({ type: 'ring', deviceId: config.deviceId, code: 'AjarTestRing' })
      return

    case 'binary': {
      // Everything binary from a viewer is somebody talking; the first byte says so and the
      // rest goes straight to the gate.
      const chunk = message.data
      if (chunk.length > 1 && chunk[0] === FRAME_TALK) talkback.write(chunk.subarray(1))
      return
    }
    default:
  }
}

function classify(event) {
  // Dahua repeats events with action=Start and action=Stop. Only the start of a call is a
  // ring; the stop is what ends it.
  if (codes.ring.includes(event.code)) {
    return event.action === 'Stop' ? 'cancelled' : 'ring'
  }
  if (codes.answered.includes(event.code)) return 'answered'
  if (codes.cancelled.includes(event.code)) return 'cancelled'
  if (codes.gateOpened.includes(event.code)) return 'gate_opened'
  return null
}

// ── Setup ────────────────────────────────────────────────────────────────

/** Everything except the account. The intercom hands the rest over to anyone who asks. */
async function findIntercoms() {
  const targets = [...explicitTargets]
  if (config.host) targets.push(config.host)

  const devices = await discover({ targets })
  const intercoms = devices.filter(isIntercom)

  // A device that answers but calls itself something else is still worth offering: the
  // classification is Dahua's, and a wrong guess here would hide the only device found.
  return intercoms.length > 0 ? intercoms : devices
}

function describe(device) {
  const parts = [device.model || device.deviceClass || 'device', device.host]
  if (device.serial) parts.push(device.serial)

  // Nothing on this network had to prove anything to appear on this list, and the next question
  // asks for the intercom's password. A reply that names an address other than the one it came
  // from is the shape a machine pretending to be an intercom takes, so it is said out loud
  // rather than quietly preferred.
  if (device.from && device.from !== device.host) {
    parts.push(`(answered from ${device.from} — check this is your intercom)`)
  }

  return parts.join('  ')
}

/**
 * Reads a password without printing it. Somebody setting this up is often sharing a screen
 * or standing in a hallway with the installer.
 *
 * Reads the terminal directly rather than muting a readline interface. Muting one and asking
 * it a question swallowed the question with it, which is how the first version of this got
 * as far as a real keyboard before anybody noticed.
 */
function readSecret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt)

    const input = process.stdin
    const wasRaw = input.isRaw
    let typed = ''

    const done = (value) => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw ?? false)
      input.pause()
      process.stdout.write('\n')
      resolve(value)
    }

    const onData = (chunk) => {
      for (const byte of chunk) {
        switch (byte) {
          case 0x03: // Ctrl-C, which has to keep meaning what it means everywhere else.
            done('')
            process.exit(130)
            return
          case 0x0d:
          case 0x0a:
            done(typed)
            return
          case 0x7f:
          case 0x08:
            typed = typed.slice(0, -1)
            break
          default:
            if (byte >= 0x20) typed += String.fromCharCode(byte)
        }
      }
    }

    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

/**
 * Asks only what cannot be discovered.
 *
 * The address, the model and the serial number all come off the wire. What is left is the
 * intercom's own account, which no amount of scanning will produce — it is the one thing
 * standing between a stranger on the wifi and an open gate.
 */
async function runSetup() {
  // What is about to be replaced, said out loud. Somebody running this a second time is
  // usually fixing one thing, and ought to see what they already have before overwriting it.
  if (config.host && config.deviceId) {
    console.log(`\nCurrently: ${config.deviceId} at ${config.host} as ${config.username}`)
  }

  console.log('\nLooking for intercoms on this network…\n')

  const devices = await findIntercoms()

  if (devices.length === 0) {
    console.error('Found nothing.')
    console.error('If the intercom is behind another router, name it:')
    console.error('  node agent.mjs --target=192.168.100.2\n')
    process.exit(1)
  }

  devices.forEach((device, index) => console.log(`  ${index + 1}. ${describe(device)}`))
  console.log('')

  // Anything typed while the search was running is not an answer to a question that had not
  // been asked yet.
  process.stdin.read()

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let chosen = devices[0]
  let username = 'admin'

  try {
    if (devices.length > 1) {
      const answer = await rl.question(`Which one? [1-${devices.length}] `)
      chosen = devices[Number(answer) - 1] ?? devices[0]
    }
    console.log(`\nUsing ${describe(chosen)}\n`)

    const typedUser = await rl.question('Intercom username [admin]: ')
    username = typedUser.trim() || 'admin'
  } finally {
    // Closed before the password, because two things reading the same keyboard is how the
    // first version of this managed to skip the question entirely.
    rl.close()
  }

  const password = await readSecret('Intercom password: ')

  if (!password) {
    console.error('\nA password is required.')
    process.exit(1)
  }

  process.stdout.write('Checking the account… ')

  // Asked of the device rather than trusted: a wrong password discovered now is a sentence,
  // and discovered later is an agent that silently never works.
  const body = await digestGet({
    host: chosen.host,
    port: chosen.httpPort,
    path: '/cgi-bin/magicBox.cgi?action=getSerialNo',
    username,
    password,
    timeoutMs: 8_000,
  }).catch((error) => {
    console.log('no.')
    console.error(
      error.message.includes('401')
        ? '\nThe intercom refused that username and password.'
        : `\n${error.message}`
    )
    process.exit(1)
  })

  const serial = String(body).split('=')[1]?.trim() || chosen.serial
  console.log('yes.\n')

  config.host = chosen.host
  config.port = chosen.httpPort
  config.username = username
  config.password = password
  config.deviceId = serial

  writeConfig({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    deviceId: config.deviceId,
    workerUrl: config.workerUrl,
  })

  console.log(`Saved to ${CONFIG_PATH}`)
  console.log(`Intercom ${serial} at ${config.host}\n`)
}

/**
 * The same job, with nobody to ask.
 *
 * A container has no terminal, so everything the setup would have asked has to arrive as
 * environment variables — but only the password is genuinely unknowable. The address can be
 * found by shouting on the network, and the serial number by asking the intercom for it. Making
 * somebody dig those out and paste them into a NAS form is exactly the barrier this is meant
 * to remove: a password is something they have, a serial number is homework.
 */
async function configureHeadless() {
  if (!config.password) {
    console.error('Set VTO_PASSWORD to the intercom\'s password, and start this again.')
    console.error('The account defaults to `admin`; set VTO_USERNAME only if yours differs.')
    console.error('Everything else — the address, the serial number — is found from here.')
    process.exit(1)
  }

  if (!config.host) {
    log('looking for the intercom on this network')
    const found = (await discover({ timeoutMs: 4_000 })).filter(isIntercom)

    if (found.length === 0) {
      console.error('No intercom answered on this network.')
      console.error('If the container is not sharing the host network, it cannot hear one.')
      console.error('Otherwise set VTO_HOST to its address.')
      process.exit(1)
    }

    // More than one is a house with two gates, and picking for somebody would be a guess with
    // consequences. The list is printed so the choice is one line of configuration away.
    if (found.length > 1 && !process.env.VTO_HOST) {
      console.error('More than one intercom answered. Set VTO_HOST to the one you want:')
      found.forEach((device) => console.error(`  ${device.host}  ${device.serial} ${device.model}`))
      process.exit(1)
    }

    config.host = found[0].host
    config.port = found[0].httpPort ?? config.port
    log(`found ${found[0].serial} at ${config.host}`)
  }

  if (!config.deviceId) {
    const body = await digestGet({
      host: config.host,
      port: config.port,
      path: '/cgi-bin/magicBox.cgi?action=getSerialNo',
      username: config.username,
      password: config.password,
      timeoutMs: 8_000,
    }).catch((error) => {
      console.error(
        error.message.includes('401')
          ? `The intercom refused the account "${config.username}".\n` +
            'That is the intercom\'s own account — the one its web page asks for — and it is\n' +
            '`admin` on almost every one of these. Set VTO_USERNAME if yours was changed.'
          : `Could not reach the intercom: ${error.message}`
      )
      process.exit(1)
    })

    config.deviceId = String(body).split('=')[1]?.trim()
    if (!config.deviceId) {
      console.error('The intercom would not say what its serial number is.')
      process.exit(1)
    }
  }

  writeConfig({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    deviceId: config.deviceId,
    workerUrl: config.workerUrl,
  })

  log(`configured for ${config.deviceId} at ${config.host}`)
}

// ── Start ────────────────────────────────────────────────────────────────


/**
 * Refuses to carry the agent's secret over anything but TLS.
 *
 * The secret rides in a header on the way up, and the agent it identifies can open a front
 * gate. A `WORKER_URL` typed with `http` rather than `https` — a development address left in a
 * container, a copied command — would put that on the wire in clear, and nothing would say so.
 * Localhost is let through: there is no network to listen on, and that is where the Worker runs
 * while somebody is working on it.
 */
function requireEncryptedWorker(workerUrl) {
  let url
  try {
    url = new URL(workerUrl)
  } catch {
    console.error(`WORKER_URL is not an address: ${workerUrl}`)
    process.exit(1)
  }

  const encrypted = url.protocol === 'https:' || url.protocol === 'wss:'
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'

  if (encrypted || loopback) return

  console.error(`WORKER_URL must be https, not ${url.protocol.replace(':', '')}.`)
  console.error("The agent's secret travels on that connection; it cannot go in the clear.")
  process.exit(1)
}

async function main() {

  if (discoverOnly) {
    const devices = await findIntercoms()
    if (devices.length === 0) console.log('Found nothing.')
    devices.forEach((device) => console.log(describe(device)))
    return
  }

  // Nothing configured yet. Rather than printing what is missing, go and find it.
  if (forceSetup || !config.password || !config.host || !config.deviceId) {
    if (!process.stdin.isTTY) {
      await configureHeadless()
    } else {
      await runSetup()
    }
  }

  if (!watchOnly) {
    if (!config.workerUrl) {
      console.error('WORKER_URL is required (or pass --watch).')
      process.exit(1)
    }
    requireEncryptedWorker(config.workerUrl)
    ensureAgentSecret()
    ensureLocalKey()
  }

  // Serving the house network is not conditional on the Worker being reachable: a phone
  // standing in the hallway should see the gate even on a day the internet is down.
  link = watchOnly ? null : new WorkerLink()

  localServer = watchOnly
    ? null
    : new LocalServer({
        key: config.localKey,
        serial: config.deviceId,
        onViewer: (sink) => audience.add(sink),
        onGone: (sink) => {
          stopPlayback(sink)
          audience.remove(sink)
        },
        onMessage: (message, viewer) => void handleViewerMessage(message, viewer),
        onPair: (via) => link.requestPairingCode(via),
        onReclaim: (password) => intercomAccepts(password),
        log,
      })
  localServer?.start()

  // Not in `--watch`, which exists to print event codes on somebody else's intercom and has no
  // business writing recordings to their disk.
  if (!watchOnly) await history.ready()

  // Read once at startup so the first phone to open the history sees the card openings too,
  // rather than an empty half of the list that fills in a moment later.
  if (!watchOnly) void records.refresh()

  // Only useful to a phone that has not paired yet, which is the one case where nothing else
  // can tell it where to look.
  const beacon = watchOnly ? null : startBeacon({ serial: config.deviceId, log })

  link?.connect()

  const controller = new AbortController()
  process.on('SIGINT', () => {
    log('shutting down')
    controller.abort()
    link?.close()
    beacon?.close()
    process.exit(0)
  })

  let backoffMs = 1_000

  // The event channel is the agent's only way of knowing someone is at the gate, so it is
  // rebuilt for as long as the process lives.
  for (;;) {
    try {
      log(`intercom: attaching to events at ${config.host}`)
      backoffMs = 1_000

      await attachEvents((event) => {
        const kind = classify(event)

        // Everything is printed, not just what is understood: an unrecognised doorbell
        // code is invisible otherwise, and that is exactly what needs finding.
        log(`event ${event.code} action=${event.action}${kind ? `  → ${kind}` : ''}`)

        // Remembered because the gate speaker belongs to a call while one is up, and what
        // the agent writes to the talk channel then is not heard until it ends. Knowing a
        // call is in progress is what lets talking take it over — see `Talkback.start`.
        // One press, two events: this intercom emits `CallNoAnswered` and `Invite` five
        // milliseconds apart, and both mean the same doorbell. Sent up as they arrive, they
        // become two notifications on the phone for one visitor. The second is dropped rather
        // than de-duplicated upstairs, because only this end knows they are the same press.
        const duplicateRing = kind === 'ring' && callInProgress

        if (kind === 'ring') callInProgress = true
        if (kind === 'cancelled' || kind === 'gate_opened') callInProgress = false

        // Whether anybody is watching or not, and whether anybody answers or not, a visit is
        // worth keeping. Joining the audience is what opens the camera — the same single
        // stream a phone would be given, not a second one — and the recording carries on
        // through being answered, because who came and what was said is the part worth having.
        if (kind === 'ring' && !duplicateRing) {
          const visit = history.beginVisit({ code: event.code })
          if (visit.clip) recorder.start(history.sink, history.quality)
        }

        // The gate opening is not the end of a visit: the intercom's own call goes on until it
        // is cancelled, and so does the recording. It is the cancel that closes both.
        //
        // The intercom reports that a gate opened without saying who opened it — the same
        // event for a card held to the reader and for this agent pressing the relay a
        // millisecond earlier. So the two are told apart here: a command we just carried out
        // claims the event, and anything else was somebody at the gate itself.
        if (kind === 'gate_opened') {
          const ours = recentRemoteOpen && Date.now() - recentRemoteOpen.at < REMOTE_OPEN_WINDOW_MS
          history.noteGateOpened(
            ours
              ? { by: recentRemoteOpen.by, method: 'app', door: recentRemoteOpen.channel }
              : { by: null, method: 'card' }
          )
          recentRemoteOpen = null
        }

        if (kind === 'cancelled') history.endVisit('the call ended')

        if (!kind || !link || duplicateRing) return
        link.send({ type: kind, deviceId: config.deviceId, code: event.code })
      }, controller.signal)

      if (controller.signal.aborted) return
    } catch (error) {
      log(`intercom: ${error.message} — retrying in ${backoffMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }
}

// Anything reaching here has already been through every retry the agent has. Said plainly and
// then out, rather than dying with a stack trace nobody reads and an exit code that says fine.
main().catch((error) => {
  console.error(`\nThe agent stopped: ${error.message}`)
  process.exit(1)
})
