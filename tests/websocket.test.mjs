// The WebSocket client, against a server written here rather than the real Worker.
//
// The handshake check earns its place: the agent's secret has already left in the request that
// gets this far, and a proxy or a plain HTTP server talked into an upgrade would be holding it.
// The size ceilings earn theirs because the other end declares how much it is about to send.

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocketClient } from '../ws.mjs'

/** RFC 6455 section 1.3. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * A server that completes the handshake — correctly or not — and then sends whatever the test
 * asks for.
 */
function serve({ accept = 'correct', send }) {
  const server = createServer()
  const sockets = new Set()

  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    // The client hangs up on purpose in most of these, and a reset arriving after a test has
    // finished would otherwise be reported as that test failing.
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))

    const answer =
      accept === 'correct'
        ? createHash('sha1')
            .update(request.headers['sec-websocket-key'] + GUID)
            .digest('base64')
        : 'obviouslyWrongAcceptValue=='

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${answer}\r\n` +
        'Sec-WebSocket-Protocol: ajar-agent\r\n\r\n'
    )

    send?.(socket)
  })

  const stop = () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    server.close()
  }

  return new Promise((resolve) => {
    server.listen(0, () => resolve({ stop, port: server.address().port }))
  })
}

/** A server frame: unmasked, final, text unless told otherwise. */
const textFrame = (value) => {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([0x81, body.length]), body])
}

/** Waits for whichever comes first: a message, or the connection giving up. */
function firstOutcome(port) {
  return new Promise((resolve) => {
    const client = new WebSocketClient(`ws://127.0.0.1:${port}/agent`, ['ajar-agent', 'secret'])
    const done = (outcome) => {
      clearTimeout(timer)
      // Closed here rather than by the test, so nothing is left holding the event loop open
      // after the assertions have run.
      client.close()
      resolve(outcome)
    }

    const timer = setTimeout(() => done({ kind: 'silence' }), 2_000)

    client.addEventListener('message', (event) => done({ kind: 'message', data: event.data }))
    client.addEventListener('error', (event) => done({ kind: 'error', message: event.message }))
  })
}

describe('the WebSocket client', () => {
  test('accepts a server that answers the handshake correctly', async () => {
    const { stop, port } = await serve({
      send: (socket) => socket.write(textFrame(JSON.stringify({ type: 'hello' }))),
    })

    const outcome = await firstOutcome(port)
    stop()

    assert.equal(outcome.kind, 'message')
    assert.equal(JSON.parse(outcome.data).type, 'hello')
  })

  test('refuses a server that answers with the wrong key', async () => {
    const { stop, port } = await serve({
      accept: 'wrong',
      send: (socket) => socket.write(textFrame(JSON.stringify({ type: 'hello' }))),
    })

    const outcome = await firstOutcome(port)
    stop()

    assert.equal(outcome.kind, 'error')
    assert.match(outcome.message, /wrong key/)
  })

  test('hangs up on a frame that claims to carry a gigabyte', async () => {
    const { stop, port } = await serve({
      send: (socket) => {
        const header = Buffer.alloc(10)
        header[0] = 0x82
        header[1] = 127
        header.writeBigUInt64BE(1_073_741_824n, 2)
        socket.write(header)
      },
    })

    const outcome = await firstOutcome(port)
    stop()

    assert.equal(outcome.kind, 'error')
    assert.match(outcome.message, /too large/)
  })

  test('computes the handshake answer the way RFC 6455 says', () => {
    // The example from the specification, so a rewrite of this cannot quietly invent its own.
    const accept = createHash('sha1')
      .update('dGhlIHNhbXBsZSBub25jZQ==' + GUID)
      .digest('base64')

    assert.equal(accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})
