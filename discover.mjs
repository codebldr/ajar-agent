// Finding the intercom, so nobody has to be asked where it is.
//
// Dahua devices answer a broadcast on UDP 37810 with their own address, model and serial
// number, and they answer it to anybody — no account, no password. That is worth knowing
// twice over: it is how the agent configures itself, and it is a reminder that the serial
// printed on the sticker was never a secret. What protects a house is the agent's pairing
// code, which needs somebody standing at the machine.
//
// The wire format is Dahua's own "DHIP": a thirty-two byte header carrying the body length
// twice, then a JSON request. Replies come back the same way.

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

const DISCOVERY_PORT = 37810
const MAGIC = Buffer.from('DHIP', 'ascii')
const HEADER_BYTES = 32

/**
 * Asks every network the machine is on, and any explicit addresses given.
 *
 * Explicit targets matter in a house with two routers: the intercom often sits on a subnet
 * of its own, where a broadcast from this machine never arrives, but a packet addressed
 * straight at it still does.
 */
export async function discover({ timeoutMs = 2_000, targets = [], sweep = true } = {}) {
  const packet = request({ method: 'DHDiscover.search', params: { mac: '', uni: 1 } })
  const found = new Map()

  const socket = createSocket({ type: 'udp4', reuseAddr: true })

  socket.on('message', (message, from) => {
    const device = parseReply(message, from.address)
    if (!device) return
    // Keyed by serial: a machine with two interfaces onto the same network hears the same
    // intercom twice, and it is one intercom.
    found.set(device.serial || from.address, device)
  })

  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, resolve)
  })

  socket.setBroadcast(true)

  const send = (address) => {
    // A network that refuses broadcast should not stop the ones that allow it.
    try {
      socket.send(packet, DISCOVERY_PORT, address)
    } catch {
      // Ignored on purpose.
    }
  }

  for (const address of [...broadcastAddresses(), ...targets]) send(address)
  await pause(timeoutMs)

  // A broadcast dies at the first router, and in plenty of houses the intercom sits behind
  // one — on its own subnet, off the installer's second router, reachable but not audible.
  // Rather than ask for an address, ask every address: a few thousand small datagrams, once,
  // at setup, and the intercom answers with its own.
  if (found.size === 0 && sweep) {
    for (const subnet of candidateSubnets()) {
      for (let host = 1; host < 255; host += 1) send(`${subnet}.${host}`)
      // Sent in subnet-sized batches so the socket's send queue never grows past a few
      // hundred, which is where datagrams start being dropped before they leave.
      await pause(SWEEP_PACING_MS)
      if (found.size > 0) break
    }
    await pause(timeoutMs)
  }

  socket.close()

  return [...found.values()].sort((a, b) => a.host.localeCompare(b.host))
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** True for the ones worth offering: a door station rather than a camera or a recorder. */
export function isIntercom(device) {
  return device.deviceClass === 'VTO'
}

function request(body) {
  const json = Buffer.from(JSON.stringify(body), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)

  header.writeUInt8(HEADER_BYTES, 0)
  MAGIC.copy(header, 4)
  // The length is written twice: once for this packet, once for the whole message. They are
  // the same here because a discovery request never spans more than one datagram.
  header.writeUInt32LE(json.length, 16)
  header.writeUInt32LE(json.length, 24)

  return Buffer.concat([header, json])
}

function parseReply(message, from) {
  if (message.length <= HEADER_BYTES) return null
  if (!message.subarray(4, 8).equals(MAGIC)) return null

  const info = firstJson(message.subarray(HEADER_BYTES).toString('utf8'))
  const device = info?.params?.deviceInfo
  if (!device) return null

  return {
    serial: device.SerialNo ?? '',
    model: device.DeviceType ?? '',
    deviceClass: device.DeviceClass ?? '',
    // What the device says about itself is preferred over where the packet came from: they
    // differ when a router has rewritten the source address on the way here.
    host: device.IPv4Address?.IPAddress || from,
    httpPort: Number(device.HttpPort ?? 80),
    version: device.Version ?? '',
    mac: device.mac ?? info.mac ?? '',
  }
}

/**
 * Some firmware puts a newline and a second document after the first, so the body is read a
 * line at a time rather than parsed whole.
 */
function firstJson(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // Keep looking.
    }
  }
  return null
}

/**
 * Where to look when nobody answered the broadcast.
 *
 * The networks this machine is on come first — a router that drops broadcast still forwards
 * ordinary packets, so the intercom may be next door and simply not have heard the shout.
 * After that, the addresses consumer routers hand out by default, which is where a second
 * router almost always puts things.
 */
function candidateSubnets() {
  const own = []

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const octets = toOctets(entry.address)
      if (octets) own.push(octets.slice(0, 3).join('.'))
    }
  }

  return [...new Set([...own, ...COMMON_SUBNETS])]
}

/** Defaults shipped by the routers people actually have. */
const COMMON_SUBNETS = [
  '192.168.1',
  '192.168.0',
  '192.168.100',
  '192.168.2',
  '192.168.8',
  '192.168.3',
  '192.168.10',
  '10.0.0',
  '10.0.1',
]

const SWEEP_PACING_MS = 250

/** The broadcast address of every IPv4 network this machine is actually on. */
function broadcastAddresses() {
  const addresses = ['255.255.255.255']

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue

      const ip = toOctets(entry.address)
      const mask = toOctets(entry.netmask)
      if (!ip || !mask) continue

      addresses.push(ip.map((byte, i) => (byte & mask[i]) | (~mask[i] & 0xff)).join('.'))
    }
  }

  return [...new Set(addresses)]
}

function toOctets(address) {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null
}
