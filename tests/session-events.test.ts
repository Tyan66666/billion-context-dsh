/**
 * session-events 双版本分支单测。
 *
 * DSH rc.6/0.1.1 暴露 `Session.events` getter；0.1.2-alpha 移除它，改用
 * `snapshotEvents()` / `eventAt(seq)`。封装层按特性探测提供单一入口，
 * 这两个分支必须都能跑——本测试在任意 DSH 基线（含不装 alpha 包的 CI）
 * 下都用 mock 覆盖两条路径，防止未来收紧任一分支时静默破坏另一侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { eventAtOf, sessionEventsOf } from '../src/session-events.ts'

function mkEvent(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: 1, data: { turn: 1 } } as SessionEvent
}

test('rc.6 shape: falls back to the public events getter', () => {
  const events = [mkEvent(0), mkEvent(1)]
  const session = { events } as unknown as Session
  assert.deepEqual(sessionEventsOf(session), events)
  assert.equal(eventAtOf(session, 1), events[1])
  assert.equal(eventAtOf(session, 9), undefined)
})

test('0.1.2-alpha shape: uses snapshotEvents / eventAt', () => {
  const events = [mkEvent(0), mkEvent(1)]
  let snapshotCalls = 0
  const session = {
    snapshotEvents() {
      snapshotCalls += 1
      return events
    },
    eventAt(seq: number) {
      return events[seq]
    },
  } as unknown as Session
  assert.deepEqual(sessionEventsOf(session), events)
  assert.equal(snapshotCalls, 1)
  assert.equal(eventAtOf(session, 0), events[0])
  assert.equal(eventAtOf(session, 5), undefined)
})

test('snapshot shape wins when BOTH exist (forward compatibility)', () => {
  const events = [mkEvent(0)]
  const session = {
    events: [mkEvent(99)],
    snapshotEvents() {
      return events
    },
    eventAt(seq: number) {
      return events[seq]
    },
  } as unknown as Session
  assert.deepEqual(sessionEventsOf(session), events)
  assert.equal(eventAtOf(session, 0), events[0])
})