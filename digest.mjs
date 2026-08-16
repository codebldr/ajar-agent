// Dahua intercoms speak HTTP Digest, which Node's http client does not do on its own.
// This is the smallest correct implementation: one challenge, one retry.

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex')

/**
 * The largest answer worth reading from the intercom.
 *
 * Every reply this asks for is a few lines of `name=value`; the biggest is the encoder
 * configuration, at a few kilobytes. A device that answers with more than this is broken or is
 * not the device it claims to be, and either way the agent must not sit there collecting it
 * until the machine runs out of memory.
 */
const MAX_BODY_BYTES = 1024 * 1024

/** Turns `Digest realm="x", nonce="y"` into an object, quotes stripped. */
export function parseChallenge(header) {
  const fields = {}
  const body = header.replace(/^Digest\s+/i, '')

  for (const [, key, quoted, bare] of body.matchAll(
    /(\w+)=(?:"([^"]*)"|([^,\s]*))/g
  )) {
    fields[key.toLowerCase()] = quoted ?? bare
  }

  return fields
}

/** RTSP uses the same construction as HTTP, only the method and URI differ. */
export function authorisation(challenge, { method, uri, username, password, nonceCount }) {
  const { realm, nonce, opaque, algorithm } = challenge
  const qop = challenge.qop?.split(',')[0].trim()

  const cnonce = randomBytes(8).toString('hex')
  const nc = String(nonceCount).padStart(8, '0')

  const ha1 = md5(`${username}:${realm}:${password}`)
  const ha2 = md5(`${method}:${uri}`)

  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]

  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (opaque) parts.push(`opaque="${opaque}"`)
  if (algorithm) parts.push(`algorithm=${algorithm}`)

  return `Digest ${parts.join(', ')}`
}

/**
 * Opens a digest-authenticated POST that stays open, for pushing audio to the intercom.
 *
 * The intercom treats this as a pipe rather than a request: it answers nothing, not even a
 * status, and simply plays whatever arrives until the connection is closed. So the challenge
 * has to be collected from a throwaway request first — there is no response to learn it from
 * on the real one.
 */
export function digestPostStream(options) {
  const { host, port = 80, path, username, password, contentType } = options

  return new Promise((resolve, reject) => {
    // The challenge is borrowed from an unrelated GET. Asking for it on the audio endpoint
    // itself does not work: the intercom hangs up on a POST it cannot authenticate rather
    // than answering with one, so there is nothing to learn the realm and nonce from.
    const probe = http.request(
      {
        host,
        port,
        path: '/cgi-bin/magicBox.cgi?action=getSerialNo',
        method: 'GET',
      },
      (response) => {
        response.resume()
        const header = response.headers['www-authenticate']
        if (!header) return reject(new Error('No digest challenge for audio'))

        const auth = authorisation(parseChallenge(header), {
          method: 'POST',
          uri: path,
          username,
          password,
          nonceCount: 1,
        })

        const request = http.request({
          host,
          port,
          path,
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': contentType,
            // Length is unknown: the talking stops when the person stops talking.
            'Transfer-Encoding': 'chunked',
            Connection: 'keep-alive',
          },
        })

        request.on('error', () => {})
        // Nothing comes back; the request object itself is the channel.
        resolve(request)
      }
    )

    probe.on('error', reject)
    probe.end()
  })
}

/**
 * Performs a digest-authenticated GET.
 *
 * `onStream` exists for the event channel, which never ends: the callback receives the live
 * response instead of a buffered body, so the caller can read it for hours.
 */
export function digestGet(options) {
  const {
    host,
    port = 80,
    path,
    username,
    password,
    timeoutMs = 10_000,
    onStream,
    signal,
  } = options

  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const attempt = (authHeader) => {
      const request = http.request(
        {
          host,
          port,
          path,
          method: 'GET',
          headers: authHeader ? { Authorization: authHeader } : {},
          signal,
        },
        (response) => {
          if (response.statusCode === 401 && !authHeader) {
            const header = response.headers['www-authenticate']
            if (!header) {
              response.resume()
              return finish(reject, new Error('401 with no digest challenge'))
            }
            response.resume()
            return attempt(
              authorisation(parseChallenge(header), {
                method: 'GET',
                uri: path,
                username,
                password,
                nonceCount: 1,
              })
            )
          }

          if (response.statusCode !== 200) {
            response.resume()
            return finish(reject, new Error(`HTTP ${response.statusCode} for ${path}`))
          }

          if (onStream) {
            // Handed over live; the caller decides when it is done.
            request.setTimeout(0)
            return finish(resolve, onStream(response))
          }

          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
            if (body.length <= MAX_BODY_BYTES) return
            // Cut off rather than truncated: a reply this size means the other end is not
            // what it is supposed to be, and half of it is not worth acting on.
            request.destroy()
            finish(reject, new Error(`Reply larger than ${MAX_BODY_BYTES} bytes: ${path}`))
          })
          response.on('end', () => finish(resolve, body))
        }
      )

      // Only guards the handshake. Once streaming starts the timeout is cleared above,
      // because an idle event channel is normal, not a fault.
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Timed out after ${timeoutMs}ms: ${path}`))
      })

      request.on('error', (error) => finish(reject, error))
      request.end()
    }

    attempt(null)
  })
}
