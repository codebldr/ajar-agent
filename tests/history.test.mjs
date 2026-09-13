// What the house remembers, and what it is allowed to forget.
//
// The interesting cases here are the unhappy ones: a visit interrupted by a power cut, an index
// written to twice for the same visit, and a disk filling up. A history that quietly stops
// recording is a feature; a history that quietly fills somebody's disk is a fault, and the line
// between them is the sweep.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { History } from '../history.mjs'

const roots = []

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ajar-history-'))
  roots.push(dir)
  return dir
}

/** One frame as the agent sends it: a kind, a timestamp, and a payload. */
const frame = (kind, payload) => {
  const header = Buffer.alloc(5)
  header[0] = kind
  header.writeUInt32BE(0, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const quiet = () => {}

async function opened(dir, { snapshot, maxBytes, maxEntries } = {}) {
  return new History({ dir, log: quiet, snapshot, maxBytes, maxEntries }).ready()
}

const permissions = (path) => statSync(path).mode & 0o777

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('the history', () => {
  test('keeps a visit, its picture and its video', async () => {
    const dir = scratch()
    const history = await opened(dir, { snapshot: async () => Buffer.from([0xff, 0xd8, 1, 2, 3]) })

    const visit = history.beginVisit({ code: 'Invite' })
    history.sink.send({ type: 'stream-config', sps: 'c3Bz', pps: 'cHBz', displayAspect: 1.7 })
    history.sink.sendBinary(frame(1, 'a keyframe'))
    history.sink.sendBinary(frame(2, 'another frame'))

    // The picture is fetched without anybody waiting for it, so give it its turn.
    await pause(20)
    history.endVisit('done')

    const [entry] = history.list()
    assert.equal(entry.id, visit.id)
    assert.equal(entry.kind, 'ring')
    assert.equal(entry.codec.sps, 'c3Bz')
    assert.ok(entry.clip, 'the visit has a clip')
    assert.ok(entry.thumb, 'the visit has a picture')
    assert.ok(history.clipPath(entry.id), 'and the clip is on disk')
    assert.ok(history.thumbPath(entry.id), 'and so is the picture')
  })

  test('hands out the same sink every time, so leaving the audience works', async () => {
    const dir = scratch()
    const history = await opened(dir)

    // The audience is a set, and joining and leaving it are decided by identity. A sink built
    // fresh on every read cannot be removed: the old one stays, the next visit adds another,
    // and both then write to the same file — which is what turned one thirty second visit into
    // a clip holding fifty pictures a second and sixty seconds of sound.
    assert.equal(history.sink, history.sink, 'the same object, not an equal one')

    const audience = new Set()
    audience.add(history.sink)
    audience.delete(history.sink)
    assert.equal(audience.size, 0, 'and it can leave the audience it joined')
  })

  test('writes each frame once', async () => {
    const dir = scratch()
    const history = await opened(dir)

    history.beginVisit({})
    history.sink.send({ type: 'stream-config', sps: '', pps: '' })
    for (let index = 0; index < 10; index++) {
      history.sink.sendBinary(frame(2, `frame ${index}`))
    }
    history.endVisit('done')
    await pause(50)

    const [entry] = history.list()
    const played = []
    history.play(entry.id, { send: quiet, sendBinary: (chunk) => played.push(chunk) })
    await pause(200)

    assert.equal(played.length, 10, 'ten frames in, ten frames out')
  })

  test('keeps the gate working when it cannot write anywhere', async () => {
    // What a NAS looks like when the folder mounted at /config belongs to root and the
    // container runs as somebody else — and what Home Assistant looks like when a share was
    // never mapped. Before, this came out of startup as "the agent stopped": a house with no
    // doorbell because it could not keep a video.
    const parent = scratch()
    const dir = join(parent, 'history')
    mkdirSync(dir)
    chmodSync(dir, 0o500)

    const said = []
    const history = await new History({ dir, log: (line) => said.push(line) }).ready()

    assert.ok(said.some((line) => line.includes('cannot write')), 'it says so, once')
    assert.equal(history.settings().writable, false)
    assert.equal(history.settings().enabled, false, 'and does not pretend to be recording')

    // The doorbell path still runs, and nothing thrown by it reaches the agent.
    const visit = history.beginVisit({ code: 'Invite' })
    assert.equal(visit.clip, null)
    history.noteAnswered('a phone')
    history.endVisit('done')

    // Coming home, which is the other way in. It used to build an entry and try to write it —
    // so a house with an unwritable folder complained once per gate opening, for ever.
    said.length = 0
    history.noteGateOpened({ by: 'a phone', method: 'app' })
    assert.deepEqual(said, [], 'and says nothing more after the one line at startup')
    assert.deepEqual(history.list(), [])

    // A switch that cannot do anything does not move.
    history.configure({ enabled: true })
    assert.equal(history.settings().enabled, false)

    chmodSync(dir, 0o700)
  })

  test('remembers who answered and who opened the gate', async () => {
    const dir = scratch()
    const history = await opened(dir)

    history.beginVisit({})
    history.noteAnswered('Pixel 7')
    history.noteGateOpened({ by: 'Pixel 7', method: 'app' })
    history.endVisit('done')

    const [entry] = history.list()
    assert.equal(entry.answeredBy, 'Pixel 7')
    assert.equal(entry.openedBy, 'Pixel 7')

    // Coming home is not a visit: nobody rang, so it stands on its own line.
    history.noteGateOpened({ name: 'Blue fob', method: 'card' })
    const [latest] = history.list()
    assert.equal(latest.kind, 'gate')
    assert.equal(latest.openedBy, 'Blue fob')
  })

  test('does not follow a name in the index out of its own folder', async () => {
    // The index is a file on somebody's disk, and on Home Assistant other add-ons can write to
    // it. A picture's name there used to be joined onto the folder as it stood, so
    // "../../agent.json" handed the intercom's password to the next phone that asked for a
    // thumbnail — and the sweep would delete whatever such a name pointed at.
    const parent = scratch()
    const dir = join(parent, 'history')
    mkdirSync(dir)
    const secret = join(parent, 'agent.json')
    writeFileSync(secret, '{"password":"the intercom password"}')

    const planted = { id: '1000-abcdef', at: Date.now(), kind: 'ring', thumb: '../../agent.json', clip: '../../agent.json' }
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(planted)}\n`)

    const history = await opened(dir)
    assert.equal(history.thumbPath(planted.id), null, 'no picture that is not a picture')
    assert.equal(history.clipPath(planted.id), null, 'no clip that is not a clip')
    assert.equal(history.read(planted.id), null)

    // Aged out, so the sweep drops it — and must drop only what is its own.
    const ancient = { ...planted, id: '1-abcdef', at: 1 }
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(ancient)}\n`)
    await opened(dir)
    assert.ok(existsSync(secret), 'the sweep leaves files outside the history alone')
  })

  test('keeps its files to whoever runs it', async () => {
    // On Home Assistant the history sits in /media, which other add-ons map and the media
    // browser shows. A year of video and of who opened the gate is not for all of them.
    const dir = join(scratch(), 'history')
    const history = await opened(dir, { snapshot: async () => Buffer.from([0xff, 0xd8, 1]) })

    const visit = history.beginVisit({ code: 'Invite' })
    history.sink.send({ type: 'stream-config', sps: '', pps: '' })
    history.sink.sendBinary(frame(1, 'a keyframe'))
    await pause(20)
    history.endVisit('done')
    await pause(20)

    assert.equal(permissions(dir), 0o700, 'the folder')
    assert.equal(permissions(join(dir, 'index.jsonl')), 0o600, 'the index')
    assert.equal(permissions(history.clipPath(visit.id)), 0o600, 'the clip')
    assert.equal(permissions(history.thumbPath(visit.id)), 0o600, 'the picture')
  })

  test('keeps no more than so many entries', async () => {
    // The size ceiling counts clips and pictures. A visit cut short has neither, so a flood of
    // them grew the index — read whole at every start — without ever touching the ceiling.
    const dir = scratch()
    const history = await opened(dir, { maxEntries: 3 })

    for (let i = 0; i < 5; i += 1) {
      history.noteGateOpened({ by: `phone ${i}`, method: 'app' })
    }
    history.configure({})

    const kept = history.list()
    assert.equal(kept.length, 3)
    assert.deepEqual(
      kept.map((entry) => entry.openedBy),
      ['phone 4', 'phone 3', 'phone 2'],
      'the newest are the ones kept'
    )
  })

  test('does not credit a phone with a gate somebody opened at the gate', async () => {
    const dir = scratch()
    const history = await opened(dir)

    // What the agent reports for a card held to the reader: the intercom says a gate opened and
    // nothing about who. The app prints `openedBy` as the row's name, so a guess here read as
    // "a phone · with a card" — a phone that was never involved.
    history.noteGateOpened({ by: null, method: 'card' })
    const [alone] = history.list()
    assert.equal(alone.kind, 'gate')
    assert.equal(alone.method, 'card')
    assert.equal(alone.openedBy, null)

    // The same during a visit, where it read "answered and opened" for a phone that only
    // answered.
    history.beginVisit({})
    history.noteAnswered('Pixel 7')
    history.noteGateOpened({ by: null, method: 'card' })
    history.endVisit('done')

    const [visit] = history.list()
    assert.equal(visit.answeredBy, 'Pixel 7')
    assert.equal(visit.method, 'card')
    assert.equal(visit.openedBy, null)
  })

  test('survives being restarted, and collapses its corrections', async () => {
    const dir = scratch()
    const first = await opened(dir)

    const visit = first.beginVisit({})
    first.noteAnswered('a phone')
    first.endVisit('done')

    const again = await opened(dir)
    const [entry] = again.list()

    assert.equal(entry.id, visit.id)
    assert.equal(entry.answeredBy, 'a phone', 'the last word about a visit wins')
    assert.equal(again.list().length, 1, 'three lines about one visit are still one visit')
  })

  test('closes a visit that the agent died in the middle of', async () => {
    const dir = scratch()
    const history = await opened(dir)

    // What a power cut leaves: an opening line, no ending, and a timestamp long past.
    const old = { id: 'stale', at: Date.now() - 60 * 60 * 1000, kind: 'ring' }
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(old)}\n`)

    const reopened = await opened(dir)
    const [entry] = reopened.list()
    assert.ok(entry.endedAt, 'it is not still going on an hour later')
  })

  test('ignores a half written line rather than losing the rest', async () => {
    const dir = scratch()
    const good = { id: 'whole', at: Date.now(), kind: 'ring' }
    writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(good)}\n{"id":"half wr`)

    const history = await opened(dir)
    assert.equal(history.list().length, 1)
    assert.equal(history.list()[0].id, 'whole')
  })

  test('plays a clip back at the speed it was recorded', async () => {
    const dir = scratch()
    const history = await opened(dir)

    history.beginVisit({})
    history.sink.send({ type: 'stream-config', sps: 'c3Bz', pps: 'cHBz' })
    history.sink.sendBinary(frame(1, 'first'))
    await pause(120)
    history.sink.sendBinary(frame(2, 'second'))
    history.endVisit('done')

    const [entry] = history.list()
    const messages = []
    const frames = []
    const at = []
    const startedAt = Date.now()

    history.play(entry.id, {
      send: (message) => messages.push(message),
      sendBinary: (chunk) => {
        frames.push(chunk)
        at.push(Date.now() - startedAt)
      },
    })

    await pause(300)

    assert.equal(messages[0].type, 'clip-config')
    assert.equal(messages[0].sps, 'c3Bz')
    assert.equal(messages.at(-1).type, 'clip-end')
    assert.equal(frames.length, 2)
    assert.equal(frames[0].subarray(5).toString(), 'first')
    assert.ok(at[1] >= 100, `the second frame waited its turn (${at[1]}ms)`)
  })

  test('stops a playback nobody is watching any more', async () => {
    const dir = scratch()
    const history = await opened(dir)

    history.beginVisit({})
    history.sink.send({ type: 'stream-config', sps: '', pps: '' })
    history.sink.sendBinary(frame(1, 'first'))
    await pause(150)
    history.sink.sendBinary(frame(2, 'second'))
    history.endVisit('done')

    const [entry] = history.list()
    const frames = []
    const stop = history.play(entry.id, { send: quiet, sendBinary: (chunk) => frames.push(chunk) })

    // Long enough for the first frame to go out, short enough that the second is still waiting
    // for its moment — which is the frame that must never arrive.
    await pause(40)
    stop()
    await pause(250)
    assert.equal(frames.length, 1, 'the frame already sent, and nothing after it')
  })

  test('says so plainly when there is no recording of a visit', async () => {
    const dir = scratch()
    const history = await opened(dir)

    const messages = []
    history.play('nothing-like-this', { send: (m) => messages.push(m), sendBinary: quiet })

    assert.equal(messages[0].type, 'clip-error')
  })

  test('drops the oldest when it runs out of room', async () => {
    const dir = scratch()
    // A ceiling small enough to cross with a few frames, standing in for a full disk.
    const history = await opened(dir, { maxBytes: 300 * 1024 })

    const entries = []
    for (let index = 0; index < 4; index++) {
      const visit = history.beginVisit({ at: Date.now() + index })
      history.sink.send({ type: 'stream-config', sps: '', pps: '' })
      history.sink.sendBinary(frame(1, 'x'.repeat(100 * 1024)))
      history.endVisit('done')
      entries.push(visit)
    }

    const kept = history.list()
    assert.ok(kept.length < 4, 'not everything survived')
    assert.ok(
      !kept.some((entry) => entry.id === entries[0].id),
      'and it was the oldest that went'
    )
    assert.equal(history.clipPath(entries[0].id), null, 'its clip went with it')

    // The index is rewritten by the sweep, not appended to for ever.
    const lines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, kept.length)
  })
})
