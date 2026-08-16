// The house network server, which is the only part of the agent a stranger can knock on.
//
// Everything here was a real decision with a real cost: the ceilings, the connection cap and the
// rekey all exist because without them somebody on the wifi could take the doorbell away, or keep
// watching a camera they had been thrown out of. They read like paranoia until they are removed.

import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { LOCAL_PORT, LocalServer } from '../local.mjs'

const KEY = 'the-house-key'

let server
let messages = []

const said = (fragment) => messages.some((line) => line.includes(fragment))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One length-prefixed frame, the shape both ends speak. */
const framed = (payload) => {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

const jsonFrame = (value) =>
  framed(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value), 'utf8')]))

/** Says something to the server and reports what came back, if anything. */
function talk(payload, { keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const socket = connect(LOCAL_PORT, '127.0.0.1')
    let answer = null

    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      answer = JSON.parse(chunk.subarray(5).toString('utf8'))
      if (!keepOpen) socket.destroy()
    })
    socket.on('error', () => {})
    socket.on('close', () => resolve({ answer, socket }))

    if (keepOpen) setTimeout(() => resolve({ answer, socket }), 300)
  })
}

describe('the house network server', () => {
  before(async () => {
    server = new LocalServer({
      key: KEY,
      serial: 'TEST123',
      onViewer: () => {},
      onGone: () => {},
      onMessage: () => {},
      onPair: async () => '123456',
      log: (line) => messages.push(line),
    })
    server.start()
    await pause(150)
  })

  after(() => server.stop())

  test('lets in a phone that knows the key', async () => {
    const viewer = await talk(jsonFrame({ key: KEY }), { keepOpen: true })
    await pause(100)

    assert.equal(server.viewers, 1)
    viewer.socket.destroy()
    await pause(100)
  })

  test('turns away a phone that does not', async () => {
    messages = []
    await talk(jsonFrame({ key: 'not-the-key' }))
    await pause(100)

    assert.equal(server.viewers, 0)
    assert.ok(said('wrong key'), 'the refusal should say why')
  })

  test('refuses a hello larger than a hello', async () => {
    // Before the key is checked, a socket may not make the agent hold four megabytes.
    messages = []
    await talk(framed(Buffer.concat([Buffer.from([0]), Buffer.alloc(8 * 1024, 0x41)])))
    await pause(100)

    assert.ok(
      said('sent nonsense') || said('sent too much'),
      'an oversized hello should be cut off'
    )
  })

  test('hands out a pairing code, then asks the next one to wait', async () => {
    const first = await talk(jsonFrame({ pair: true }))
    const second = await talk(jsonFrame({ pair: true }))

    assert.equal(first.answer.type, 'pair')
    assert.equal(first.answer.code, '123456')
    assert.equal(second.answer.type, 'pair-error')
  })

  test('caps how many strangers may be here at once', async () => {
    messages = []
    const strangers = []
    for (let i = 0; i < 40; i += 1) {
      strangers.push(connect(LOCAL_PORT, '127.0.0.1').on('error', () => {}))
    }
    await pause(300)

    assert.ok(said('too many connections already'), 'the flood should be capped')
    strangers.forEach((socket) => socket.destroy())
    await pause(100)
  })

  test('rekeying drops everyone and retires the old key', async () => {
    const viewer = await talk(jsonFrame({ key: KEY }), { keepOpen: true })
    await pause(100)
    assert.equal(server.viewers, 1)

    server.rekey('a-brand-new-key')
    await pause(100)
    assert.equal(server.viewers, 0, 'a rekey should disconnect whoever is watching')

    await talk(jsonFrame({ key: KEY }))
    await pause(100)
    assert.equal(server.viewers, 0, 'the old key must stop working')

    const returning = await talk(jsonFrame({ key: 'a-brand-new-key' }), { keepOpen: true })
    await pause(100)
    assert.equal(server.viewers, 1, 'the new key must work')

    viewer.socket.destroy()
    returning.socket.destroy()
    await pause(100)
  })
})
