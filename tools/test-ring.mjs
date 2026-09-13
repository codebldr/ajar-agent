// Rings the doorbell without anybody walking to the gate.
//
//   node tools/test-ring.mjs            on the machine the agent runs on
//   node tools/test-ring.mjs 192.168.1.50 <house-key>    from anywhere on the house network
//
// It asks the agent to report a doorbell press upward. Everything past this machine is then the
// real thing — the Worker, the push, the notification, the sound, the screen — which is the
// point: it answers "will I be told when somebody is at the gate", and it answers it from the
// sofa rather than from the street.
//
// The intercom is not touched. No call is opened, nothing sounds at the gate, and no screen
// inside the house rings.

import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCAL_PORT = 8787

const host = process.argv[2] ?? '127.0.0.1'
const key = process.argv[3] ?? readKey()

function readKey() {
  const path = process.env.AJAR_CONFIG ?? join(homedir(), '.config', 'ajar', 'agent.json')
  try {
    const key = JSON.parse(readFileSync(path, 'utf8')).localKey
    if (key) return key
    console.error(`No localKey in ${path} — has the agent ever run?`)
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`)
    console.error('Run this on the machine the agent runs on, or pass the key as an argument.')
  }
  process.exit(1)
}

const framed = (payload) => {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

const message = (value) =>
  framed(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value), 'utf8')]))

const socket = connect(LOCAL_PORT, host)

socket.on('connect', () => {
  socket.write(message({ key }))
  socket.write(message({ type: 'test-ring' }))

  // A ring that goes through is answered on somebody's phone, not here. One asked for too soon
  // after the last is answered here, with how long to wait — so a moment is left for that, and
  // for the bytes to leave before the socket closes under them.
  setTimeout(() => {
    console.log(`asked the agent at ${host} to report a doorbell press`)
    socket.destroy()
    process.exit(0)
  }, 500)
})

// Everything the agent says back. Camera frames arrive too, because a key holder is a viewer;
// only its JSON messages are read, and only a refusal matters.
let received = Buffer.alloc(0)
socket.on('data', (chunk) => {
  received = Buffer.concat([received, chunk])
  while (received.length >= 4) {
    const length = received.readUInt32BE(0)
    if (received.length < 4 + length) return
    const payload = received.subarray(4, 4 + length)
    received = received.subarray(4 + length)
    if (payload[0] !== 0) continue

    let answer
    try {
      answer = JSON.parse(payload.subarray(1).toString('utf8'))
    } catch {
      continue
    }
    if (answer.type !== 'test-ring-error') continue

    console.error(
      `the agent did not ring: ${answer.error}` +
        (answer.retryInSec ? ` — try again in ${answer.retryInSec}s` : '')
    )
    socket.destroy()
    process.exit(1)
  }
})

socket.on('error', (error) => {
  console.error(`could not reach the agent at ${host}:${LOCAL_PORT} — ${error.message}`)
  process.exit(1)
})
