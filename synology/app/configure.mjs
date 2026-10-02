// Moves what the install wizard asked for into the agent's settings.
//
// postinst cannot write the settings itself: they live in the `ajar` shared folder, and whether
// that folder exists yet when postinst runs is up to DSM. So postinst leaves the answers in the
// package's own folder, one raw value per file — no JSON written by a shell, which would break on
// the first password with a quote in it — and this picks them up the next time the agent starts.
//
// Only what was answered is changed. An upgrade has no wizard, and must not wipe a password that
// was set at install.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PENDING = '/var/packages/ajar/var'
const CONFIG = process.env.AJAR_CONFIG

const answers = {
  password: join(PENDING, 'wizard_password'),
  host: join(PENDING, 'wizard_host'),
}

const patch = {}
for (const [field, path] of Object.entries(answers)) {
  if (!existsSync(path)) continue
  const value = readFileSync(path, 'utf8')
  if (value !== '') patch[field] = value
}

if (Object.keys(patch).length > 0 && CONFIG) {
  let current = {}
  try {
    current = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch {
    // No settings yet: a first install.
  }

  // A new address, or a new password for the same intercom, means the agent should look again
  // rather than keep talking to what it found last time.
  if (patch.host) delete current.port

  writeFileSync(CONFIG, JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 })
  chmodSync(CONFIG, 0o600)
}

for (const path of Object.values(answers)) rmSync(path, { force: true })
