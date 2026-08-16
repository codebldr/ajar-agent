// A WebSocket client, written out rather than depended on.
//
// Node grew a built-in WebSocket in version 22. Requiring that would mean requiring a newer
// Node than a Raspberry Pi, a Synology box or a Home Assistant add-on is likely to be
// carrying — and "upgrade your Node first" is exactly the barrier this agent exists to avoid.
// Node 21's version sits behind a flag and does not work: it errors during the handshake and
// leaves the socket in CONNECTING for ever, which was measured before this file was written.
//
// So: RFC 6455 over the http and tls modules, which have been in Node since forever. The
// surface deliberately mirrors the browser's, so the rest of the agent cannot tell which one
// it is holding.

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** RFC 6455 section 1.3. The constant every WebSocket server hashes the key with. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * The largest frame worth reading.
 *
 * Everything that arrives here is a small JSON message or a slice of somebody's voice. The
 * protocol allows a length of nearly nine exabytes, and a server that sent one would have this
 * buffer grow until the machine died. Ours never will; the point is that a broken or hostile
 * one cannot either.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/**
 * How often to prod the other end, and how long to wait before giving up on it.
 *
 * A laptop that sleeps, a router that reboots, a phone network that moves you between towers:
 * all of them can take a connection away without either side sending anything to say so. The
 * socket stays open for ever, the agent believes it is connected, and the doorbell rings into
 * a wire that goes nowhere. The only defence is to keep asking.
 */
const PING_EVERY_MS = 25_000
const SILENCE_LIMIT_MS = 70_000

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
}

export class WebSocketClient {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = WebSocketClient.CONNECTING
  protocol = ''

  /** Kept for shape only: this client always hands over an ArrayBuffer. */
  binaryType = 'arraybuffer'

  #socket = null
  #listeners = { open: [], message: [], close: [], error: [] }
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  #closeSent = false
  #heartbeat = null
  #lastHeard = 0

  constructor(url, protocols = []) {
    const target = new URL(url)
    const secure = target.protocol === 'wss:'
    const key = randomBytes(16).toString('base64')

    const headers = {
      Host: target.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    }

    const offered = Array.isArray(protocols) ? protocols : [protocols]
    if (offered.length > 0) headers['Sec-WebSocket-Protocol'] = offered.join(', ')

    const send = secure ? httpsRequest : httpRequest
    const outgoing = send({
      protocol: secure ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
    })

    outgoing.on('upgrade', (response, socket, head) => {
      // The server proves it understood the handshake by hashing our key back at us. Checked
      // rather than glanced at: it is what stops a caching proxy, or a plain HTTP server with
      // an opinion, from being talked into an upgrade neither end meant — and the agent's
      // secret has already left in the request that got here.
      const expected = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64')

      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        this.#fail(new Error('WebSocket upgrade answered with the wrong key'))
        return
      }

      this.protocol = response.headers['sec-websocket-protocol'] ?? ''
      this.#socket = socket
      socket.setNoDelay(true)

      this.readyState = WebSocketClient.OPEN
      this.#lastHeard = Date.now()
      this.#startHeartbeat()
      this.#emit('open', {})

      // Bytes can arrive glued to the handshake response, before any listener exists.
      if (head?.length) this.#receive(head)

      socket.on('data', (chunk) => this.#receive(chunk))
      socket.on('error', (error) => this.#fail(error))
      socket.on('close', () => this.#shut(1006, ''))
    })

    // A server that refuses the upgrade answers normally instead, and the status line is the
    // only thing that says why.
    outgoing.on('response', (response) => {
      response.resume()
      this.#fail(new Error(`WebSocket refused: HTTP ${response.statusCode}`))
    })

    outgoing.on('error', (error) => this.#fail(error))
    outgoing.end()
  }

  addEventListener(type, handler) {
    this.#listeners[type]?.push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.#listeners[type]
    if (!list) return
    const at = list.indexOf(handler)
    if (at >= 0) list.splice(at, 1)
  }

  send(data) {
    if (this.readyState !== WebSocketClient.OPEN) return

    const binary = typeof data !== 'string'
    const payload = binary ? Buffer.from(data) : Buffer.from(data, 'utf8')
    this.#write(binary ? OPCODE.binary : OPCODE.text, payload)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WebSocketClient.CLOSED) return
    if (this.readyState === WebSocketClient.OPEN && !this.#closeSent) {
      this.#closeSent = true
      const body = Buffer.alloc(2 + Buffer.byteLength(reason))
      body.writeUInt16BE(code, 0)
      body.write(reason, 2)
      this.#write(OPCODE.close, body)
    }
    this.readyState = WebSocketClient.CLOSING
    // Servers that never answer a close must not hold the agent open for ever.
    this.#socket?.end()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  #emit(type, event) {
    for (const handler of this.#listeners[type] ?? []) handler(event)
  }

  #fail(error) {
    this.#emit('error', { message: error.message, error })
    this.#shut(1006, error.message)
  }

  #shut(code, reason) {
    if (this.readyState === WebSocketClient.CLOSED) return
    this.readyState = WebSocketClient.CLOSED
    clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#socket?.destroy()
    this.#socket = null
    this.#emit('close', { code, reason, wasClean: code === 1000 })
  }

  /**
   * Says something regularly and listens for anything at all coming back.
   *
   * A ping is answered by a pong, but the check is deliberately looser than that: any byte
   * from the other end counts as proof of life, because a busy socket carrying video has
   * already answered the question a hundred times over.
   */
  #startHeartbeat() {
    this.#heartbeat = setInterval(() => {
      if (this.readyState !== WebSocketClient.OPEN) return

      if (Date.now() - this.#lastHeard > SILENCE_LIMIT_MS) {
        // Half open: the network went away without anybody sending a close, which is what a
        // sleeping laptop or a rebooting router leaves behind. Nothing will ever arrive on
        // this socket again, so it is treated as gone rather than waited on.
        this.#fail(new Error('no answer from the server'))
        return
      }

      this.#write(OPCODE.ping, Buffer.alloc(0))
    }, PING_EVERY_MS)

    // Never keep the process alive on its own account.
    this.#heartbeat.unref?.()
  }

  /**
   * Every client frame is masked, which is not for secrecy — the key travels with it — but so
   * that a proxy in the middle cannot be tricked into reading the payload as its own request.
   */
  #write(opcode, payload) {
    const socket = this.#socket
    if (!socket) return

    const length = payload.length
    const header = []

    header.push(0x80 | opcode)

    if (length < 126) {
      header.push(0x80 | length)
    } else if (length < 65536) {
      header.push(0x80 | 126, length >> 8, length & 0xff)
    } else {
      const high = Math.floor(length / 2 ** 32)
      header.push(
        0x80 | 127,
        (high >> 24) & 0xff,
        (high >> 16) & 0xff,
        (high >> 8) & 0xff,
        high & 0xff,
        (length >>> 24) & 0xff,
        (length >>> 16) & 0xff,
        (length >>> 8) & 0xff,
        length & 0xff
      )
    }

    const mask = randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3]

    socket.write(Buffer.concat([Buffer.from(header), mask, masked]))
  }

  #receive(chunk) {
    // Any byte at all, not just a pong: a socket carrying frames is plainly alive.
    this.#lastHeard = Date.now()
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk

    for (;;) {
      const frame = this.#readFrame()
      if (!frame) return
      this.#dispatch(frame)
      if (this.readyState === WebSocketClient.CLOSED) return
    }
  }

  /** Returns null when the buffer does not hold a whole frame yet, which is most of the time. */
  #readFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return null

    const final = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      // Anything this large is a bug at the other end, not a doorbell.
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.#fail(new Error('WebSocket frame too large'))
        return null
      }
      length = Number(big)
      offset += 8
    }

    // Reached by the two-byte form as well, so one ceiling covers every way a length arrives.
    if (length > MAX_FRAME_BYTES) {
      this.#fail(new Error('WebSocket frame too large'))
      return null
    }

    // A server must not mask, but reading it costs nothing and refusing would be brittle.
    const mask = masked ? buffer.subarray(offset, offset + 4) : null
    if (masked) offset += 4

    if (buffer.length < offset + length) return null

    let payload = buffer.subarray(offset, offset + length)
    if (mask) {
      const copy = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) copy[i] = payload[i] ^ mask[i & 3]
      payload = copy
    }

    this.#buffer = buffer.subarray(offset + length)
    return { final, opcode, payload }
  }

  #dispatch(frame) {
    switch (frame.opcode) {
      case OPCODE.ping:
        this.#write(OPCODE.pong, frame.payload)
        return

      case OPCODE.pong:
        return

      case OPCODE.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
        const reason = frame.payload.subarray(2).toString('utf8')
        if (!this.#closeSent) {
          this.#closeSent = true
          this.#write(OPCODE.close, frame.payload)
        }
        this.#shut(code, reason)
        return
      }

      case OPCODE.continuation: {
        // A message split into pieces has no length of its own, so the ceiling that guards a
        // single frame guards nothing here without this.
        const held = this.#fragments.reduce((total, part) => total + part.length, 0)
        if (held + frame.payload.length > MAX_FRAME_BYTES) {
          this.#fail(new Error('WebSocket message too large'))
          return
        }
        this.#fragments.push(frame.payload)
        break
      }

      default:
        // A new message. Text and binary are the only two that start one.
        this.#fragments = [frame.payload]
        this.#fragmentOpcode = frame.opcode
        break
    }

    if (!frame.final) return

    const body = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments)
    this.#fragments = []

    this.#emit('message', {
      data:
        this.#fragmentOpcode === OPCODE.text
          ? body.toString('utf8')
          : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    })
  }
}
