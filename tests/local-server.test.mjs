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
const INTERCOM_PASSWORD = 'what-is-typed-into-the-intercom'

let server
let messages = []
/** How each pairing code was asked for, which is what decides admin or waiting room. */
let vias = []

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
      onPair: async (via) => {
        vias.push(via)
        return '123456'
      },
      onReclaim: async (password) => password === INTERCOM_PASSWORD,
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
    vias = []
    const first = await talk(jsonFrame({ pair: true }))
    const second = await talk(jsonFrame({ pair: true }))

    assert.equal(first.answer.type, 'pair')
    assert.equal(first.answer.code, '123456')
    assert.equal(second.answer.type, 'pair-error')
    assert.deepEqual(vias, ['local'], 'reaching the wifi is a local claim, and only that')
  })

  // Gate 2. Being on the house wifi is what everybody in the building can do; knowing what is
  // typed into the intercom's own web page is what a household can do. Only the second one may
  // turn into a code that makes somebody an admin.
  test('refuses to claim the household on a wrong intercom password', async () => {
    vias = []
    const refused = await talk(jsonFrame({ reclaim: true, password: 'guessing' }))

    assert.equal(refused.answer.type, 'reclaim-error')
    assert.equal(refused.answer.error, 'wrong password')
    assert.deepEqual(vias, [], 'a wrong password must not reach the server at all')
  })

  test('claims the household on the right one, as a claim wifi cannot make', async () => {
    vias = []
    // The cooldown between attempts is the brake in front of the only guessable wall here.
    await pause(2_100)
    const claimed = await talk(jsonFrame({ reclaim: true, password: INTERCOM_PASSWORD }))

    assert.equal(claimed.answer.type, 'pair')
    assert.equal(claimed.answer.code, '123456')
    assert.deepEqual(vias, ['console'], 'the code must not be minted as a mere wifi claim')
  })

  test('makes guessing slow', async () => {
    const first = await talk(jsonFrame({ reclaim: true, password: 'one' }))
    const second = await talk(jsonFrame({ reclaim: true, password: 'two' }))

    assert.equal(first.answer.type, 'reclaim-error')
    assert.equal(second.answer.error, 'too soon')
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
