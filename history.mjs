// What happened at the gate, kept in the house.
//
// The intercom keeps its own logs and we read them (see `records.mjs`), but they cannot answer
// the question that matters most: somebody rang, and then what? From the intercom's side every
// press is a call to the indoor monitor that nobody picked up — including the ones answered on a
// phone, because answering on a phone is not something it has a word for. Only this machine sees
// both halves, so the history worth showing is written here.
//
// A visit is one line in an index and, when there was a camera to record, one clip beside it.
// The clip is the live stream written down exactly as it was sent: same frames, same header, so
// playing it back later needs no decoding here and no second code path in the app.
//
// Nothing here is allowed to fill a disk. Three limits, and the last one is the one that matters
// on somebody else's machine: a size ceiling, an age ceiling, and a floor of free space below
// which recording simply stops. A gate that forgets last spring is a small loss; a Raspberry Pi
// with no room left to write is a house with no doorbell.

import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Long enough to see who came and what they did; short enough that a clip is about a megabyte. */
const RECORD_LIMIT_MS = 30_000

/**
 * What the app is allowed to ask for.
 *
 * Five seconds is the shortest recording anybody would call a recording; two minutes is longer
 * than any doorbell conversation and already four megabytes. The floor on space is what one
 * evening of visitors needs; the ceiling is there so that a slider nobody thought about cannot
 * hand the whole disk over.
 */
const RECORD_MS_RANGE = [5_000, 120_000]
const MAX_BYTES_RANGE = [100 * 1024 * 1024, 10 * 1024 * 1024 * 1024]

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value))

/** Never more than this, however much room the disk has. */
const MAX_BYTES_CEILING = 2 * 1024 * 1024 * 1024

/** Nor more than this share of what was free when the agent started. */
const FREE_SHARE = 0.1

/** Below this much free space, stop recording entirely. */
const MIN_FREE_BYTES = 1024 * 1024 * 1024

/** Nothing older than a year, however much room there is. */
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

/** A visit that was never closed — the agent was killed mid-recording — is not kept open for ever. */
const STALE_VISIT_MS = 5 * 60 * 1000

const FRAME_LENGTH_BYTES = 4

/** Four bytes of length, four of how long after the ring it arrived. */
const RECORD_HEADER_BYTES = 8

/**
 * A kind of our own, written into the clip and never sent live: the parameter sets changing
 * partway through, because somebody switched between the small picture and the large one while
 * the recording was running. Numbered past the kinds the stream itself uses.
 */
const FRAME_CONFIG = 6

/**
 * One line per event, appended, newest last.
 *
 * A single file rather than one per entry: the list is read whole on every request and written
 * one line at a time, which is what an append-only file is for. It is also the only thing that
 * has to survive a power cut — a clip whose index line never landed is an orphan the sweep
 * collects, rather than a hole in the history.
 */
const INDEX_FILE = 'index.jsonl'
const CLIP_DIR = 'clips'
const THUMB_DIR = 'thumbs'

export class History {
  #dir
  #log
  #snapshot
  #maxBytes = MAX_BYTES_CEILING
  #askedForBytes = null
  #entries = []
  #bytes = 0
  #visit = null
  #stream = null
  #limitTimer = null
  #paused = false
  #flushing = new Map()
  #recordMs = RECORD_LIMIT_MS
  #enabled = true
  #quality = 'sd'
  #onSettings = null
  #onVisitEnd = null
  #sink = null
  /** False when the folder could not be created. Nothing is written, and nothing throws. */
  #writable = true

  /**
   * @param dir       where clips and the index live
   * @param log       the agent's logger
   * @param snapshot  async () => Buffer — a still from the gate camera, or null
   * @param maxBytes  a ceiling of somebody's choosing; otherwise one is worked out from the disk
   * @param recordMs  how long a clip may run
   * @param enabled   whether to record video at all
   * @param onSettings called when the settings change, to write them down somewhere lasting
   * @param onVisitEnd called when a visit is over, so the camera can be let go of
   */
  constructor({
    dir,
    log,
    snapshot,
    maxBytes = null,
    recordMs = null,
    enabled = true,
    quality = 'sd',
    onSettings = null,
    onVisitEnd = null,
  }) {
    this.#dir = dir
    this.#log = log
    this.#snapshot = snapshot
    this.#askedForBytes = maxBytes
    this.#recordMs = recordMs ? clamp(recordMs, RECORD_MS_RANGE) : RECORD_LIMIT_MS
    this.#enabled = enabled !== false
    this.#quality = quality === 'hd' ? 'hd' : 'sd'
    this.#onSettings = onSettings
    this.#onVisitEnd = onVisitEnd
  }

  get dir() {
    return this.#dir
  }

  /**
   * Prepares the folder and works out how much of the disk this may use.
   *
   * The ceiling is decided once, at startup, from the free space found then: two gigabytes on a
   * machine with room, a tenth of what is free on one without. Somebody installing this on a
   * Home Assistant box with a nearly full card gets a history that fits rather than a warning
   * they were never going to read.
   */
  async ready() {
    // A history that cannot be written is a disappointment; a doorbell that does not ring is a
    // fault. So this never stops the agent.
    //
    // The folder is somebody else's on every installation but the Pi: a bind mount on a NAS
    // owned by root while the container runs as nobody, a Home Assistant share that was never
    // mapped. Those are permission errors at startup, and before this they came out of
    // `main()` as "the agent stopped" — a house with no gate because it could not keep a video.
    try {
      for (const path of [this.#dir, join(this.#dir, CLIP_DIR), join(this.#dir, THUMB_DIR)]) {
        mkdirSync(path, { recursive: true })
      }

      // Making the folders is not the same as being allowed to write in them, and the second
      // is the one that matters. A folder left behind by an earlier run — or one somebody
      // created by hand — makes `mkdir` succeed on a filesystem that then refuses every write,
      // which showed up as a line of complaint per frame and a switch claiming to record.
      const probe = join(this.#dir, '.writable')
      writeFileSync(probe, '')
      rmSync(probe, { force: true })
    } catch (error) {
      this.#enabled = false
      this.#writable = false
      this.#log(
        `history: cannot write to ${this.#dir} — ${error.message}.` +
          ' The gate works; visits are not being kept.'
      )
      return this
    }

    this.#warnIfInsideTheContainer()

    const free = await this.#freeBytes()
    if (this.#askedForBytes) {
      this.#maxBytes = this.#askedForBytes
    } else if (free !== null) {
      this.#maxBytes = Math.max(64 * 1024 * 1024, Math.min(MAX_BYTES_CEILING, free * FREE_SHARE))
    }

    this.#load()
    this.#sweep()

    const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`
    this.#log(
      `history: ${this.#entries.length} entries, ${mb(this.#bytes)} used of ${mb(this.#maxBytes)} at ${this.#dir}`
    )
    return this
  }

  // ── What the owner decided ─────────────────────────────────────────────

  /**
   * The settings, and enough of the truth to show them honestly.
   *
   * The numbers a phone needs are not only the ones somebody chose: how much is actually in
   * use, and how much room the disk has left, are what turn "2 GB" from a number into a
   * decision. A house whose card is nearly full should see that on the same screen.
   */
  /** Which stream a recording is made from. The viewers' choice is their own. */
  get quality() {
    return this.#quality
  }

  settings() {
    return {
      enabled: this.#enabled,
      /** False when the folder could not be created — the app says so rather than a switch lying. */
      writable: this.#writable,
      quality: this.#quality,
      recordSeconds: Math.round(this.#recordMs / 1000),
      maxBytes: Math.round(this.#maxBytes),
      usedBytes: this.#bytes,
      entries: this.#entries.length,
      paused: this.#paused,
      limits: {
        recordSeconds: RECORD_MS_RANGE.map((ms) => ms / 1000),
        maxBytes: MAX_BYTES_RANGE,
      },
    }
  }

  /**
   * Changes them, within what this machine can be asked for.
   *
   * Clamped rather than refused: a phone from a newer version of the app asking for something
   * this agent will not do should get the nearest thing it will, not an error. Lowering the
   * space allowance takes effect at once — that is usually why somebody lowers it.
   */
  configure({ enabled, recordSeconds, maxBytes, quality } = {}) {
    // Turning recording on when there is nowhere to put it would be a switch that moves and
    // changes nothing.
    if (typeof enabled === 'boolean') this.#enabled = enabled && this.#writable
    if (quality === 'sd' || quality === 'hd') this.#quality = quality
    if (Number.isFinite(recordSeconds)) {
      this.#recordMs = clamp(Math.round(recordSeconds * 1000), RECORD_MS_RANGE)
    }
    if (Number.isFinite(maxBytes)) {
      this.#askedForBytes = clamp(Math.round(maxBytes), MAX_BYTES_RANGE)
      this.#maxBytes = this.#askedForBytes
    }

    if (!this.#enabled) this.#closeVisit('recording was turned off')

    const chosen = this.settings()
    this.#log(
      `history: ${
        chosen.enabled
          ? `recording ${chosen.recordSeconds}s of ${chosen.quality} per visit`
          : 'not recording'
      }, up to ${Math.round(chosen.maxBytes / (1024 * 1024))} MB`
    )

    this.#sweep()
    this.#onSettings?.({
      enabled: this.#enabled,
      recordSeconds: chosen.recordSeconds,
      maxBytes: this.#maxBytes,
      quality: this.#quality,
    })

    return chosen
  }

  // ── Writing ────────────────────────────────────────────────────────────

  /**
   * Somebody is at the gate.
   *
   * The picture is taken immediately and separately from the recording: the intercom hands over
   * a JPEG in a fifth of a second without anybody decoding anything, which is worth having even
   * on the visits where the video never starts.
   */
  beginVisit({ at = Date.now(), code = null } = {}) {
    // Nowhere to write. The doorbell still rings, the camera still works; there is simply no
    // record of it, which is what the log said at startup.
    if (!this.#writable) return { id: '', at, kind: 'ring', code, clip: null }

    this.#closeVisit('superseded')

    const id = `${at}-${randomBytes(3).toString('hex')}`
    const entry = { id, at, kind: 'ring', code, answeredBy: null, openedBy: null }

    this.#visit = entry
    this.#append(entry)

    void this.#takeSnapshot(entry)
    this.#startRecording(entry)

    return entry
  }

  /** Somebody picked up. The recording carries on — the visit is not over when it is answered. */
  noteAnswered(by) {
    if (!this.#visit) return
    this.#visit.answeredBy = by ?? 'a phone'
    this.#rewrite(this.#visit)
  }

  /**
   * The gate was opened.
   *
   * Attached to the visit in progress when there is one, so the history reads as one line —
   * somebody rang, somebody let them in — and stands on its own when there is not, which is
   * what coming home looks like.
   */
  noteGateOpened({ by = null, method = 'remote', name = null, door = null } = {}) {
    // Nowhere to write. Said once at startup; not once per gate opening for the life of the
    // house, which is what happened while only `beginVisit` knew to stay quiet.
    if (!this.#writable) return null

    if (this.#visit) {
      this.#visit.openedBy = by ?? name ?? 'a phone'
      this.#visit.openedAt = Date.now()
      this.#visit.method = method
      if (door) this.#visit.door = door
      this.#rewrite(this.#visit)
      return this.#visit
    }

    const entry = {
      id: `${Date.now()}-${randomBytes(3).toString('hex')}`,
      at: Date.now(),
      kind: 'gate',
      method,
      door,
      openedBy: by ?? name ?? 'a phone',
    }
    this.#append(entry)
    return entry
  }

  /** The call ended, one way or another. */
  endVisit(reason = 'ended') {
    this.#closeVisit(reason)
  }

  // ── The recorder ───────────────────────────────────────────────────────

  /**
   * Looks exactly like a viewer to the rest of the agent.
   *
   * That is the whole trick: joining the audience is what opens the camera, so a doorbell
   * press with nobody watching still gets a picture, and a press somebody answers records the
   * same single stream everyone else is already receiving rather than asking the intercom for
   * a second one.
   */
  get sink() {
    // One object, made once and handed out for ever after.
    //
    // This used to build a fresh one on every read, which looks harmless and is not: the
    // audience is a set, so joining and leaving are decided by identity. Leaving with a
    // different object than the one that joined removes nothing — the old sink stays in the
    // audience, the next visit adds another, and every frame is then written down twice by two
    // recorders sharing one file. It shows up as a clip with fifty pictures a second in it and
    // sixty seconds of sound over a thirty second visit: the picture decodes as rubble and the
    // sound plays like an echo of itself.
    this.#sink ??= {
      send: (message) => this.#onMessage(message),
      sendBinary: (chunk) => this.#onFrame(chunk),
    }
    return this.#sink
  }

  get recording() {
    return this.#stream !== null
  }

  #startRecording(entry) {
    // Turned off by the owner: the visit is still remembered, with its picture and who
    // answered. It is the video that is optional, not the history.
    if (!this.#enabled) return

    if (this.#paused) {
      this.#log('history: not recording — the disk is nearly full')
      return
    }

    const path = join(this.#dir, CLIP_DIR, `${entry.id}.ajr`)
    this.#stream = createWriteStream(path)
    this.#stream.on('error', (error) => {
      this.#log(`history: cannot write the clip — ${error.message}`)
      this.#stream = null
    })

    entry.clip = `${entry.id}.ajr`
    entry.bytes = 0

    // A visitor who leaves without anybody answering would otherwise be recorded until the
    // intercom gives up, and a call somebody forgets to end would be recorded for as long as
    // it lasts. Both are cut here.
    this.#limitTimer = setTimeout(() => this.#closeVisit('reached the limit'), this.#recordMs)
  }

  #onMessage(message) {
    if (!this.#visit || message?.type !== 'stream-config') return

    const codec = {
      sps: message.sps ?? '',
      pps: message.pps ?? '',
      displayAspect: message.displayAspect ?? 0,
      audio: message.audio ?? null,
    }

    // A second one, mid visit: somebody watching switched between the small picture and the
    // large one, which on this intercom means a new stream at a different size. Everything
    // recorded after that point describes a picture of different dimensions, and a decoder set
    // up for the first size renders the second as coloured rubble in the corner of the frame.
    //
    // So the change is written into the clip itself, where playback meets it at the moment it
    // happened and rebuilds the decoder — rather than only at the top of the file, which can
    // describe the start of a recording or the end of it but not both.
    if (this.#visit.codec && this.#stream) {
      this.#writeRecord(FRAME_CONFIG, Buffer.from(JSON.stringify(codec), 'utf8'))
      return
    }

    // The first, kept with the entry: a clip is a stream of frames, and these are what a
    // decoder needs before the first of them means anything.
    this.#visit.codec = codec
    this.#rewrite(this.#visit)
  }

  #onFrame(chunk) {
    if (!this.#stream || !this.#visit) return
    this.#write(chunk)
  }

  /** A frame of our own making — a parameter set, rather than a picture. */
  #writeRecord(kind, payload) {
    const header = Buffer.alloc(5)
    header[0] = kind
    header.writeUInt32BE(0, 1)
    this.#write(Buffer.concat([header, payload]))
  }

  #write(chunk) {
    const stream = this.#stream
    if (!stream || !this.#visit) return

    // The frames arrive with a kind and a timestamp but no length, because on a socket the
    // message boundary is the length. In a file there are no boundaries, so one is written —
    // and beside it, how long after the doorbell this frame turned up. The frame's own
    // timestamp comes from the intercom's clock in the intercom's units; this one is in
    // milliseconds since the ring, which is all playback needs to run at the right speed.
    const header = Buffer.alloc(RECORD_HEADER_BYTES)
    header.writeUInt32BE(chunk.length, 0)
    // Clamped at both ends. The ceiling is the width of the field; the floor is for a clock
    // that went backwards mid visit, which is what an NTP correction looks like from in here.
    const since = Math.min(0xffffffff, Math.max(0, Date.now() - this.#visit.at))
    header.writeUInt32BE(since, FRAME_LENGTH_BYTES)
    stream.write(header)
    stream.write(chunk)

    this.#visit.bytes += chunk.length + RECORD_HEADER_BYTES
  }

  #closeVisit(reason) {
    if (this.#limitTimer) {
      clearTimeout(this.#limitTimer)
      this.#limitTimer = null
    }

    const entry = this.#visit
    const stream = this.#stream
    this.#visit = null
    this.#stream = null

    if (!entry) return

    entry.endedAt = Date.now()
    entry.durationMs = entry.endedAt - entry.at

    if (stream) {
      // Closing a file is not the same as the bytes being in it. Somebody who watched a visit
      // live and reaches for the recording a second later would otherwise be handed a clip
      // that stops halfway, so anyone asking waits for this instead.
      this.#flushing.set(
        entry.id,
        new Promise((resolve) => {
          stream.end(() => {
            this.#flushing.delete(entry.id)
            resolve()
          })
        })
      )
      this.#bytes += entry.bytes ?? 0
      const seconds = Math.round(entry.durationMs / 1000)
      this.#log(
        `history: kept ${seconds}s of the visit (${Math.round((entry.bytes ?? 0) / 1024)} KB) — ${reason}`
      )
    }

    this.#rewrite(entry)
    this.#sweep()

    // Said out loud rather than left to the caller to notice: whoever opened the camera for
    // this visit has to be told to let it go, and the visit can end here — at its own time
    // limit — as easily as it can end on an event from the intercom.
    this.#onVisitEnd?.(entry)
  }

  async #takeSnapshot(entry) {
    if (!this.#snapshot || this.#paused) return
    try {
      const image = await this.#snapshot()
      if (!image?.length) return
      writeFileSync(join(this.#dir, THUMB_DIR, `${entry.id}.jpg`), image)
      entry.thumb = `${entry.id}.jpg`
      entry.bytes = (entry.bytes ?? 0) + image.length
      this.#rewrite(entry)
    } catch (error) {
      this.#log(`history: no picture for this visit — ${error.message}`)
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────

  /** Newest first, which is the only order anybody wants to read a doorbell in. */
  list({ limit = 50, before = null } = {}) {
    const entries = this.#entries
      .filter((entry) => (before ? entry.at < before : true))
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()

    return entries.map((entry) => ({ ...entry }))
  }

  entry(id) {
    return this.#entries.find((candidate) => candidate.id === id) ?? null
  }

  clipPath(id) {
    const entry = this.entry(id)
    if (!entry?.clip) return null
    const path = join(this.#dir, CLIP_DIR, entry.clip)
    return existsSync(path) ? path : null
  }

  thumbPath(id) {
    const entry = this.entry(id)
    if (!entry?.thumb) return null
    const path = join(this.#dir, THUMB_DIR, entry.thumb)
    return existsSync(path) ? path : null
  }

  /**
   * A slice of a recording, for a phone that would rather have the file than a performance.
   *
   * Playing it down the socket (below) is the neat way and only works while the phone is on the
   * house network; through the relay a clip has to be carried as messages, and a message has a
   * size limit. So the phone asks for it in pieces and puts them together — which also gives it
   * something `play` never can: the whole clip in hand, replayable, without asking the house
   * again.
   */
  read(id, offset = 0, length = 512 * 1024) {
    const entry = this.entry(id)
    const path = this.clipPath(id)
    if (!entry || !path) return null

    const size = statSync(path).size
    const from = Math.max(0, Math.min(Number(offset) || 0, size))
    const to = Math.min(size, from + Math.max(1, Math.min(Number(length) || 0, 1024 * 1024)))

    const handle = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      const read = readSync(handle, buffer, 0, buffer.length, from)
      return { bytes: buffer.subarray(0, read), offset: from, size, codec: entry.codec ?? null }
    } finally {
      closeSync(handle)
    }
  }

  /**
   * Plays a clip back down a viewer's own connection, at the speed it happened.
   *
   * The frames go out exactly as they were recorded, so what arrives at the phone is
   * indistinguishable from the live stream — same header, same kinds, same decoder, no second
   * path through the app to get wrong. What tells the two apart is the message before them,
   * which carries the parameter sets belonging to this clip rather than to the camera now.
   *
   * Paced rather than poured. Sending a thirty second clip as fast as the network allows would
   * arrive in under a second and be decoded into a blur; the recorded offsets are what make it
   * a video again. Returns a function that stops it, for the viewer who navigates away.
   */
  play(id, sink) {
    const entry = this.entry(id)
    const path = this.clipPath(id)
    if (!entry || !path) {
      sink.send({ type: 'clip-error', id, error: 'there is no recording of that visit' })
      return () => {}
    }

    let cancelled = false
    let timer = null

    sink.send({
      type: 'clip-config',
      id,
      codec: 'h264',
      sps: entry.codec?.sps ?? '',
      pps: entry.codec?.pps ?? '',
      displayAspect: entry.codec?.displayAspect ?? 0,
      audio: entry.codec?.audio ?? null,
      durationMs: entry.durationMs ?? 0,
    })

    let body = null
    let startedAt = 0
    let offset = 0

    const pump = () => {
      while (!cancelled && offset + RECORD_HEADER_BYTES <= body.length) {
        const length = body.readUInt32BE(offset)
        const at = body.readUInt32BE(offset + FRAME_LENGTH_BYTES)
        const from = offset + RECORD_HEADER_BYTES
        const to = from + length

        // A file cut short by a power cut ends mid frame. Stopping is the whole handling.
        if (to > body.length) break

        const due = startedAt + at - Date.now()
        if (due > 5) {
          timer = setTimeout(pump, due)
          return
        }

        sink.sendBinary(body.subarray(from, to))
        offset = to
      }

      if (!cancelled) sink.send({ type: 'clip-end', id })
    }

    // The wait is nothing at all in the usual case — the recording finished hours ago — and is
    // exactly as long as it takes to flush in the one case that matters.
    void Promise.resolve(this.#flushing.get(id)).then(() => {
      if (cancelled) return
      body = readFileSync(path)
      startedAt = Date.now()
      pump()
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }

  // ── The index on disk ──────────────────────────────────────────────────

  #indexPath() {
    return join(this.#dir, INDEX_FILE)
  }

  #load() {
    this.#entries = []
    this.#bytes = 0

    const path = this.#indexPath()
    if (!existsSync(path)) return

    const seen = new Map()
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        // Later lines are corrections of earlier ones — an answer, an opening, a clip that
        // finished. The last word about an id wins.
        if (entry?.id) seen.set(entry.id, entry)
      } catch {
        // A half written line is what a power cut leaves behind. Skip it and keep the rest.
      }
    }

    this.#entries = [...seen.values()].sort((a, b) => a.at - b.at)

    // A visit whose last word was written before the agent died is closed here rather than
    // left looking like it is still going on.
    const now = Date.now()
    for (const entry of this.#entries) {
      if (entry.endedAt || now - entry.at < STALE_VISIT_MS) continue
      entry.endedAt = entry.at
      entry.durationMs = 0
    }

    this.#bytes = this.#entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
  }

  #append(entry) {
    this.#entries.push(entry)
    try {
      writeFileSync(this.#indexPath(), `${JSON.stringify(entry)}\n`, { flag: 'a' })
    } catch (error) {
      this.#log(`history: cannot write the index — ${error.message}`)
    }
  }

  /** Corrections are appended too; `#load` collapses them. The file is rewritten only by a sweep. */
  #rewrite(entry) {
    try {
      writeFileSync(this.#indexPath(), `${JSON.stringify(entry)}\n`, { flag: 'a' })
    } catch (error) {
      this.#log(`history: cannot write the index — ${error.message}`)
    }
  }

  // ── Keeping it small ───────────────────────────────────────────────────

  /**
   * Says so when recordings are somewhere that will not survive.
   *
   * Two ways to lose them in a container, and neither announces itself. Writing into the
   * container's own filesystem is the obvious one. The other is quieter and likelier: Docker
   * makes an anonymous volume when nobody says where `/config` should live, and the update
   * instructions in every guide — remove the container, run it again — leave that volume
   * orphaned and start a fresh one. The history is not deleted so much as abandoned, along
   * with however many gigabytes it had grown to.
   *
   * A named volume or a folder from the host both read as a path somebody chose. An anonymous
   * one is sixty-four hex characters, which is what this looks for.
   */
  #warnIfInsideTheContainer() {
    if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) return

    const advice = ' Give it a folder that outlives the container — see the installation guide.'

    try {
      if (statSync(this.#dir).dev === statSync('/').dev) {
        this.#log(`history: ${this.#dir} is inside the container.${advice}`)
        return
      }
    } catch {
      return
    }

    try {
      const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      const anonymous = mounts.some((line) => {
        const [source, target] = [line.split(' ')[3], line.split(' ')[4]]
        if (!target || !this.#dir.startsWith(target)) return false
        return /\/volumes\/[0-9a-f]{64}\/_data$/.test(source ?? '')
      })

      if (anonymous) {
        this.#log(`history: ${this.#dir} is on a volume Docker named itself.${advice}`)
      }
    } catch {
      // No mountinfo, or an unreadable one. The check is a courtesy, not a requirement.
    }
  }

  async #freeBytes() {
    try {
      const stats = await statfs(this.#dir)
      return Number(stats.bsize) * Number(stats.bavail)
    } catch {
      // Not every platform answers this. Without it the size ceiling still applies; only the
      // free space floor is lost, which is a check, not a promise.
      return null
    }
  }

  /**
   * Drops the oldest until what is left fits, then rewrites the index in one piece.
   *
   * Oldest first, because a doorbell is worth most in the hour after it rang and least a year
   * later. The index is rewritten rather than appended to here — this is the only moment the
   * file shrinks, and it is also where the accumulated corrections are collapsed back into one
   * line per entry.
   */
  #sweep() {
    const cutoff = Date.now() - MAX_AGE_MS
    let removed = 0

    while (this.#entries.length > 0) {
      const oldest = this.#entries[0]
      const tooOld = oldest.at < cutoff
      const tooBig = this.#bytes > this.#maxBytes
      if (!tooOld && !tooBig) break

      this.#entries.shift()
      this.#bytes = Math.max(0, this.#bytes - (oldest.bytes ?? 0))
      this.#delete(oldest)
      removed += 1
    }

    if (removed > 0) this.#log(`history: dropped ${removed} of the oldest to stay within the limit`)
    if (removed > 0 || this.#dirty()) this.#compact()

    void this.#checkSpace()
  }

  #delete(entry) {
    for (const path of [
      entry.clip ? join(this.#dir, CLIP_DIR, entry.clip) : null,
      entry.thumb ? join(this.#dir, THUMB_DIR, entry.thumb) : null,
    ]) {
      if (path) rmSync(path, { force: true })
    }
  }

  #dirty() {
    try {
      const size = statSync(this.#indexPath()).size
      // Corrections make the file grow past what the entries themselves need. Twice the
      // entries is a generous line to draw, and drawing it avoids rewriting on every ring.
      return size > Math.max(64 * 1024, this.#entries.length * 512 * 2)
    } catch {
      return false
    }
  }

  /** Written beside the real file and moved over it, so a crash cannot leave half an index. */
  #compact() {
    const temporary = `${this.#indexPath()}.new`
    try {
      writeFileSync(temporary, this.#entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
      renameSync(temporary, this.#indexPath())
    } catch (error) {
      this.#log(`history: cannot tidy the index — ${error.message}`)
      rmSync(temporary, { force: true })
    }
  }

  /**
   * The floor. Below it nothing new is written, whatever the size ceiling says.
   *
   * This is the one limit that protects something other than the history: the agent shares its
   * disk with whatever else the machine does, and on a Home Assistant box that is the entire
   * house. Recording resumes by itself once there is room again.
   */
  async #checkSpace() {
    const free = await this.#freeBytes()
    if (free === null) return

    const short = free < MIN_FREE_BYTES
    if (short === this.#paused) return

    this.#paused = short
    this.#log(
      short
        ? `history: only ${Math.round(free / (1024 * 1024))} MB free — recording paused`
        : 'history: there is room again — recording resumed'
    )
  }
}
