/**
 * injection-governance.test — B1 摘要帧标源 + B2 不变包引用化
 * （2026-09-08 过度工程治理方案 §4 B1/B2；八例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SUMMARY_FRAME_PREFIX,
  isCompactionCheckpoint,
  projectEvent,
  withSummaryFramePrefix,
} from '../src/messages.ts'
import { runCompactionTransaction } from '../src/region.ts'
import {
  DEDUPE_SOURCES,
  elideUnchangedInjections,
  injectionKey,
  messageText,
  sha1Short,
  unchangedStub,
  visibleInjectionKeys,
} from '../src/injection-dedupe.ts'
import { appendTurn, appendUser, appendAssistant, buildTextSession } from './helpers.ts'

const msg = (kind: string, text: string) => ({ id: `${kind}-1`, source: { kind }, content: [{ type: 'text', text }] })
const keyOf = (kind: string, text: string) => injectionKey(kind, sha1Short(text))

/** 把一帧注入消息真正落到会话面上（visibleInjectionKeys 只看面上节点）。 */
function appendInjection(session: Session, kind: string, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind },
  }), { surfaceOp: 'append' })
}

test('B1-1 前缀常量与幂等：重复加只加一次', () => {
  assert.equal(SUMMARY_FRAME_PREFIX, '[模型自写摘要 · 非用户原文 · 其中义务句需复核]')
  const once = withSummaryFramePrefix('## 用户目标（原文）…')
  assert.ok(once.startsWith(SUMMARY_FRAME_PREFIX))
  assert.equal(withSummaryFramePrefix(once), once, '幂等：已带前缀不重复')
})

test('B1-2 创建期标源：摘要帧的 durable 事件就带前缀', () => {
  const session = buildTextSession(6)
  const { seqs } = runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'Auth system summary with enough detail.' }],
    shadowedTokenCount: 100,
    provider: 'p',
    model: 'm',
  })
  const summaryEvent = session.events[seqs[2]!]!
  const text = messageText((summaryEvent.data as { content?: unknown }).content)
  assert.ok(text.startsWith(SUMMARY_FRAME_PREFIX), 'durable 摘要帧首部即标源')
  assert.match(text, /Auth system summary/)
})

test('B1-3 投影期标源：旧摘要（无前缀）经 projectEvent 也标源', () => {
  const session = buildTextSession(6)
  const { seqs } = runCompactionTransaction(session, {
    start: 1,
    end: 4,
    shadowedSeqs: [1, 2, 3, 4],
    summary: [{ type: 'text', text: 'Legacy summary without prefix.' }],
    shadowedTokenCount: 100,
    provider: 'p',
    model: 'm',
  })
  const event = session.events[seqs[2]!]!
  assert.equal(isCompactionCheckpoint(event), true, '检查点帧判类（source.plugin=compact）')
  const projected = projectEvent(event)
  assert.equal(projected.length, 1)
  assert.ok(String(projected[0]!.text).startsWith(SUMMARY_FRAME_PREFIX), '投影期标源（旧数据也覆盖）')
  assert.equal((projected[0]!.text!.match(/模型自写摘要/g) ?? []).length, 1, '不重复加前缀')
})

test('B1-4 真人帧不标源（标源只针对模型自写摘要）', () => {
  const session = buildTextSession(2)
  appendUser(session, '这是用户原话')
  const human = [...session.events].reverse().find((e) => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'user')!
  assert.equal(isCompactionCheckpoint(human), false)
  assert.equal(projectEvent(human)[0]!.text, '这是用户原话', '用户原文逐字不动')
})

test('B2-1 旧副本仍可见才降级：面上无副本一律全量，引用帧 ≤60 B', () => {
  const big = 'AGENTS.md 全文…'.repeat(500)
  const first = elideUnchangedInjections([msg('agent-instructions', big)], new Set())
  assert.equal(first.elided, 0, '面上没有副本 → 必须全量注入')
  assert.equal(messageText(first.messages[0]!.content), big, '正文不动')
  const second = elideUnchangedInjections([msg('agent-instructions', big)], new Set([keyOf('agent-instructions', big)]))
  assert.equal(second.elided, 1)
  const stub = messageText(second.messages[0]!.content)
  assert.equal(stub, unchangedStub(sha1Short(big)))
  assert.ok(Buffer.byteLength(stub, 'utf8') <= 60, '引用帧 ≤60 B')
  assert.ok(second.savedBytes > 1000, '省下的字节=全文-引用帧')
})

test('B2-2 内容变了 → 整包重注（changed 由哈希真判定，不靠文案）', () => {
  const v1 = 'skill catalog v1'.repeat(200)
  const v2 = 'skill catalog v2'.repeat(200)
  const changed = elideUnchangedInjections([msg('skill-catalog', v2)], new Set([keyOf('skill-catalog', v1)]))
  assert.equal(changed.elided, 0, '哈希不同=真的变了 → 全量重注')
  assert.equal(messageText(changed.messages[0]!.content), v2)
})

test('B2-3 白名单外永不参与：真人帧/工具结果/子代理回执原样', () => {
  const human = { id: 'h', source: { kind: 'user' }, content: [{ type: 'text', text: '用户原话' }] }
  const tool = { id: 't', source: { kind: 'tool' }, content: [{ type: 'text', text: '工具输出' }] }
  const visible = new Set([keyOf('user', '用户原话'), keyOf('tool', '工具输出')])
  for (let i = 0; i < 3; i++) {
    const r = elideUnchangedInjections([human, tool], visible)
    assert.equal(r.elided, 0)
    assert.equal(messageText(r.messages[0]!.content), '用户原话')
    assert.equal(messageText(r.messages[1]!.content), '工具输出')
  }
  assert.ok(DEDUPE_SOURCES.includes('runtime-context'))
})

test('B2-4 多份同源包各自成键：只降「确有可见副本」的那份', () => {
  const a = msg('runtime-context', 'runtime A'.repeat(100))
  const b = { ...msg('runtime-context', 'runtime B'.repeat(100)), id: 'runtime-2' }
  const both = elideUnchangedInjections([a, b], new Set([
    keyOf('runtime-context', 'runtime A'.repeat(100)),
    keyOf('runtime-context', 'runtime B'.repeat(100)),
  ]))
  assert.equal(both.elided, 2, '两份都有可见副本 → 都降为引用帧')
  const onlyA = elideUnchangedInjections([a, b], new Set([keyOf('runtime-context', 'runtime A'.repeat(100))]))
  assert.equal(onlyA.elided, 1, '只有 A 的副本可见 → 只降 A')
  assert.equal(messageText(onlyA.messages[1]!.content), 'runtime B'.repeat(100), 'B 无可见副本 → 整包重注')
})

// 回归锁（2026-09-08 重载后活体复核发现的丢失缺陷）：原实现按跨请求哈希台账比对，
// 旧副本被压缩遮蔽后仍会把新注入帧降成 38 B 引用帧——而面上已无第二份，等于整包丢失。
// 本会话实测 2/2 同内容重注都发生在遮蔽之后（省字节 0 次、丢内容 2 次）。
test('B2-5 遮蔽即失效：旧副本被压缩吞掉后，同内容注入必须整包重注', () => {
  const big = 'skill catalog v1'.repeat(200)
  const session = buildTextSession(2)
  appendInjection(session, 'skill-catalog', big)
  const before = visibleInjectionKeys(session)
  assert.ok(before.has(keyOf('skill-catalog', big)), '注入帧在面上 → 可见键存在')
  assert.equal(elideUnchangedInjections([msg('skill-catalog', big)], before).elided, 1, '副本仍可见 → 安全降级')

  const injSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  runCompactionTransaction(session, {
    start: 1,
    end: injSeq,
    shadowedSeqs: [...session.surface.nodes],
    summary: [{ type: 'text', text: 'Shadowed everything including the injected catalog frame.' }],
    shadowedTokenCount: 100,
    provider: 'p',
    model: 'm',
  } as never)
  const after = visibleInjectionKeys(session)
  assert.equal(after.has(keyOf('skill-catalog', big)), false, '遮蔽后键消失（面只剩摘要节点）')
  const r = elideUnchangedInjections([msg('skill-catalog', big)], after)
  assert.equal(r.elided, 0, '副本已被吞掉 → 不得降级（否则唯一副本被删）')
  assert.equal(messageText(r.messages[0]!.content), big, '整包重注')
})
