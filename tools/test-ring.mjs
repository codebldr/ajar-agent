// Rings the doorbell without anybody walking to the gate.
//
//   node tools/test-ring.mjs            on the machine the agent runs on
//   node tools/test-ring.mjs 192.168.0.111 <house-key>    from anywhere on the house network
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
  console.log(`asked the agent at ${host} to report a doorbell press`)

  // The agent answers nothing to this — the answer arrives on somebody's phone. A moment is
  // left for the bytes to leave before the socket closes under them.
  setTimeout(() => {
    socket.destroy()
    process.exit(0)
  }, 500)
})

socket.on('error', (error) => {
  console.error(`could not reach the agent at ${host}:${LOCAL_PORT} — ${error.message}`)
  process.exit(1)
})
