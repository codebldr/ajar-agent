// The way to be heard at the gate.
//
// ONVIF Profile T calls it a backchannel: ask for it in DESCRIBE and the camera answers with
// one extra audio track marked `sendonly` — a track the client writes instead of reads. Audio
// written there comes out of the speaker at the gate, and that is the whole trick.
//
// What matters is what it does *not* do. It needs no call, so nothing rings; the intercom
// stays idle, the indoor monitors stay quiet, and there is no ringback tone playing over the
// top of whoever is speaking. Every other route into that speaker had to start a call first,
// which woke the entire house to say one sentence to a courier.
//
// This is also how go2rtc reaches these doorbells, which is how the track was found at all.

import { connect } from 'node:net'
import { authorisation, parseChallenge } from './digest.mjs'

/** The header that makes the camera offer the extra track. Without it the SDP has two tracks. */
const BACKCHANNEL = 'www.onvif.org/ver20/backchannel'

/** Interleaved frames start with this, per RFC 2326 section 10.12. */
const MAGIC = 0x24

/** RTSP sessions time out around 60s; a keepalive well inside that is cheap. */
const KEEPALIVE_MS = 25_000

/** 20 ms of audio per packet: small enough to stay conversational, large enough to be cheap. */
const PACKET_MS = 20

const HANDSHAKE_TIMEOUT_MS = 8_000

/**
 * Opens the talk path and resolves once the gate is listening.
 *
 * `write(pcm)` takes 16-bit little-endian PCM at the track's sample rate — the format the
 * phone already records in — and handles the rest.
 */
export async function openBackchannel(options) {
  const {
    host,
    port = 554,
    path = '/cam/realmonitor?channel=1&subtype=1',
    username,
    password,
    onError,
  } = options

  const url = `rtsp://${host}:${port}${path}`
  const socket = connect(port, host)

  // Voice arrives in 20 ms pieces, which is precisely the size Nagle's algorithm likes to sit
  // on until it has company. Held packets are heard as delay, so send each one as it is made.
  socket.setNoDelay(true)

  let cseq = 0
  let challenge = null
  let nonceCount = 0
  let session = null
  let closed = false
  let keepalive = null
  let buffer = Buffer.alloc(0)
  const pending = []

  const shutdown = () => {
    if (closed) return false
    closed = true
    clearInterval(keepalive)
    socket.destroy()
    return true
  }

  const fail = (error) => {
    if (!shutdown()) return
    while (pending.length) pending.shift().reject(error)
    onError?.(error)
  }

  socket.on('error', fail)
  socket.on('close', () => fail(new Error('the intercom closed the talk channel')))

  // Responses and media share one socket, so both are read from one buffer. Nothing is
  // expected on the media channels here — only the talk track was set up — but the camera is
  // free to send, and unread bytes would desynchronise every reply after them.
  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

    for (;;) {
      if (buffer.length === 0) return

      if (buffer[0] === MAGIC) {
        if (buffer.length < 4) return
        const length = buffer.readUInt16BE(2)
        if (buffer.length < 4 + length) return
        buffer = buffer.subarray(4 + length)
        continue
      }

      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const head = buffer.subarray(0, headerEnd).toString('utf8')
      const [statusLine, ...headerLines] = head.split('\r\n')
      const headers = {}
      for (const line of headerLines) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }

      const bodyLength = Number(headers['content-length'] ?? 0)
      const total = headerEnd + 4 + bodyLength
      if (buffer.length < total) return

      const body = buffer.subarray(headerEnd + 4, total).toString('utf8')
      buffer = buffer.subarray(total)

      const parts = statusLine.split(' ')
      pending.shift()?.resolve({
        status: Number(parts[1]),
        reason: parts.slice(2).join(' '),
        headers,
        body,
      })
    }
  })

  function send(method, extra = {}, target = url) {
    cseq += 1
    const headers = { CSeq: String(cseq), 'User-Agent': 'ajar-agent', ...extra }
    if (session) headers.Session = session

    if (challenge) {
      nonceCount += 1
      headers.Authorization = authorisation(challenge, {
        method,
        uri: target,
        username,
        password,
        nonceCount,
      })
    }

    const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
    socket.write(`${method} ${target} RTSP/1.0\r\n${lines.join('\r\n')}\r\n\r\n`)

    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }

  async function request(method, extra, target) {
    let response = await send(method, extra, target)

    if (response.status === 401) {
      const header = response.headers['www-authenticate']
      if (!header) throw new Error(`${method} refused with no digest challenge`)
      challenge = parseChallenge(header)
      nonceCount = 0
      response = await send(method, extra, target)
    }

    if (response.status !== 200) {
      throw new Error(`${method} failed: ${response.status} ${response.reason}`)
    }

    return response
  }

  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const guard = setTimeout(
    () => fail(new Error('the intercom did not open the talk channel in time')),
    HANDSHAKE_TIMEOUT_MS
  )
  guard.unref?.()

  try {
    await connected
    await request('OPTIONS')

    const described = await request('DESCRIBE', {
      Accept: 'application/sdp',
      Require: BACKCHANNEL,
    })

    const track = findSendonlyTrack(described.body)
    if (!track) throw new Error('this intercom offers no talk track')

    const setup = await request(
      'SETUP',
      {
        // The camera ignores this and picks its own channel numbers; the answer is what counts.
        Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
        Require: BACKCHANNEL,
      },
      `${url}/${track.control}`
    )

    session = setup.headers.session?.split(';')[0] ?? null
    const channel = Number(/interleaved=(\d+)/.exec(setup.headers.transport ?? '')?.[1] ?? 0)

    await request('PLAY', { Range: 'npt=0.000-', Require: BACKCHANNEL })
    clearTimeout(guard)

    keepalive = setInterval(() => {
      request('OPTIONS').catch(() => {})
    }, KEEPALIVE_MS)
    keepalive.unref?.()

    return new Speaker({
      socket,
      channel,
      track,
      request,
      fail,
      shutdown,
      isClosed: () => closed,
    })
  } catch (error) {
    clearTimeout(guard)
    fail(error)
    throw error
  }
}

/**
 * Picks the track the client is allowed to write. A camera answers with its video and its
 * microphone marked `recvonly`; the talk path is the one media block marked `sendonly`.
 */
function findSendonlyTrack(sdp) {
  let current = null

  for (const raw of sdp.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('m=')) {
      const [kind, , , payloadType] = line.slice(2).split(' ')
      current = kind === 'audio' ? { payloadType: Number(payloadType), rate: 8_000 } : null
      continue
    }

    if (!current) continue

    if (line.startsWith('a=rtpmap:')) {
      const rate = Number(line.split('/')[1])
      if (Number.isFinite(rate)) current.rate = rate
      continue
    }

    if (line.startsWith('a=control:')) {
      current.control = line.slice('a=control:'.length).trim()
      continue
    }

    if (line === 'a=sendonly' && current.control) return current
  }

  return null
}

/** The open talk path. Everything it needs was settled during the handshake. */
class Speaker {
  #socket
  #channel
  #request
  #fail
  #shutdown
  #isClosed

  #payloadType
  #packetBytes
  #packetSamples

  #pending = Buffer.alloc(0)
  #sequence = 0
  #timestamp = 0

  constructor({ socket, channel, track, request, fail, shutdown, isClosed }) {
    this.#socket = socket
    this.#channel = channel
    this.#request = request
    this.#fail = fail
    this.#shutdown = shutdown
    this.#isClosed = isClosed

    this.#payloadType = track.payloadType
    this.#packetSamples = Math.round((track.rate * PACKET_MS) / 1000)
    this.#packetBytes = this.#packetSamples * 2

    // A different SSRC each time would be tidier, but the number only has to be stable within
    // one session and unremarkable to the camera.
    this.ssrc = 0x616a6172
    this.rate = track.rate
  }

  /**
   * Takes 16-bit little-endian PCM and sends whole packets. A partial packet is held back
   * rather than padded — silence spliced into the middle of a word is audible.
   */
  write(pcm) {
    if (this.#isClosed()) return

    this.#pending = this.#pending.length === 0 ? pcm : Buffer.concat([this.#pending, pcm])

    while (this.#pending.length >= this.#packetBytes) {
      const slice = Buffer.from(this.#pending.subarray(0, this.#packetBytes))
      this.#pending = this.#pending.subarray(this.#packetBytes)

      // L16 is defined in network order; the phone records the other way round.
      slice.swap16()
      this.#sendPacket(slice)
    }
  }

  #sendPacket(payload) {
    const header = Buffer.alloc(12)
    header[0] = 0x80
    header[1] = this.#payloadType
    header.writeUInt16BE(this.#sequence & 0xffff, 2)
    header.writeUInt32BE(this.#timestamp >>> 0, 4)
    header.writeUInt32BE(this.ssrc, 8)

    this.#sequence += 1
    this.#timestamp = (this.#timestamp + this.#packetSamples) >>> 0

    const frame = Buffer.alloc(4)
    frame[0] = MAGIC
    frame[1] = this.#channel
    frame.writeUInt16BE(header.length + payload.length, 2)

    try {
      // One write, so one packet leaves the machine.
      this.#socket.write(Buffer.concat([frame, header, payload]))
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Ends the session politely, so the camera frees the track instead of waiting out a timeout. */
  async close() {
    if (this.#isClosed()) return
    await this.#request('TEARDOWN').catch(() => {})
    this.#shutdown()
  }
}
