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

/** Long enough that nothing legitimate notices, short enough that nothing floods the Worker. */
const PAIR_COOLDOWN_MS = 3_000

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
  #serial
  #server = null
  #sessions = new Set()
  #lastPairAt = 0

  constructor({ key, serial, onViewer, onGone, onMessage, onPair, log }) {
    this.#key = Buffer.from(key, 'utf8')
    this.#serial = serial
    this.#onViewer = onViewer
    this.#onGone = onGone
    this.#onMessage = onMessage
    this.#onPair = onPair
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

  get viewers() {
    return this.#sessions.size
  }

  #accept(socket) {
    socket.setNoDelay(true)

    const session = { socket, greeted: false, buffer: Buffer.alloc(0) }

    const reject = (why) => {
      this.log(`local: refused ${socket.remoteAddress} — ${why}`)
      socket.destroy()
    }

    const timer = setTimeout(() => {
      if (!session.greeted) reject('said nothing')
    }, HELLO_TIMEOUT_MS)

    socket.on('data', (chunk) => {
      session.buffer = Buffer.concat([session.buffer, chunk])

      for (;;) {
        if (session.buffer.length < 4) return
        const length = session.buffer.readUInt32BE(0)

        if (length > MAX_FRAME_BYTES) return reject('sent nonsense')
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

          if (!this.#greet(payload)) return reject('wrong key')
          session.greeted = true
          this.#sessions.add(session)
          this.log(`local: ${socket.remoteAddress} is watching`)
          this.#onViewer(this.#sink(session))
          continue
        }

        this.#relay(payload)
      }
    })

    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(timer)
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
      const code = await this.#onPair()
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

  /** Talking back, and asking for a different picture. The same words the Worker relays. */
  #relay(payload) {
    if (payload[0] === KIND_JSON) {
      try {
        this.#onMessage(JSON.parse(payload.subarray(1).toString('utf8')))
      } catch {
        // A viewer that sends rubbish is ignored rather than disconnected: the stream is
        // worth more than the point.
      }
      return
    }
    this.#onMessage({ type: 'binary', data: payload })
  }

  #sink(session) {
    if (session.sink) return session.sink

    session.sink = {
      send: (payload) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8')
        write(session.socket, Buffer.concat([Buffer.from([KIND_JSON]), body]))
      },
      sendBinary: (chunk) => write(session.socket, chunk),
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

  socket.on('message', (message, from) => {
    if (message.toString('utf8').trim() !== BEACON_PROBE) return

    const answer = Buffer.from(
      JSON.stringify({ type: 'ajar-agent', serial, port: LOCAL_PORT }),
      'utf8'
    )
    socket.send(answer, from.port, from.address)
    log(`beacon: answered ${from.address}`)
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
