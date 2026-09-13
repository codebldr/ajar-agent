// The house network server, which is the only part of the agent a stranger can knock on.
//
// Everything here was a real decision with a real cost: the ceilings, the connection cap and the
// rekey all exist because without them somebody on the wifi could take the doorbell away, or keep
// watching a camera they had been thrown out of. They read like paranoia until they are removed.

import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { BEACON_PORT, LOCAL_PORT, LocalServer, isHouseAddress, startBeacon } from '../local.mjs'

const KEY = 'the-house-key'
const INTERCOM_PASSWORD = 'what-is-typed-into-the-intercom'

let server
let messages = []
/** How each pairing code was asked for, which is what decides admin or waiting room. */
let vias = []
/** What reached the agent from phones that got in. */
let received = []
/** The way back to each phone that got in, so a test can play the camera at it. */
let sinks = []

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
      onViewer: (sink) => sinks.push(sink),
      onGone: () => {},
      onMessage: (message) => received.push(message),
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

  // Every key holder presents the same key here, so this end cannot tell a guest who may read
  // the history from one an admin has kept out of it. The Worker can, and the app already asks
  // it for the history even from the hallway — so this end does not serve it at all.
  test('does not hand out the history, which only the Worker can ration', async () => {
    received = []
    const viewer = await talk(jsonFrame({ key: 'a-brand-new-key' }), { keepOpen: true })

    for (const type of ['history-list', 'history-thumb', 'history-clip', 'history-play']) {
      viewer.socket.write(jsonFrame({ type, id: 'x' }))
    }
    viewer.socket.write(jsonFrame({ type: 'stream-quality', quality: 'hd' }))
    await pause(100)

    assert.deepEqual(
      received.map((message) => message.type),
      ['stream-quality'],
      'the camera controls get through; the history does not'
    )
    viewer.socket.destroy()
    await pause(100)
  })

  test('rings the house for a test once a minute, however often it is asked', async () => {
    received = []
    const viewer = await talk(jsonFrame({ key: 'a-brand-new-key' }), { keepOpen: true })

    for (let i = 0; i < 5; i += 1) viewer.socket.write(jsonFrame({ type: 'test-ring' }))
    await pause(100)

    assert.equal(received.filter((message) => message.type === 'test-ring').length, 1)
    viewer.socket.destroy()
    await pause(100)
  })

  test('lets go of a phone that has stopped reading', async () => {
    // A phone that walks out of wifi range mid-stream stops reading without hanging up. Every
    // frame for it used to wait in memory, for as long as TCP took to give up — a quarter of
    // an hour of HD video on a machine with a gigabyte.
    sinks = []
    const watching = server.viewers
    const socket = connect(LOCAL_PORT, '127.0.0.1').on('error', () => {})
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(jsonFrame({ key: 'a-brand-new-key' }))
    await pause(100)
    assert.equal(server.viewers, watching + 1)

    socket.pause()
    const sink = sinks.at(-1)
    for (let i = 0; i < 32; i += 1) sink.sendBinary(Buffer.alloc(1024 * 1024))
    await pause(200)

    assert.equal(server.viewers, watching, 'the phone that fell behind is let go')
    socket.destroy()
    await pause(100)
  })

  test('writes down only so many refusals, however many there are', async () => {
    // Anyone on the wifi can open and drop a socket thousands of times a second. On a NAS or a
    // Mac nothing trims the log, so every refusal written down was disk somebody else chose to
    // fill.
    messages = []
    for (let i = 0; i < 40; i += 1) {
      await talk(jsonFrame({ key: `guess-${i}` }))
    }
    await pause(100)

    const refusals = messages.filter((line) => line.startsWith('local: refused'))
    assert.ok(refusals.length <= 20, `${refusals.length} refusals written down`)
    assert.equal(server.viewers, 0)
  })
})

describe('who counts as inside the house', () => {
  test('the private networks a house is on', () => {
    for (const address of [
      '192.168.1.20',
      '10.0.0.7',
      '172.20.1.1',
      '::ffff:192.168.100.2',
      '127.0.0.1',
      '::1',
      'fe80::1c2d:3e4f',
      'fd12:3456:789a::1',
    ]) {
      assert.equal(isHouseAddress(address), true, address)
    }
  })

  test('not the internet, and not the mobile network', () => {
    // A Pi with a public IPv6 address and a router that lets it in would otherwise take pairing
    // requests from anywhere in the world.
    for (const address of [
      '2a02:2f0e:1234::1',
      '8.8.8.8',
      '::ffff:86.1.2.3',
      '100.64.1.1',
      '',
      undefined,
    ]) {
      assert.equal(isHouseAddress(address), false, String(address))
    }
  })
})

describe('the beacon', () => {
  test('writes down that it answered, not every time', async () => {
    const lines = []
    const beacon = startBeacon({ serial: 'TEST123', log: (line) => lines.push(line) })
    await pause(100)

    const phone = createSocket('udp4')
    for (let i = 0; i < 5; i += 1) {
      phone.send(Buffer.from('AJAR?'), BEACON_PORT, '127.0.0.1')
      await pause(20)
    }
    await pause(100)

    phone.close()
    beacon.close()

    const answered = lines.filter((line) => line.startsWith('beacon: answered'))
    assert.equal(answered.length, 1, `${answered.length} lines for five answers`)
  })
})
