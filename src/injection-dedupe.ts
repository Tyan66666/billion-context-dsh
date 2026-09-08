/**
 * injection-dedupe — B2 不变包引用化（2026-09-08 过度工程治理方案 §4 B2）。
 *
 * 病根（方案普查）：AGENTS.md 6,032 B + skill catalog 9,012 B + runtime 2,412 B
 * 各注 4 次 = 60 KB；skill catalog 的文案还谎报 `changed`——同一份内容被反复整包重注。
 *
 * 改法：对 agent-instructions / skill-catalog / runtime context 做内容哈希比对——
 * 未变则把该帧正文替换成 `[unchanged: sha1:<hash>]`（≤60 B）；变了才整包重注。
 * `changed` 文案由哈希真判定（hash 不同=changed；相同=unchanged），不靠调用方自觉。
 *
 * ⚠ 2026-09-08 重载后活体复核修正（原实现有丢失缺陷）：原版按「每会话持久哈希台账」
 * 跨请求比对，于是**只要旧副本被压缩遮蔽过**，下一次同内容注入就会被降成 38 B 的
 * 引用帧——而上下文里已无第二份副本，等于把技能目录整包删掉。实测普查本会话 4 次
 * 目录注入：2/2 同内容重注都发生在旧副本刚被压缩遮蔽之后（省字节 0 次、丢内容 2 次），
 * 且 `reset()` 从无调用点，哈希永不清除。
 *
 * 修正后的判定面 = **当前会话面上是否仍有同 kind + 同哈希的副本**：
 *   - 旧副本仍可见 → 降为引用帧（真正的重复，安全省字节）；
 *   - 旧副本已被遮蔽/不存在 → 整包重注（它是唯一一份，删不得）。
 * 判定由 `visibleInjectionKeys(session)` 从会话面（surface.nodes × events）现算，
 * 不再持有跨请求状态，也不再需要 reset。
 *
 * 判定面是 pre-step 决策里的 DSH 消息（带 `source.kind`）；真人帧、工具结果、子代理回执
 * 不在白名单内，永不参与。
 */

import { createHash } from 'node:crypto'

/** 参与去重的注入来源（白名单：只有「每拍重注同一份内容」的包才配去重）。 */
export const DEDUPE_SOURCES: readonly string[] = ['agent-instructions', 'skill-catalog', 'runtime', 'runtime-context']

/** 未变引用帧：`[unchanged: sha1:<12位>]` = 38 B（远低于 60 B 上限）。 */
export const UNCHANGED_PREFIX = '[unchanged: sha1:'

export function sha1Short(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

export function unchangedStub(hash: string): string {
  return `${UNCHANGED_PREFIX}${hash}]`
}

/** 可见键：`<kind>#<sha1>`（同种来源的多份包靠哈希各自成键，不会互相顶掉）。 */
export function injectionKey(kind: string, hash: string): string {
  return `${kind}#${hash}`
}

/** 去重面最小结构（DSH 消息与测试桩都满足）。 */
export interface InjectedMessageLike {
  readonly source?: { readonly kind?: unknown }
  readonly content?: unknown
}

/** 会话面最小结构（@deepseek-ai/dsh-session 的 Session 满足）。 */
export interface SessionSurfaceLike {
  readonly surface?: { readonly nodes?: readonly number[] }
  readonly events?: readonly unknown[]
}

/** 提取消息文本（字符串 content 或 text 块拼接，递归取嵌套 content）。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (Array.isArray(b.content)) parts.push(messageText(b.content))
  }
  return parts.join('\n')
}

/**
 * 现算「当前仍可见的注入帧指纹集合」。只走 surface.nodes（已遮蔽的节点不在面上），
 * 因此压缩吞掉旧副本后，它的键自然消失——调用方据此判定能否降级。
 */
export function visibleInjectionKeys(session: SessionSurfaceLike): Set<string> {
  const keys = new Set<string>()
  const nodes = session?.surface?.nodes ?? []
  const events = session?.events ?? []
  for (const seq of nodes) {
    const event = events[seq as number] as
      | { data?: { source?: { kind?: unknown }; content?: unknown } }
      | undefined
    if (event === null || event === undefined) continue
    const kind = event.data?.source?.kind
    if (typeof kind !== 'string' || !DEDUPE_SOURCES.includes(kind)) continue
    const text = messageText(event.data?.content)
    if (text.length === 0) continue
    keys.add(injectionKey(kind, sha1Short(text)))
  }
  return keys
}

export interface ElideResult<T> {
  readonly messages: T[]
  readonly elided: number
  readonly injectedBytes: number
  readonly savedBytes: number
}

/**
 * 纯函数：把「已有可见副本的注入帧」正文替换为引用帧。
 * `visible` = 当前会话面上仍存在的注入帧键集合（`visibleInjectionKeys` 现算）。
 * 不在 `visible` 里的帧一律整包重注——它是唯一一份，降级即等于丢失。
 */
export function elideUnchangedInjections<T extends InjectedMessageLike>(
  messages: readonly T[],
  visible: ReadonlySet<string>,
): ElideResult<T> {
  let elided = 0
  let injectedBytes = 0
  let savedBytes = 0
  const out = messages.map((message) => {
    const kind = message?.source?.kind
    if (typeof kind !== 'string' || !DEDUPE_SOURCES.includes(kind)) return message
    const text = messageText(message.content)
    if (text.length === 0) return message
    const hash = sha1Short(text)
    const fullBytes = Buffer.byteLength(text, 'utf8')
    if (!visible.has(injectionKey(kind, hash))) {
      // 旧副本不在面上（首见，或已被压缩遮蔽）= 唯一一份 → 整包重注。
      injectedBytes += fullBytes
      return message
    }
    const stub = unchangedStub(hash)
    const stubBytes = Buffer.byteLength(stub, 'utf8')
    elided += 1
    injectedBytes += stubBytes
    savedBytes += fullBytes - stubBytes
    return { ...message, content: [{ type: 'text', text: stub }] } as T
  })
  return { messages: out, elided, injectedBytes, savedBytes }
}
