// What the intercom remembers by itself.
//
// Two tables worth reading. `AccessControlCardRec` is the one that earns its keep: it records
// every opening, and it knows the thing this agent cannot see — a card held to the reader, with
// the name it was given. Those openings happen with no phone involved and no event we could
// attribute, so without this they are simply missing from the history.
//
// `VideoTalkLog` is the intercom's own call log, and it is included for one reason: it goes back
// years, to long before this agent existed. What it cannot do is say whether anybody answered.
// From the intercom's side every press is a call to the indoor monitor, and a call answered on a
// phone was never answered at all — so these are shown as what they are, a press at the gate,
// and the question of who picked up is left to our own history where it is actually known.
//
// The clock needs correcting and the correction is not optional. This intercom sits on GMT+2
// with daylight saving switched off, so for half the year its idea of the time is an hour
// behind the house's. Worse, it writes that wall clock into records as though it were a real
// timestamp. Both are handled by asking the device what time it thinks it is and measuring the
// difference — which also means a household that fixes the setting needs no code change here.

import { Rpc } from './rpc.mjs'

/** Walking a thousand records takes about half a second, and nothing here changes by the minute. */
const REFRESH_MS = 5 * 60_000

/** Enough to fill a history screen many times over without holding the whole table in memory. */
const KEEP = 300

/** How the intercom says a door was opened. Numbers are its own; the words are ours. */
const METHODS = {
  1: 'card',
  2: 'password',
  3: 'fingerprint',
  4: 'remote',
  5: 'button',
}

export class IntercomRecords {
  #config
  #log
  #offsetMs = 0
  #entries = []
  #readAt = 0
  #reading = null

  constructor({ config, log }) {
    this.#config = config
    this.#log = log
  }

  /**
   * The visits and openings the intercom knows about, newest last.
   *
   * Cached, and refreshed in the background rather than in front of somebody waiting: a phone
   * opening the history screen gets what we have now, and the read that follows makes the next
   * one current. The alternative is a screen that pauses for half a second on a device whose
   * whole appeal is that it answers immediately.
   */
  entries() {
    if (Date.now() - this.#readAt > REFRESH_MS) void this.refresh()
    return this.#entries
  }

  async refresh() {
    if (this.#reading) return this.#reading

    this.#reading = this.#read()
      .catch((error) => {
        this.#log(`records: could not read the intercom's own log — ${error.message}`)
      })
      .finally(() => {
        this.#reading = null
        this.#readAt = Date.now()
      })

    return this.#reading
  }

  async #read() {
    const rpc = new Rpc({
      host: this.#config.host,
      port: this.#config.port,
      username: this.#config.username,
      password: this.#config.password,
    })
    await rpc.login()

    await this.#measureClock(rpc)

    const opens = await this.#walk(rpc, 'AccessControlCardRec', (record) => ({
      id: `vto-open-${record.RecNo}`,
      at: this.#realTime(record.CreateTime),
      kind: 'gate',
      method: METHODS[record.Method] ?? 'other',
      openedBy: record.CardName || null,
      // Numbered as this agent numbers gates, which is from one: the relay is pressed with
      // `channel=1` for the first gate, and the record of that same opening comes back with
      // `Door: 0`. Left as the intercom writes it, every opening in the app would name the
      // gate next door.
      door: Number(record.Door) + 1,
      source: 'intercom',
    }))

    const rings = await this.#walk(rpc, 'VideoTalkLog', (record) => ({
      id: `vto-call-${record.RecNo}`,
      at: this.#realTime(record.CreateTime),
      kind: 'ring',
      // Deliberately not `answeredBy`. The intercom's "Missed" means the indoor monitor did not
      // pick up, which says nothing about the phone that did. The seconds, though, are worth
      // carrying: a call with talk time on it was answered by somebody in the house, on the
      // monitor, and that is the one thing about these old rows we do know.
      talkSeconds: record.TalkTime || 0,
      source: 'intercom',
    }))

    this.#entries = [...opens, ...rings]
      .filter((entry) => Number.isFinite(entry.at))
      .sort((a, b) => a.at - b.at)
      .slice(-KEEP)

    this.#log(`records: read ${opens.length} openings and ${rings.length} calls from the intercom`)
  }

  /**
   * How far the intercom's clock is from this machine's.
   *
   * It answers with a wall clock and no offset — "2026-08-21 01:42:07" — and it writes that same
   * wall clock into its records as if it were seconds since 1970. So the difference measured
   * here is exactly what has to come off every record to get a real moment in time.
   */
  async #measureClock(rpc) {
    const answer = await rpc.call('global.getCurrentTime')
    const said = answer.params?.time
    if (!said) return

    // Read as though it were UTC, which is the same lie the records tell.
    const pretend = Date.parse(`${said.replace(' ', 'T')}Z`)
    if (!Number.isFinite(pretend)) return

    this.#offsetMs = pretend - Date.now()

    const hours = this.#offsetMs / 3_600_000
    if (Math.abs(hours) >= 0.5) {
      this.#log(
        `records: the intercom's clock reads ${hours > 0 ? '+' : ''}${hours.toFixed(1)}h against this machine — correcting`
      )
    }
  }

  #realTime(createTime) {
    return Number(createTime) * 1000 - this.#offsetMs
  }

  /**
   * Reads a whole table.
   *
   * The finder on this firmware ignores both the ordering and the time window it is given, and
   * has no `getCount` — every one of those was tried. What it does honour is a cursor: ask for
   * a hundred, get the next hundred. So the table is walked from the start, which for a
   * thousand records is around half a second on the house network.
   */
  async #walk(rpc, name, shape) {
    const created = await rpc.call('RecordFinder.factory.create', { name })
    const object = created.result
    if (!object) return []

    try {
      await rpc.call('RecordFinder.startFind', { condition: {} }, object)

      const kept = []
      for (let page = 0; page < 200; page++) {
        const found = await rpc.call('RecordFinder.doFind', { count: 100 }, object)
        const records = found.params?.records ?? []
        if (records.length === 0) break

        for (const record of records) {
          kept.push(shape(record))
          if (kept.length > KEEP) kept.shift()
        }

        if (records.length < 100) break
      }

      return kept
    } finally {
      await rpc.call('RecordFinder.destroy', null, object).catch(() => {})
    }
  }
}

/**
 * One list out of two, without saying the same thing twice.
 *
 * Every remote opening appears in both: ours, which knows the phone that asked, and the
 * intercom's, which knows only that a door opened. Same event, and the one worth keeping is the
 * one with a name on it. A card opening appears in neither but the intercom's, which is the
 * whole reason for reading its table at all.
 */
export function merge(ours, theirs, { windowMs = 10_000 } = {}) {
  const mine = [...ours]

  const extra = theirs.filter((entry) => {
    if (entry.kind === 'gate' && entry.method !== 'card') {
      const already = mine.some(
        (own) =>
          (own.kind === 'gate' || own.openedAt) &&
          Math.abs((own.openedAt ?? own.at) - entry.at) < windowMs
      )
      if (already) return false
    }

    // Rings we recorded ourselves are richer than the intercom's line about the same press:
    // ours has a picture, a recording, and whether anybody picked up.
    if (entry.kind === 'ring') {
      const already = mine.some(
        (own) => own.kind === 'ring' && Math.abs(own.at - entry.at) < windowMs
      )
      if (already) return false
    }

    return true
  })

  return [...mine, ...extra].sort((a, b) => b.at - a.at)
}
