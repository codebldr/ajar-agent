// Merging two accounts of the same afternoon.
//
// The intercom and this agent both saw the gate open, and only one of them knows who opened it.
// Getting this wrong shows the household every remote opening twice — once with a name, once
// without — which is the kind of fault nobody reports and everybody notices.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { merge } from '../records.mjs'

const at = (minutes) => new Date(2026, 7, 20, 18, minutes).getTime()

describe('merging our history with the intercom’s', () => {
  test('keeps the account with a name when both saw the same opening', () => {
    const ours = [{ id: 'ours', at: at(10), kind: 'gate', method: 'app', openedBy: 'Pixel 7' }]
    const theirs = [{ id: 'vto-open-1', at: at(10) + 900, kind: 'gate', method: 'remote' }]

    const merged = merge(ours, theirs)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].openedBy, 'Pixel 7')
  })

  test('keeps a card opening, which only the intercom saw', () => {
    const theirs = [
      { id: 'vto-open-2', at: at(20), kind: 'gate', method: 'card', openedBy: 'chivuta2' },
    ]

    const merged = merge([], theirs)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].method, 'card')
    assert.equal(merged[0].openedBy, 'chivuta2')
  })

  test('does not swallow an opening that happened later', () => {
    const ours = [{ id: 'ours', at: at(10), kind: 'gate', method: 'app', openedBy: 'Pixel 7' }]
    const theirs = [{ id: 'vto-open-3', at: at(25), kind: 'gate', method: 'remote' }]

    assert.equal(merge(ours, theirs).length, 2)
  })

  test('prefers our own record of a visit over the intercom’s line about it', () => {
    const ours = [
      { id: 'ours', at: at(30), kind: 'ring', answeredBy: 'Pixel 7', clip: 'x.ajr' },
    ]
    const theirs = [{ id: 'vto-call-9', at: at(30) + 2_000, kind: 'ring', talkSeconds: 0 }]

    const merged = merge(ours, theirs)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].answeredBy, 'Pixel 7', 'the one that knows who picked up')
  })

  test('keeps the intercom’s older visits, from before this agent existed', () => {
    const theirs = [{ id: 'vto-call-1', at: at(5), kind: 'ring', talkSeconds: 12 }]
    const merged = merge([], theirs)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].source, undefined)
  })

  test('returns newest first', () => {
    const ours = [{ id: 'a', at: at(10), kind: 'ring' }]
    const theirs = [
      { id: 'vto-open-4', at: at(40), kind: 'gate', method: 'card' },
      { id: 'vto-open-5', at: at(20), kind: 'gate', method: 'card' },
    ]

    const merged = merge(ours, theirs)
    assert.deepEqual(
      merged.map((entry) => entry.id),
      ['vto-open-4', 'vto-open-5', 'a']
    )
  })
})
