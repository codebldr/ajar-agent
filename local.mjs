// The camera, served on the house's own network.
//
// The phone used to read the intercom directly over RTSP when it was at home, which meant
// asking somebody for an address, a username and a password — the intercom's own account,
// typed a second time into a phone, for a stream the agent was already holding. This replaces
// that: the agent hands out the same frames it sends up to the Worker, over the local network,
// to a phone that never learns the intercom's password because it never needs it.
//
// Plain TCP rather than WebSocket. Both ends are ours and neither is a browser, so the HTTP
// upgrade, the masking and the frame headers would all be ceremony for nothing. What is left
// is a four byte length and a payload.

import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { timingSafeEqual } from 'node:crypto'

export const LOCAL_PORT = 8787

/** Kind zero is JSON. Everything else is a media frame and already carries its own kind. */
const KIND_JSON = 0

/** A phone that connects and then says nothing is a port scanner, not a viewer. */
const HELLO_TIMEOUT_MS = 5_000

/** No single frame from an intercom is anywhere near this. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/**
 * What a phone may send before it has proved anything: a hello, or a request to pair. Both are
 * small JSON objects.
 *
 * Held far below the frame limit on purpose. Before the key is checked, anybody who can reach
 * this port can make the agent hold whatever it says its frame is worth — and a few hundred
 * sockets each claiming four megabytes is a house with no doorbell and a machine out of memory.
 */
const MAX_HELLO_BYTES = 4 * 1024

/**
 * How many sockets may be here at once, and how many of those may still be strangers.
 *
 * A household watches from a handful of phones. Everything past that is either a fault or
 * somebody testing what happens, and neither deserves the memory.
 */
const MAX_SESSIONS = 16
const MAX_PENDING = 32

/** Long enough that nothing legitimate notices, short enough that nothing floods the Worker. */
const PAIR_COOLDOWN_MS = 3_000

/**
 * How long a rehearsal of the doorbell waits for the one before it.
 *
 * A test ring is a real visit as far as everything downstream is concerned: a line in the
 * history, a picture, a recording, and a push to every phone in the house. Asked for in a loop by
 * a guest, it filled the history with rehearsals and pushed the real visits out of it.
 *
 * Ten seconds, not a minute: somebody testing the app rings, answers, and rings again, and a
 * minute in between was a ring that seemed to go missing. Six an hour would stop a tester; six a
 * minute does not help anybody flood anything. An ask that comes too soon is told so, with how
 * long to wait, rather than dropped without a word.
 */
const TEST_RING_COOLDOWN_MS = 10_000

/**
 * How much may wait to be sent to one phone before it is let go.
 *
 * Fifteen to thirty seconds of HD video — far more than a wifi hiccup in the middle of a
 * conversation at the gate, which must not cost anybody the call. A phone further behind than
 * that is not watching; it has walked out of range or stopped reading, and TCP can take a quarter
 * of an hour to notice.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024

/** Probes a socket that has gone quiet, so a phone that vanished mid-stream is noticed. */
const KEEPALIVE_MS = 30_000

/**
 * How many refusals are written down in a minute. The rest are counted and summed up.
 *
 * A refusal costs nothing to cause — open a socket, say the wrong thing, drop it — and on a NAS
 * or a Mac nothing trims the log. Twenty a minute is every honest mistake a household makes.
 */
const REFUSALS_LOGGED_PER_WINDOW = 20
const REFUSAL_WINDOW_MS = 60_000

/**
 * How hard somebody may try the intercom's admin password from the house wifi.
 *
 * This is the wall between "on the wifi" and "runs the house", so it is the one thing here worth
 * guessing at, and the only brake in front of it is this. Two seconds apart, and five wrong
 * answers buys a quarter of an hour of nothing — which also keeps the intercom out of its own
 * lockout, since every attempt that is not obviously wrong is put to the device itself.
 */
const RECLAIM_COOLDOWN_MS = 2_000
const RECLAIM_MAX_FAILURES = 5
const RECLAIM_LOCKOUT_MS = 15 * 60_000

/** A password, not a payload. Anything longer is somebody probing. */
const MAX_PASSWORD_LENGTH = 128

/**
 * Serves whoever is on the house network and can prove they are allowed.
 *
 * The proof is a key the agent generates and reports upward; the Worker hands it only to
 * phones already paired with this device. So being on the wifi is not enough, which matters —
 * a house wifi has guests on it, and the difference between watching the gate and opening it
 * is one message.
 */
export class LocalServer {
  #key
  #onViewer
  #onGone
  #onMessage
  #onPair
  #onReclaim
  #serial
  #server = null
  #sessions = new Set()
  /** Connected, but not yet anybody: no key offered, nothing earned. */
  #pending = new Set()
  #lastPairAt = 0
  #lastReclaimAt = 0
  #reclaimFailures = 0
  #reclaimLockedUntil = 0
  #lastTestRingAt = 0
  #testRingCooldownMs
  #refusalWindowStartedAt = 0
  #refusalsLogged = 0
  #refusalsUnsaid = 0

  constructor({
    key,
    serial,
    onViewer,
    onGone,
    onMessage,
    onPair,
    onReclaim,
    log,
    // Shorter only in tests, which should not sit out the real wait.
    testRingCooldownMs = TEST_RING_COOLDOWN_MS,
  }) {
    this.#key = Buffer.from(key, 'utf8')
    this.#serial = serial
    this.#onViewer = onViewer
    this.#onGone = onGone
    this.#onMessage = onMessage
    this.#onPair = onPair
    this.#onReclaim = onReclaim
    this.#testRingCooldownMs = testRingCooldownMs
    this.log = log
  }

  start() {
    if (this.#server) return

    this.#server = createServer((socket) => this.#accept(socket))

    this.#server.on('error', (error) => {
      // A port already in use is worth saying once; it is not worth stopping the agent for,
      // because everything else it does still works through the Worker.
      this.log(`local: ${error.message}`)
      this.#server = null
    })

    this.#server.listen(LOCAL_PORT, () => {
      const where = localAddresses()
      this.log(
        `local: serving the camera on ${where.length ? where.join(', ') : '0.0.0.0'}:${LOCAL_PORT}`
      )
    })
  }

  stop() {
    for (const session of this.#sessions) session.socket.destroy()
    this.#sessions.clear()
    this.#server?.close()
    this.#server = null
  }

  /**
   * Takes the house key back and cuts a new one.
   *
   * Called when somebody is removed from the device. Revoking used to stop a phone asking the
   * Worker anything while leaving it holding this key for ever — so a former guest, back on the
   * wifi, still saw the camera and still spoke at the gate. Nothing upstairs could reach that,
   * because nothing upstairs is in the way.
   *
   * Everyone watching right now is disconnected, including the phones that did nothing wrong.
   * They ask the Worker where the agent is every time they connect, so they come back with the
   * new key by themselves, a second later.
   */
  rekey(key) {
    this.#key = Buffer.from(key, 'utf8')

    for (const session of this.#sessions) {
      this.#onGone(this.#sink(session))
      session.socket.destroy()
    }
    this.#sessions.clear()

    this.log('local: the house key was replaced; everyone watching has to ask again')
  }

  get viewers() {
    return this.#sessions.size
  }

  #accept(socket) {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, KEEPALIVE_MS)

    const session = { socket, greeted: false, buffer: Buffer.alloc(0) }

    const reject = (why) => {
      this.#refused(socket.remoteAddress, why)
      this.#pending.delete(session)
      socket.destroy()
    }

    // This port is for the house. Everything it offers a stranger — a pairing request, a guess at
    // the intercom's password — assumes the stranger is at least inside the building.
    if (!isHouseAddress(socket.remoteAddress)) return reject('not on the house network')

    // Counted before anything is read. A flood of half-open connections costs nothing to make
    // and, unchecked, costs this machine everything it has.
    if (this.#pending.size >= MAX_PENDING || this.#sessions.size >= MAX_SESSIONS) {
      return reject('too many connections already')
    }
    this.#pending.add(session)

    const timer = setTimeout(() => {
      if (!session.greeted) reject('said nothing')
    }, HELLO_TIMEOUT_MS)

    socket.on('data', (chunk) => {
      session.buffer = Buffer.concat([session.buffer, chunk])

      for (;;) {
        // Before the key has been checked the ceiling is a hello, not a video frame. Read
        // afresh each time round: the frame that greets us lifts it for the ones after.
        const ceiling = session.greeted ? MAX_FRAME_BYTES : MAX_HELLO_BYTES
        if (session.buffer.length > 4 + ceiling) return reject('sent too much')

        if (session.buffer.length < 4) return
        const length = session.buffer.readUInt32BE(0)

        if (length > ceiling) return reject('sent nonsense')
        if (session.buffer.length < 4 + length) return

        const payload = session.buffer.subarray(4, 4 + length)
        session.buffer = session.buffer.subarray(4 + length)

        if (!session.greeted) {
          clearTimeout(timer)

          // A phone that has not been let in yet, asking to be. It has no key, because the key
          // is what it is here to earn — and reaching this port at all is the claim it is
          // making: that it is inside the house.
          if (this.#wantsPairing(payload)) {
            void this.#pair(session)
            return
          }

          // A phone claiming the house rather than asking to join it. Being on the wifi is not
          // the claim here — knowing the intercom's own admin password is, and that is checked
          // against the intercom before anything is handed back.
          const password = this.#wantsReclaim(payload)
          if (password !== null) {
            void this.#reclaim(session, password)
            return
          }

          if (!this.#greet(payload)) return reject('wrong key')
          session.greeted = true
          this.#pending.delete(session)
          this.#sessions.add(session)
          this.log(`local: ${socket.remoteAddress} is watching`)
          this.#onViewer(this.#sink(session))
          continue
        }

        this.#relay(session, payload)
      }
    })

    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(timer)
      this.#pending.delete(session)
      if (!this.#sessions.delete(session)) return
      this.log(`local: ${socket.remoteAddress} stopped watching`)
      this.#onGone(this.#sink(session))
    })
  }

  #wantsPairing(payload) {
    if (payload[0] !== KIND_JSON) return false
    try {
      return JSON.parse(payload.subarray(1).toString('utf8')).pair === true
    } catch {
      return false
    }
  }

  /** The password offered, or null when this is not a reclaim at all. */
  #wantsReclaim(payload) {
    if (payload[0] !== KIND_JSON) return null
    try {
      const asked = JSON.parse(payload.subarray(1).toString('utf8'))
      if (asked.reclaim !== true) return null
      return String(asked.password ?? '').slice(0, MAX_PASSWORD_LENGTH)
    } catch {
      return null
    }
  }

  /**
   * Claims the household with the intercom's own admin password.
   *
   * This is the wall that keeps the house wifi from being a way to take the house. Reaching this
   * port proves somebody is inside a building; it does not tell a family from the neighbour who
   * was given the wifi password at a barbecue two summers ago. So becoming an admin asks for a
   * thing the wifi cannot supply, and the agent puts it to the intercom rather than deciding for
   * itself — it authenticates there constantly and has no other opinion worth having.
   *
   * The reward is the ordinary pairing code, minted as though it had been read off this
   * machine's own screen. So the Worker learns no new way to trust anybody, and this also
   * quietly removes the recovery cliff of a headless box: nobody has to find an SSH client to
   * get back into their own gate.
   */
  async #reclaim(session, password) {
    const send = (payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      write(session.socket, Buffer.concat([Buffer.from([KIND_JSON]), body]))
    }

    const done = (payload) => {
      send(payload)
      session.socket.end()
    }

    const now = Date.now()
    if (now < this.#reclaimLockedUntil) {
      return done({ type: 'reclaim-error', error: 'locked out' })
    }
    if (now - this.#lastReclaimAt < RECLAIM_COOLDOWN_MS) {
      return done({ type: 'reclaim-error', error: 'too soon' })
    }
    this.#lastReclaimAt = now

    this.log(`local: ${session.socket.remoteAddress} is claiming the household`)

    if (!(await this.#onReclaim(password))) {
      this.#reclaimFailures += 1
      if (this.#reclaimFailures >= RECLAIM_MAX_FAILURES) {
        this.#reclaimLockedUntil = Date.now() + RECLAIM_LOCKOUT_MS
        this.#reclaimFailures = 0
        this.log('local: too many wrong intercom passwords; no more for fifteen minutes')
      }
      return done({ type: 'reclaim-error', error: 'wrong password' })
    }

    this.#reclaimFailures = 0

    try {
      const code = await this.#onPair('console')
      done({ type: 'pair', serial: this.#serial, code })
    } catch (error) {
      this.log(`local: could not get a pairing code — ${error.message}`)
      done({ type: 'reclaim-error', error: 'no code' })
    }
  }

  /**
   * Vouches for a phone on the house network.
   *
   * Being able to reach this port is the whole proof. It is a weaker claim than reading a code
   * off the screen of the machine the agent runs on — a guest who once had the wifi password
   * can make it too — and a stronger one than knowing the serial number, which is printed on a
   * sticker facing the street. The trade is deliberate: it removes the only step in setting
   * this up that a normal person cannot complete.
   *
   * The code handed back is the ordinary one, so the Worker learns no new way to trust anybody,
   * and every lockout and rate limit already guarding pairing still applies.
   */
  async #pair(session) {
    const send = (payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      write(session.socket, Buffer.concat([Buffer.from([KIND_JSON]), body]))
    }

    // One at a time, and not in a hurry. Nothing legitimate asks twice in three seconds, and a
    // guest working through possibilities has nothing to work through anyway — but a stream of
    // these would have the Worker minting codes all day.
    const now = Date.now()
    if (now - this.#lastPairAt < PAIR_COOLDOWN_MS) {
      send({ type: 'pair-error', error: 'too soon' })
      session.socket.end()
      return
    }
    this.#lastPairAt = now

    this.log(`local: ${session.socket.remoteAddress} is asking to pair`)

    try {
      const code = await this.#onPair('local')
      send({ type: 'pair', serial: this.#serial, code })
    } catch (error) {
      this.log(`local: could not get a pairing code — ${error.message}`)
      send({ type: 'pair-error', error: 'no code' })
    }

    session.socket.end()
  }

  /** Compared in constant time, because the answer is otherwise a guessing game with hints. */
  #greet(payload) {
    let hello
    try {
      hello = JSON.parse(payload.subarray(1).toString('utf8'))
    } catch {
      return false
    }

    const offered = Buffer.from(String(hello.key ?? ''), 'utf8')
    return offered.length === this.#key.length && timingSafeEqual(offered, this.#key)
  }

  /** Writes a refusal down, unless enough have been written down this minute already. */
  #refused(address, why) {
    const now = Date.now()
    if (now - this.#refusalWindowStartedAt >= REFUSAL_WINDOW_MS) {
      if (this.#refusalsUnsaid > 0) {
        this.log(`local: refused ${this.#refusalsUnsaid} more in the last minute without saying so`)
      }
      this.#refusalWindowStartedAt = now
      this.#refusalsLogged = 0
      this.#refusalsUnsaid = 0
    }

    if (this.#refusalsLogged < REFUSALS_LOGGED_PER_WINDOW) {
      this.#refusalsLogged += 1
      this.log(`local: refused ${address} — ${why}`)
    } else {
      this.#refusalsUnsaid += 1
    }
  }

  /**
   * What a phone on the house network may not ask for, however good its key.
   *
   * The history, first. Whether a guest may read it is a switch an admin sets per phone, and
   * every phone here presents the same household key — so this end cannot tell the guest who
   * may from the one who may not. The Worker can, and the app asks it even from the hallway.
   *
   * And a test ring too soon after the last one, which is answered with how long to wait. See
   * `TEST_RING_COOLDOWN_MS`.
   */
  #allowed(message, session) {
    if (typeof message.type === 'string' && message.type.startsWith('history-')) return false

    if (message.type === 'test-ring') {
      const now = Date.now()
      const waitMs = this.#lastTestRingAt + this.#testRingCooldownMs - now
      if (waitMs > 0) {
        this.#sink(session).send({
          type: 'test-ring-error',
          error: 'too soon',
          retryInSec: Math.ceil(waitMs / 1000),
        })
        return false
      }
      this.#lastTestRingAt = now
    }

    return true
  }

  /** Talking back, and asking for a different picture. The same words the Worker relays. */
  #relay(session, payload) {
    if (payload[0] === KIND_JSON) {
      try {
        const message = JSON.parse(payload.subarray(1).toString('utf8'))
        if (!this.#allowed(message, session)) return
        // Handed the viewer's own way back as well as the message: what a phone asks for is
        // mostly broadcast to everyone watching, but an answer to a question belongs to the
        // phone that asked it.
        this.#onMessage(message, this.#sink(session))
      } catch {
        // A viewer that sends rubbish is ignored rather than disconnected: the stream is
        // worth more than the point.
      }
      return
    }
    this.#onMessage({ type: 'binary', data: payload }, this.#sink(session))
  }

  #sink(session) {
    if (session.sink) return session.sink

    // Written, and then let go of if the phone is too far behind to be watching. Dropping frames
    // instead would leave it decoding a picture with holes in it; a phone that is let go asks
    // again and starts from a clean keyframe.
    const deliver = (payload) => {
      const { socket } = session
      if (!write(socket, payload)) return
      if (socket.writableLength <= MAX_QUEUED_BYTES) return
      this.log(`local: ${socket.remoteAddress} fell behind; letting it go`)
      socket.destroy()
    }

    session.sink = {
      send: (payload) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        deliver(Buffer.concat([Buffer.from([KIND_JSON]), body]))
      },
      sendBinary: (chunk) => deliver(chunk),
    }

    return session.sink
  }
}

function write(socket, payload) {
  if (socket.destroyed) return false
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  socket.write(header)
  socket.write(payload)
  return true
}

/** Where a phone shouts to ask whether an agent is listening. */
export const BEACON_PORT = 8788

/** What it shouts. Short, and unmistakably not anything else on the network. */
const BEACON_PROBE = 'AJAR?'

/** Enough for every phone in a house to look at once, and nothing like enough to flood anybody. */
const BEACON_MAX_PER_WINDOW = 10
const BEACON_WINDOW_MS = 1_000

/** One line about answering a minute: ten answers a second, all day, is a log full of nothing. */
const BEACON_LOG_EVERY_MS = 60_000

/**
 * The networks a house is on: RFC 1918, and the link-local range a machine falls back to when
 * nothing handed it an address.
 *
 * Carrier-grade NAT (100.64/10) is deliberately absent. It looks private and is not: it is the
 * mobile network, which is precisely the far side this beacon has no business answering.
 */
function isPrivateAddress(address) {
  const octets = address.replace(/^::ffff:/, '').split('.').map(Number)
  if (octets.length !== 4 || octets.some((byte) => !Number.isInteger(byte))) return false

  const [first, second] = octets
  if (first === 10) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 169 && second === 254) return true
  if (first === 127) return true
  return false
}

/**
 * Whether an address is somewhere inside a house: the private IPv4 ranges above, and their IPv6
 * counterparts — loopback, link-local (fe80::/10) and unique local (fc00::/7).
 *
 * The beacon needed only the first half, because it only ever listens on IPv4. The TCP port
 * listens on both, and a Pi with a public IPv6 address behind a router that lets it in is on
 * the internet whether or not anybody meant it to be.
 */
export function isHouseAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  if (isPrivateAddress(address)) return true

  const lower = address.toLowerCase()
  if (lower === '::1') return true
  return /^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower)
}

/**
 * Answers a phone that is looking for an agent and does not yet know where to look.
 *
 * The address cannot come from the server, because a phone that has not paired yet has nothing
 * to ask the server with. So it does what the agent itself does to find the intercom: shouts on
 * the local network and listens. Anything that answers is on the same network, which is exactly
 * the thing being established.
 *
 * The serial is in the reply. It is not a secret — it is printed on the intercom, facing the
 * street, and the intercom hands it to anyone who asks over the network — and having it here
 * saves the owner from typing a fifteen character code off a sticker in the dark.
 */
export function startBeacon({ serial, log }) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })

  let answeredInWindow = 0
  let windowStartedAt = 0
  let loggedAt = 0
  let answeredSinceLog = 0

  socket.on('message', (message, from) => {
    if (message.toString('utf8').trim() !== BEACON_PROBE) return

    // A phone looking for the agent is on the house network by definition. Anything asking from
    // outside it is not a phone, and answering would make this machine into somebody else's
    // weapon: the reply is twelve times the size of the question, and the address a question
    // comes from can be forged, so the answers would land on a stranger.
    if (!isPrivateAddress(from.address)) return

    // Even inside the house, a flood of these is not a phone. Answering a handful a second is
    // plenty for a phone that asks three times and gives up.
    const now = Date.now()
    if (now - windowStartedAt > BEACON_WINDOW_MS) {
      windowStartedAt = now
      answeredInWindow = 0
    }
    if (answeredInWindow >= BEACON_MAX_PER_WINDOW) return
    answeredInWindow += 1

    const answer = Buffer.from(
      JSON.stringify({ type: 'ajar-agent', serial, port: LOCAL_PORT }),
      'utf8'
    )
    socket.send(answer, from.port, from.address)

    answeredSinceLog += 1
    if (now - loggedAt < BEACON_LOG_EVERY_MS) return
    const others = answeredSinceLog - 1
    log(`beacon: answered ${from.address}${others > 0 ? ` and ${others} more since the last line` : ''}`)
    loggedAt = now
    answeredSinceLog = 0
  })

  socket.on('error', (error) => {
    log(`beacon: ${error.message}`)
    socket.close()
  })

  socket.bind(BEACON_PORT, () => {
    socket.setBroadcast(true)
    log(`beacon: answering on ${BEACON_PORT}`)
  })

  return socket
}

/**
 * Every address a phone might find this machine at.
 *
 * All of them, not the first one. A box worth running this on tends to have more than one way
 * in — a Raspberry Pi with both a cable and wifi, a NAS with two ports — and the one this
 * happens to list first is not necessarily the one the phone can reach. A house with several
 * access points can put the two on different sides of the same network, which is not
 * something to ask an owner to understand: the phone tries them all and keeps what answers.
 */
export function localAddresses() {
  const found = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return found
}
