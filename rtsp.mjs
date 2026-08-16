// An RTSP client just large enough to pull one camera off a Dahua intercom.
//
// Written by hand rather than pulled from npm for the same reason the rest of the agent has
// no dependencies: this program opens gates, and every package it installs is another way in.
// What it needs is narrow — one stream, one codec, no seeking, no recording — and that fits
// in a file you can read in a sitting.
//
// Everything runs over the single TCP connection RTSP is already using ("interleaved"
// transport). UDP would be lower overhead and is the first thing a home router drops.

import { connect } from 'node:net'
import { authorisation, parseChallenge } from './digest.mjs'

/** RTSP session timeouts are usually 60s; a keepalive well inside that is cheap insurance. */
const KEEPALIVE_MS = 25_000

/** Interleaved frames start with this, per RFC 2326 section 10.12. */
const MAGIC = 0x24

/**
 * How much unread text the other end may leave sitting here.
 *
 * Media frames carry their own length and cannot exceed 64 kB by definition. RTSP text does
 * not: a reply with no end of headers, or a `Content-Length` of a gigabyte, would have this
 * buffer grow until the machine gave up. The largest real reply is the SDP, at under a
 * kilobyte.
 */
const MAX_TEXT_BYTES = 256 * 1024

/**
 * Opens a stream and calls back with reassembled H.264 access units.
 *
 * `onVideo({ data, keyframe, timestamp })` receives Annex-B bytes, which is what Android's
 * MediaCodec wants, so nothing has to be repackaged later.
 *
 * `onConfig({ sps, pps, width, height })` fires once, before any frame. A decoder cannot
 * start without these, and they arrive in the SDP rather than in the stream.
 */
export function openStream(options) {
  const {
    host,
    port = 554,
    path = '/cam/realmonitor?channel=1&subtype=1',
    username,
    password,
    onVideo,
    onAudio,
    onConfig,
    onError,
    onClose,
  } = options

  const url = `rtsp://${host}:${port}${path}`

  let socket = connect(port, host)
  let cseq = 0
  let session = null
  let challenge = null
  let nonceCount = 0
  let closed = false
  let keepalive = null

  // Requests are answered in order on one connection, so a queue of resolvers is enough to
  // match responses to requests without tracking CSeq by hand.
  const pending = []
  let buffer = Buffer.alloc(0)

  const fail = (error) => {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    socket.destroy()
    onError?.(error)
  }

  function send(method, extraHeaders = {}, targetUrl = url) {
    cseq += 1

    const headers = {
      CSeq: String(cseq),
      'User-Agent': 'ajar-agent',
      ...extraHeaders,
    }

    if (session) headers.Session = session

    if (challenge) {
      nonceCount += 1
      headers.Authorization = authorisation(challenge, {
        method,
        uri: targetUrl,
        username,
        password,
        nonceCount,
      })
    }

    const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
    socket.write(`${method} ${targetUrl} RTSP/1.0\r\n${lines.join('\r\n')}\r\n\r\n`)

    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject, method, targetUrl })
    })
  }

  /**
   * Sends, and on a 401 answers the challenge and sends again. The intercom challenges the
   * first request of a session and then accepts credentials on every one after.
   */
  async function request(method, extraHeaders, targetUrl) {
    let response = await send(method, extraHeaders, targetUrl)

    if (response.status === 401) {
      const header = response.headers['www-authenticate']
      if (!header) throw new Error(`${method} refused with no digest challenge`)
      challenge = parseChallenge(header)
      nonceCount = 0
      response = await send(method, extraHeaders, targetUrl)
    }

    if (response.status !== 200) {
      throw new Error(`${method} failed: ${response.status} ${response.reason}`)
    }

    return response
  }

  // ── Reading ────────────────────────────────────────────────────────────
  //
  // Two kinds of data share the socket: RTSP text and binary media, the latter prefixed with
  // `$`, a channel byte and a length. They are read from one buffer because they arrive
  // interleaved by definition.

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

    for (;;) {
      if (buffer.length === 0) return

      if (buffer[0] === MAGIC) {
        if (buffer.length < 4) return
        const channel = buffer[1]
        const length = buffer.readUInt16BE(2)
        if (buffer.length < 4 + length) return

        const packet = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
        handleRtp(channel, packet)
        continue
      }

      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        // No end of headers in sight and the buffer already past anything real: the other end
        // is not speaking RTSP, and waiting costs memory for nothing.
        if (buffer.length > MAX_TEXT_BYTES) fail(new Error('RTSP reply with no end of headers'))
        return
      }

      const head = buffer.subarray(0, headerEnd).toString('utf8')
      const response = parseResponse(head)
      const bodyLength = Number(response.headers['content-length'] ?? 0)

      if (!Number.isFinite(bodyLength) || bodyLength < 0 || bodyLength > MAX_TEXT_BYTES) {
        return fail(new Error(`RTSP reply claimed ${bodyLength} bytes of body`))
      }

      const total = headerEnd + 4 + bodyLength
      if (buffer.length < total) return

      response.body = buffer.subarray(headerEnd + 4, total).toString('utf8')
      buffer = buffer.subarray(total)

      pending.shift()?.resolve(response)
    }
  })

  socket.on('error', fail)
  socket.on('close', () => {
    clearInterval(keepalive)
    if (!closed) {
      closed = true
      onClose?.()
    }
  })

  // ── Media ──────────────────────────────────────────────────────────────

  let videoChannel = 0
  let audioChannel = 2
  const assembler = new AccessUnitAssembler(onVideo)

  function handleRtp(channel, packet) {
    // Odd channels carry RTCP, which is only sender reports here.
    if (channel === videoChannel) {
      const rtp = parseRtp(packet)
      if (rtp) assembler.push(rtp)
      return
    }

    if (channel === audioChannel && onAudio) {
      const rtp = parseRtp(packet)
      if (rtp) onAudio({ data: rtp.payload, timestamp: rtp.timestamp })
    }
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  async function start() {
    await request('OPTIONS')

    const described = await request('DESCRIBE', { Accept: 'application/sdp' })
    const sdp = parseSdp(described.body, url)

    if (!sdp.video) throw new Error('The intercom offered no video track')

    onConfig?.({
      sps: sdp.video.sps,
      pps: sdp.video.pps,
      clockRate: sdp.video.clockRate,
    })

    videoChannel = 0
    const videoSetup = await request(
      'SETUP',
      { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' },
      sdp.video.control
    )
    session = (videoSetup.headers.session ?? '').split(';')[0].trim()

    if (sdp.audio && onAudio) {
      audioChannel = 2
      await request(
        'SETUP',
        { Transport: 'RTP/AVP/TCP;unicast;interleaved=2-3' },
        sdp.audio.control
      )
    }

    await request('PLAY', { Range: 'npt=0.000-' })

    keepalive = setInterval(() => {
      // Failure here is not fatal on its own; the socket closing is what ends the stream.
      request('OPTIONS').catch(() => {})
    }, KEEPALIVE_MS)
  }

  start().catch(fail)

  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      // Best effort: the intercom frees the session faster if it is told.
      try {
        if (session) send('TEARDOWN').catch(() => {})
      } catch {
        // Socket already gone.
      }
      socket.end()
      socket.destroy()
    },
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────

function parseResponse(head) {
  const [statusLine, ...headerLines] = head.split('\r\n')
  const match = /^RTSP\/1\.0 (\d+) ?(.*)$/.exec(statusLine)

  const headers = {}
  for (const line of headerLines) {
    const index = line.indexOf(':')
    if (index === -1) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }

  return {
    status: match ? Number(match[1]) : 0,
    reason: match ? match[2] : statusLine,
    headers,
    body: '',
  }
}

/**
 * Pulls out what a decoder needs: where each track lives, and the parameter sets that H.264
 * carries out of band.
 */
function parseSdp(body, baseUrl) {
  const result = { video: null, audio: null }
  let current = null

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line.startsWith('m=')) {
      const [kind, , , payloadType] = line.slice(2).split(' ')
      current = { kind, payloadType: Number(payloadType), control: baseUrl }
      if (kind === 'video') result.video = current
      else if (kind === 'audio') result.audio = current
      continue
    }

    if (!current) continue

    if (line.startsWith('a=control:')) {
      const control = line.slice('a=control:'.length).trim()
      current.control =
        control === '*' || control === ''
          ? baseUrl
          : control.startsWith('rtsp://')
            ? control
            : `${baseUrl}/${control}`
      continue
    }

    if (line.startsWith('a=rtpmap:')) {
      const parts = line.split(/[\s/]+/)
      current.clockRate = Number(parts[2])
      continue
    }

    if (line.startsWith('a=fmtp:') && line.includes('sprop-parameter-sets=')) {
      const sets = /sprop-parameter-sets=([^;\s]+)/.exec(line)?.[1] ?? ''
      const [sps, pps] = sets.split(',')
      if (sps) current.sps = Buffer.from(sps, 'base64')
      if (pps) current.pps = Buffer.from(pps, 'base64')
    }
  }

  return result
}

/** RFC 3550 section 5.1. Extensions are skipped rather than parsed; nothing here reads them. */
function parseRtp(packet) {
  if (packet.length < 12) return null

  const csrcCount = packet[0] & 0x0f
  const hasExtension = (packet[0] & 0x10) !== 0
  const marker = (packet[1] & 0x80) !== 0
  const timestamp = packet.readUInt32BE(4)

  let offset = 12 + csrcCount * 4
  if (hasExtension) {
    if (packet.length < offset + 4) return null
    offset += 4 + packet.readUInt16BE(offset + 2) * 4
  }

  if (offset >= packet.length) return null

  return { payload: packet.subarray(offset), marker, timestamp }
}

// ── H.264 ────────────────────────────────────────────────────────────────

const START_CODE = Buffer.from([0, 0, 0, 1])

/**
 * Turns RTP payloads into whole access units — one decodable picture each.
 *
 * A picture rarely fits in one packet, so H.264 over RTP has three shapes: a NAL unit on its
 * own, several small ones bundled together, and one large one cut into fragments. All three
 * appear on this intercom, and a decoder fed the pieces raw produces nothing.
 */
class AccessUnitAssembler {
  #onVideo
  #nals = []
  #fragment = null
  #timestamp = 0

  constructor(onVideo) {
    this.#onVideo = onVideo
  }

  push({ payload, marker, timestamp }) {
    const type = payload[0] & 0x1f

    if (type >= 1 && type <= 23) {
      this.#collect(payload)
    } else if (type === 24) {
      this.#unpackAggregate(payload)
    } else if (type === 28) {
      this.#unpackFragment(payload)
    }

    this.#timestamp = timestamp

    // The marker bit is the encoder saying "that was the last packet of this picture".
    if (marker) this.#flush()
  }

  #collect(nal) {
    this.#nals.push(START_CODE, nal)
  }

  /** STAP-A: several NAL units in one packet, each behind a two byte length. */
  #unpackAggregate(payload) {
    let offset = 1
    while (offset + 2 <= payload.length) {
      const size = payload.readUInt16BE(offset)
      offset += 2
      if (offset + size > payload.length) return
      this.#collect(payload.subarray(offset, offset + size))
      offset += size
    }
  }

  /** FU-A: one NAL unit spread over many packets, with the header rebuilt from two bytes. */
  #unpackFragment(payload) {
    if (payload.length < 2) return

    const indicator = payload[0]
    const header = payload[1]
    const start = (header & 0x80) !== 0
    const end = (header & 0x40) !== 0
    const type = header & 0x1f
    const body = payload.subarray(2)

    if (start) {
      this.#fragment = [Buffer.from([(indicator & 0xe0) | type]), body]
      return
    }

    // A fragment whose start was lost cannot be completed, so it is dropped rather than
    // handed to the decoder half formed.
    if (!this.#fragment) return

    this.#fragment.push(body)

    if (end) {
      this.#collect(Buffer.concat(this.#fragment))
      this.#fragment = null
    }
  }

  #flush() {
    if (this.#nals.length === 0) return

    const data = Buffer.concat(this.#nals)
    this.#nals = []
    this.#fragment = null

    this.#onVideo?.({
      data,
      keyframe: containsKeyframe(data),
      timestamp: this.#timestamp,
    })
  }
}

/**
 * True if this access unit can be decoded without anything before it. The phone throws away
 * everything until the first one, because starting mid-picture produces a smear.
 */
function containsKeyframe(data) {
  for (let i = 0; i + 4 < data.length; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      const type = data[i + 4] & 0x1f
      // 5 is an IDR picture; 7 and 8 are the parameter sets that precede one.
      if (type === 5 || type === 7 || type === 8) return true
    }
  }
  return false
}
