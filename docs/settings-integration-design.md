# 运行时设置集成设计（Settings Integration Design）— v2

> **目标**：让 `AcpConfig` 中适合运行时调整的数值项（上下文窗口、nudge 阈值、自动开关）接入宿主
> `ctx.settings` 设置体系——用户改 `~/.dsh/settings.yaml` 即热生效，无需重启；并提供 `/acp config`
> 斜杠命令在任意模式（TUI/web/headless）读写同一份配置。
>
> **范围声明**：本文档只覆盖**阶段一（宿主侧设置接缝）+ 阶段一b（`/acp config` 子命令）**。
> 浏览器端设置卡片是阶段三，被宿主 `WEB_SETTINGS_NAMESPACES` 白名单硬编码阻塞（见 §8），
> 需上游 deepseek-harness 先把暴露声明移入 `settings.register()`。
>
> **评审状态**：已经过三路独立评审（宿主接缝合规 / 引擎架构与回归风险 / 对抗性边界），
> 全部阻断项已修复，判定均为「修改后通过」。v2 修订明细见文末修订记录。

---

## 1. 背景与动机

今天所有引擎配置都走组合文件：bundle patch 行（零配置默认）+ 用户自己的同 ID
`compaction-acp` 行覆盖（见 AGENTS.md 设计决策 8）。这有两个痛点：

1. **改一个阈值要重启**。`cordis.patch.yml` 是启动时读一次的组合层，长会话中途想调低
   `nudgeMaxContextLimitPct`、或给某个网关补一个探测不到的 `modelContextLimit`，只能重启进程，
   会话现场（窗口缓存、nudge 去重状态）全部丢失。
2. **没有统一入口**。宿主已有完整的用户设置层（`~/.dsh/settings.yaml`，分 namespace 分层解析、
   热重载、写校验），bash 预算、agent-loop 并行度等都已接入。我们不接入，用户就要学两套配置心智。

宿主侧机制调查结论（2026-07，逐条对着安装版 dsh 0.1.0-rc.6 的 `lib/` 源码验证过）：

- **接缝**：`@deepseek-ai/dsh-settings` 导出 `installSettingsSection(ctx, ns, schema, entry, hooks)`
  （`lib/index.js:618`），是官方钦定的可选消费者接线：
  ```js
  function installSettingsSection(ctx, ns, schema, entry, hooks) {
    ctx.inject(["settings"], (sctx) => {
      const scope = sctx.settings.register(ns, schema, {
        base: entry,
        ...(hooks.validate === void 0 ? {} : { validate: hooks.validate })
      });
      hooks.setSource(() => scope.get());
      sctx.effect(() => () => {
        if (isUnloading(ctx)) return;
        hooks.setSource(() => entry);   // 服务脱离 → 回落组合层
        hooks.onChange();
      });
      hooks.onChange();
      scope.watch(() => {
        if (isUnloading(ctx)) return;
        hooks.onChange();
      });
    });
  }
  ```
  `hooks = { setSource(current), onChange(), validate?(value) }`。注册随注入 fiber 走：
  没有挂 settings 服务的 profile 上整段不执行，引擎按纯组合层行为工作（可选服务语义）。
- **分层**（`SettingsScope.get()`）：schema 默认值 → 组合 `base` 层 → 用户层
  （`~/.dsh/settings.yaml` 里该 namespace 的 section）。`replace({})` 整体重置回 base+默认。
- **写路径**：service 级 `update(ns, patch, expectedRevision?)` / `replace(ns, section, …)` /
  `mutate(ns, ops, …)`，每 namespace 串行化写队列；过期 revision 报
  `SettingsConflictError`（code `SETTINGS_CONFLICT`）。写前先对 resolved 候选跑校验，失败不落盘。
- **读路径**：`describe(options?) → SettingsDescriptor[]` 带 base 层与原始 user 层 +
  revision —— 正好够「哪个键被谁覆盖了」的展示，也够 reset 实现（从 user 层删键）。
- **失效语义**：provider 推送新文档时，非法 section 保留该 namespace 的 last-good 并告警；
  启动/注册时的非法存储则响亮失败（宿主统一契约，bash/agent-loop 同款）。
- **参照实现**：`dsh-agent-loop`（namespace `agent-loop`，schema
  `z.object({ maxParallelToolCalls: z.number().step(1).min(1).default(10) })`，用 getter 背书的
  config 对象读活值）；`dsh-bash-local`（bash 预算）。schema 库是
  `@deepseek-ai/schemastery` v3.18.1（zod 风格 API），约 90 个宿主包（含我们最近的姊妹
  `dsh-compaction-basic`）把它当运行时依赖；`dsh-settings` 本身是 apiproxy 等宿主包的运行时依赖。
  **两者都能从 dsh 安装根的 node_modules 解析到**，第三方插件经祖先链遍历可达。

## 2. 现状：我们的配置面与消费点

`AcpConfig`（src/index.ts:96-150）+ `DEFAULT_CONFIG`（src/index.ts:152-166）：

| 键 | 默认 | 阶段一是否暴露 | 理由 |
|---|---|---|---|
| `modelContextLimit` | 无（探测） | ✅ | 最常需要手动补的值（网关不披露窗口时）；改动需清窗口缓存 |
| `autoModelContextLimit` | `true` | ✅ | 与上键联动；改动同样影响窗口缓存 |
| `nudgeMinContextLimitPct` | 无（kernel 0.45 兜底，仅校验用） | ✅ | 纯数值 |
| `nudgeMaxContextLimitPct` | `0.70`（engine，刻意低于 kernel 0.75 与 host basic 0.80 线） | ✅ | 核心调参项 |
| `nudgeEmergencyThresholdPct` | `0.85`（engine，kernel/pi 为 0.95） | ✅ | 核心调参项 |
| `autoNudge` | `true` | ✅ | 开关本身无状态，热切换安全 |
| `coreOverrides` | 无 | ❌ 组合层专属 | 对象值不适合表单；且它是"最后合并"逃生舱（见 §5 优先级表） |
| `countTokens` | kernel `defaultCountTokens` | ❌ 组合层专属 | 函数值，无法 YAML/表单表达 |
| `prompts` | 内置模板 | ❌（阶段二再议） | 构造期 fail-fast 校验（`resolvePrompts`）+ systemPrompt.section 一次性注册，热更语义未解决，单独设计 |
| `autoTools` / `autoCommand` | `true` | ❌ 组合层专属 | 注册发生在构造期且带防双注册守卫，中途翻转语义不明 |
| `settingsEnabled` | `true` | ❌ 组合层专属（v2 新增 kill switch） | 设置集成的逃生舱；故意不进 schema——经设置层关闭自己的开关在设置层坏掉时关不掉 |

**消费点清单**（活值接线必须覆盖全部读取处）：

- src/tools.ts:92 — `windowForEnv` 回退分支读 `env.modelContextLimit`；
- src/tools.ts:271 与 tools.ts:681 — compress/status 工具内 `kernelConfigFor({ ...env, modelContextLimit: window.limit })`；
- src/commands.ts:54 — `/acp status` 同款 spread；
- src/index.ts:299 — pre-step 门 `if (!this.config.autoNudge) return next()`；
- src/index.ts:302-305 — `buildNudge(payload.agent, { ...env, modelContextLimit: window.limit }, …)`；
- src/index.ts:347-379 — `windowFor`：显式 `this.config.modelContextLimit` 直通分支 +
  `windowCache`（Map，key `` `${provider}\0${model}` ``，**连探测失败也缓存**，进程内不重试）；
- src/config.ts:41-57 — `kernelConfigFor` 把 pct 字段折进 nudge patch，`coreOverrides`（含
  `coreOverrides.nudge`）**最后合并**——此函数不改，优先级自然保持。

关键既有事实：每个消费点都是**调用时展开** `{ ...env }`——对象展开会当场读取 getter 取值。
这意味着只要让 `env` 的标量字段变成由活源背书的 getter，所有下游零改动即可读到最新值。

## 3. 方案总览

新增 src/settings.ts（M6），引擎构造器接线一处；命名空间 `compaction-acp`
（与组合行 ID 同名：用户心智 = 「settings.yaml 里这个 section 就是在改我那行 compaction-acp 的 config」）。

```
解析顺序（每键独立）：  schemastery schema 默认值
                      → base = 组合行 config 的【过滤后子集】(§4.2)
                      → 用户层 ~/.dsh/settings.yaml 的 compaction-acp section
写入入口：            手编 ~/.dsh/settings.yaml（provider publish 热生效）
                      或 /acp config set|reset（service.update/replace）
消费方式：            引擎 env 的标量字段改为活源 getter（§4.3）；onChange 清窗口缓存
```

数据流（以手编 settings.yaml 为例）：

```
dsh-settings-file 监听 ~/.dsh/settings.yaml
  → provider.publish(doc) → compaction-acp section 重新 resolve（非法则保 last-good 并告警）
  → scope.watch 触发 hooks.onChange()
  → 引擎：换 source thunk 已由 setSource 完成 → 清 windowCache → 日志一行
  → 下一个 pre-step / compress 调用经 {...env} 读到新值；windowFor 显式分支即时生效
```

## 4. 详细设计

### 4.1 Schema 定义

```ts
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const ACP_SETTINGS_NAMESPACE = settingsNamespace('compaction-acp')

// 注意：schemastery 3.18.1 的 number 链上没有 .int() / .positive()
// （已核验 lib/index.mjs：仅有 min/max/step/pattern；官方快捷方式
// Schema.natural = number().step(1).min(0)）。整数约束的唯一正确写法是
// agent-loop 同款 .step(1)，正数下界用 .min(1)。
export const AcpSettingsSchema = z.object({
  modelContextLimit: z.number().step(1).min(1).optional(),
  autoModelContextLimit: z.boolean().default(true),
  nudgeMinContextLimitPct: z.number().min(0).max(1).optional(),
  nudgeMaxContextLimitPct: z.number().min(0).max(1).default(0.7),
  nudgeEmergencyThresholdPct: z.number().min(0).max(1).default(0.85),
  autoNudge: z.boolean().default(true),
})
export type AcpSettings = z.output<typeof AcpSettingsSchema>
```

三条铁律：

- **schema 默认值 == 引擎默认值**（0.70/0.85/true，来自 `DEFAULT_CONFIG`），绝不写 kernel 的
  0.45/0.75/0.95——否则未触碰该 namespace 的部署行为就变了。`nudgeMinContextLimitPct` 与
  `modelContextLimit` 保持 optional 无默认：缺省时分别由 kernel 自身兜底（0.45 校验下限 /
  探测模式），单一事实来源不在我们这里，与今天一致。
- **默认值改动必须同步三处**：`DEFAULT_CONFIG`、本 schema、README 配置表。测试锁定（§6）。
- **边界语义以测试为准**：类型注释称 min/max 是 inclusive（含 0 与 1），但行为以运行时实测
  为准——§6 测试计划含边界值断言（0、1、1.0000001）。

### 4.2 base 过滤（保持 resolved 快照干净）

`installSettingsSection(ctx, ns, schema, entry, …)` 把 `entry` 原样作为 `base` 注册。评审核验：
**register 并不校验 base**（dsh-settings lib/index.js:311-313 原样存入），且 schemastery 的
object 解析器默认非 strict（lib/index.mjs:479-487 `if (!strict) merge(result, data)`）——未知键
会**透传进 deepFreeze 后的 resolved 快照**。所以过滤的理由不是「防注册失败」，而是：

1. **非 JSON 兼容值污染快照与 describe 路径**：组合行里的 `countTokens` 是函数、`coreOverrides`
   可能很大；函数值一旦进入 resolved，未来任何走 `structuredClone`/JSON 化的展示路径都可能炸。
2. **内存卫生**：无意义的大对象被冻结在每份快照里。
3. **语义清晰**：设置层 namespace 只描述它拥有的六个键。

因此 entry 必须是**只含六个已知键的白名单子集**（类型对齐 `z.input<typeof AcpSettingsSchema>`）：

```ts
function filterSettingsEntry(config: AcpConfig): AcpSettingsInput {
  const out: AcpSettingsInput = {}
  if (config.modelContextLimit !== undefined) out.modelContextLimit = config.modelContextLimit
  if (config.autoModelContextLimit !== undefined) out.autoModelContextLimit = config.autoModelContextLimit
  if (config.nudgeMinContextLimitPct !== undefined) out.nudgeMinContextLimitPct = config.nudgeMinContextLimitPct
  if (config.nudgeMaxContextLimitPct !== undefined) out.nudgeMaxContextLimitPct = config.nudgeMaxContextLimitPct
  if (config.nudgeEmergencyThresholdPct !== undefined) out.nudgeEmergencyThresholdPct = config.nudgeEmergencyThresholdPct
  if (config.autoNudge !== undefined) out.autoNudge = config.autoNudge
  return out
}
```

纯函数，单测直测。未列出的键继续只从 `this.config`（组合层）读取，行为不变。

### 4.3 活值接线：getter 背书的 env（照抄 agent-loop 形态)

```ts
// src/settings.ts
export interface SettingsRuntimeSource { (): AcpSettings }

// src/index.ts 构造器内
const baseEntry = filterSettingsEntry(this.config)
let source: SettingsRuntimeSource = () => ({
  // 初始活源 = 过滤后的组合子集经引擎默认值补齐（settings 服务接管前/缺席时的等价兜底，
  // 与服务脱离时 installSettingsSection 回落的同一个 filtered 对象同源同形）
  ...resolveAcpConfig(baseEntry),
})
// 上次已应用的快照——onChange 无参回调（helper 不透传 watch 的 next/prev），前值必须自己记。
// 直接引用构造期闭包变量当 prev 是评审抓出的悬垂 bug：它会永远停在初始值。
let lastApplied: AcpSettings = source()

const applySettingsChange = (): void => {
  const next = source()
  try {
    this.onSettingsChanged(lastApplied, next)   // §4.4
  } catch (error) {
    // watcher 链只 contain 异步异常；同步抛出会冒泡进 settings 服务的 commit 循环——必须自己兜住
    this.ctx.logger.warn('billion-context-dsh: settings change handler failed — previous behavior kept', error)
  }
  lastApplied = next
}

const env: ToolEnvironment = {
  kernel: this.kernel,
  store: this.store,
  // ↓ 三个阈值 + 窗口字段改为 getter；{ ...env } 展开时当场取当前值
  get modelContextLimit() { return source().modelContextLimit ?? DEFAULT_CONTEXT_WINDOW },
  get nudgeMinContextLimitPct() { return source().nudgeMinContextLimitPct },
  get nudgeMaxContextLimitPct() { return source().nudgeMaxContextLimitPct },
  get nudgeEmergencyThresholdPct() { return source().nudgeEmergencyThresholdPct },
  coreOverrides: this.config.coreOverrides,   // 组合层专属，不经设置层
  windowFor: (agent) => this.windowFor(agent),
  prompts: this.prompts,
  compressCallIdsToHide: this.compressCallIdsToHide,
}

if (this.config.settingsEnabled !== false) {   // kill switch，见下
  installSettingsSection(ctx, ACP_SETTINGS_NAMESPACE, AcpSettingsSchema, baseEntry, {
    validate: (value) => this.validateSettings(value),   // §4.5
    setSource: (current) => { source = current },        // 官方接线：换活源
    onChange: () => { applySettingsChange() },
  })
  // /acp config 用的服务句柄（平行注入，只捕获引用，不重复注册 namespace）
  ctx.inject(['settings'], (sctx) => { this.settingsService = sctx.settings })
}
```

**kill switch `settingsEnabled`**（新增组合层专属键，默认 `true`）：为 `false` 时跳过整段接线，
env 纯读 `source()` 初始值——等价于今天的纯组合层行为。这是功能炸裂时的逃生舱（schema 误报、
回调异常、注册冲突），不需要卸包重启丢会话现场。它**故意不进 settings schema**——一个通过
设置层才能关闭自己的开关，在设置层本身坏掉时关不掉。

为什么选 getter 而不是「变更时重建 env 对象」：`env` 在构造期就被 `makeTools(env)` /
`acpCommand(env)` 捕获引用，重建对象等于换掉工具闭包里的旧引用，除非重注册工具——那会把阶段一
做成阶段三级别的手术。getter 让引用恒定、值恒活，与 agent-loop 的
`get maxParallelToolCalls() { return source().… }` 完全同构，也是宿主钦定形态。

`ToolEnvironment extends KernelConfigInput` 的字段全是 `readonly`——TS 的 getter 天然满足
readonly 接口，现有类型零改动。测试里手工拼的普通对象 env 不受影响（有值即真值）。

### 4.4 变更应用点（onChange 的职责）

```ts
private onSettingsChanged(prev: AcpSettings, next: AcpSettings): void {
  // 窗口相关任一键变化 → 清整个窗口缓存。缓存连探测失败一起存（issue #63 的教训），
  // 清除后下一次 pre-step 立即重新探测——比今天的「重启才能重试」更好。
  if (prev.modelContextLimit !== next.modelContextLimit
      || prev.autoModelContextLimit !== next.autoModelContextLimit) {
    this.windowCache.clear()
  }
  // 顺序异常只警告不拒绝（理由见 §4.5）
  if ((next.nudgeMinContextLimitPct ?? 0) >= next.nudgeMaxContextLimitPct) {
    this.ctx.logger.warn('billion-context-dsh: nudgeMinContextLimitPct >= nudgeMaxContextLimitPct — growth-based nudges are effectively disabled (over-limit guarantee still applies)')
  }
  if (next.nudgeMaxContextLimitPct > next.nudgeEmergencyThresholdPct) {
    this.ctx.logger.warn('billion-context-dsh: nudgeMaxContextLimitPct > nudgeEmergencyThresholdPct — emergency tier will never fire')
  }
  this.ctx.logger.info(`billion-context-dsh: settings updated (compaction-acp)`)
}
```

- **autoNudge 门**：index.ts:299 改为 `if (!source().autoNudge) return next()`。开关翻转即刻生效。
  关→开翻转时顺手 `this.lastNudgeTurn.clear()`：kernel 的去重节奏语义（「同 turn 不重复」还是
  「距上次不足 N turn 跳过」）不构成我们的依赖，清空的成本只是下一次 nudge 可能早到一拍（advisory
  性质），而留着过期记录的代价可能是重新打开后该响的不响——防御性选便宜的那边。
- **windowFor**：index.ts:348 的 `this.config.modelContextLimit !== undefined` 改读活源；
  index.ts:357 的 `autoModelContextLimit` 同理。显式值设置/移除即时切换探测↔显式路径
  （§6 测试 11 显式锁定这条语义）。
- **不动的东西**：`kernelConfigFor` 合并逻辑（src/config.ts）、`lastNudgeTurn`、
  `compressCallIdsToHide`、系统提示词 section（文案不含任何阈值数字，阈值变化不影响提示词）、
  四个工具与 `/acp` 命令的注册。

### 4.5 validate 的宽严边界（宁松勿紧）

**只做 schema 级边界（[0,1] 区间、正整数窗口），不做跨字段拒绝。** 顺序异常
（min ≥ max、max > emergency）走 §4.4 的警告路径。理由：注册时会校验已存储的 user section，
若 validate 比**今天的容忍度**更严，一个升级前被默默容忍的手写组合（例如 min=max）会在升级后
变成启动失败——违背「不破坏现有定制部署」。今天的引擎对任意数值组合都不拒绝（kernel 内部自行
处理退化情形），所以设置层的写校验不得严于现状。

### 4.6 `/acp config` 子命令（阶段一b）

挂在现有 `acpCommand`（src/commands.ts:141-150 的 status|compress|decompress 之后）：
`/acp config [set <key> <value> | reset <key>|all]`。

- **服务句柄获取**：`installSettingsSection` 不吐 scope，但 service 级 API 够用。引擎另起一个
  平行注入只捕获服务引用（**不重复注册** namespace）：
  ```ts
  ctx.inject(['settings'], (sctx) => { this.settingsService = sctx.settings })
  ```
  effect 清理时置回 undefined。`/acp config` 执行时若服务缺席（TUI 纯净 profile 等），
  输出一句人话：「设置服务在本 profile 未启用，请改用 cordis.patch.yml 的 compaction-acp 行配置」。
- **`/acp config`（列表）**：`settings.describe()` 过滤出本 namespace，渲染
  `键 | 生效值 | 来源(default/base/user)` 表——descriptor 同时带 base 与原始 user 层，
  「user 层含该键」即标记覆盖。若组合层存在同名 `coreOverrides.nudge.*`，在表尾加一行脚注：
  「nudge 阈值的实际产物以 coreOverrides 为准（它最后合并）」——否则列表展示的设置层生效值会
  高估自己的权威（评审核验过的误导场景）。
- **`/acp config set <key> <value>`**：value 解析规则（评审 B3 的教训——裸 `JSON.parse` 会把
  最常见的小数写法弄坏）：
  1. trim 后先匹配字面量 `'true'`/`'false'` → boolean；
  2. 再试 `Number(value)`，有限数即取数字（覆盖 `.7`、`128000`、`1e5` 等一切 JS 数字面量；
     JSON.parse 不接受前导小数点，`.7` 会静默退化成字符串再被 schema 拒掉）；
  3. `'null'`/`null` → 不走 set，转单键 reset 语义（删 user 层该键；「清回探测模式」的正规
     入口是 `/acp config reset modelContextLimit`，输出文案里明示）；
  4. 其余走 `JSON.parse` 兜底字符串（带引号的键名等），失败则报错并附正确用法示例。
  然后 `settings.update(ACP_SETTINGS_NAMESPACE, { [key]: value })`。捕获
  `SettingsConflictError` → 提示「配置刚被其他入口修改，请重试」；校验失败把 service 的报错原文
  （含路径）透出。成功输出注明热生效语义（如涉及窗口键则注明「窗口缓存已清，下次步骤重新探测」），
  并注明首版未用乐观锁（同键并发写为静默后者胜）。
- **`/acp config reset <key>|all`**：从 descriptor 读原始 user section，删键（或 `all` →
  `replace({})` 整体重置回 base+默认）。merge-only patch 表达不了删除，必须走 replace/mutate。
  输出必须讲清楚回落到哪：「reset to composition base (0.80) — schema default is 0.70;
  change the compaction-acp composition row or override via coreOverrides if you want a different
  base」——**reset 回落的是组合行 base，不是引擎默认值**，这是分层模型最反直觉的一点。
- 命令全程进程内调用，**不经过 wire 白名单**，TUI/web/headless 通吃；web 端设置页看不到本
  namespace 是预期行为（§8），`/acp config` 就是 web 模式下的替代入口。
- 输出文案遵守仓库「plain-language」规范；与现有 `/acp status` 输出风格一致（英文正文）。

### 4.7 依赖与打包

- `package.json` peerDependencies 新增：
  - `"@deepseek-ai/dsh-settings": "^0.1.0-rc.6 || ^0.1.1-rc.1"` —— 双元组 clause，
    issue #68 规则（node-semver prerelease 匹配要求同 tuple 比较子）；
  - `"@deepseek-ai/schemastery": "^3.18.1"` —— 普通语义化版本，与宿主包一致，无 tuple 问题。
- devDependencies 新增两者、钉在 `0.1.0-rc.6` / `3.18.1`（稳定测试基线规则）。
- tsup external 已按 `@deepseek-ai/*` 前缀外置，无需改（实现时确认 glob 覆盖新包名）。
- 运行时可解析性依据：两包均为 dsh 安装根 node_modules 内的既存包（dsh-settings 由 apiproxy/
  client-ui-* 等运行时依赖，schemastery 由约 90 个包含 dsh-compaction-basic 运行时依赖），
  第三方插件经 Node 祖先链遍历解析；我们现有 `@deepseek-ai/*` peer 走的就是同一机制。
- `tests/peer-range.test.ts` 增加 dsh-settings 的双元组断言（该文件就是为此设的回归守卫）。

## 5. 明确不做的事（及优先级语义）

| 项 | 决定 | 理由 |
|---|---|---|
| 浏览器设置卡片 | 阶段三 | `WEB_SETTINGS_NAMESPACES` 硬编码白名单（dsh-host-apiproxy lib/index.js ≈:886）不含自定义 ns，web wire 一律答 `settings-not-exposed`；上游注释明确「暴露声明移入 settings.register()」是 deferred 工作。等上游动了再做，届时浏览器半边机制（`exports["./client"]` + `dsh.client:` 双半包）已探明 |
| `prompts` 进设置层 | 阶段二单独设计 | `resolvePrompts` 构造期 fail-fast + systemPrompt.section 一次性注册，热更需要「重校验 + 重注册 section」语义，不是本阶段的 getter 模式能顺带解决的 |
| `coreOverrides` / `countTokens` | 永久组合层 | 对象/函数值无法进 YAML 表单层；保留为高级逃生舱 |
| `autoTools` / `autoCommand` | 永久组合层 | 构造期注册 + 防双注册守卫，中途翻转无意义 |

**优先级总表**（写进 README）：

```
coreOverrides.nudge.X  >  settings.yaml compaction-acp.X / 组合行 config.X（base 与 user 同级后者胜）
                       >  schema 默认值（== 引擎默认）
```

`coreOverrides` 仍是最后的逃生舱：它不经设置层、在 `kernelConfigFor` 里最后合并，所以即使设置层
改了 `nudgeMaxContextLimitPct`，同名的 `coreOverrides.nudge.maxContextLimitPct` 依旧赢——
与今天的语义完全一致，只是文档要讲清楚。

另一条要写进 README 的分层事实（评审核验过的困惑点）：**reset 回落到组合行 base 层，
不是 schema/引擎默认值**。组合行写了 `nudgeMaxContextLimitPct: 0.8` 的用户，settings reset 后
是 0.8；想要引擎默认 0.70，得改组合行本身。

## 6. 测试计划

新文件 tests/settings.test.ts（Node 内建 test runner，静态 import，禁 `as any`/`require`）：

1. **filterSettingsEntry 纯函数**：含 prompts/coreOverrides/countTokens/autoTools/autoCommand
   的输入 → 输出只含六键；undefined 键不出现在输出对象。
2. **schema 默认值锁定**：空 section 解析结果 === `{ autoModelContextLimit: true,
   nudgeMaxContextLimitPct: 0.7, nudgeEmergencyThresholdPct: 0.85, autoNudge: true }`，
   且 `modelContextLimit`/`nudgeMinContextLimitPct` 为 undefined——与 `DEFAULT_CONFIG` 驱动的
   现行为逐字段相等（防止未来有人只改一边）。
3. **getter-env 快照语义**：替换 source thunk 后，`{ ...env }` 展开反映新值；四个 getter 各测；
   普通对象 env（测试旧路径）不受影响。
4. **onChange 行为**：modelContextLimit/autoModelContextLimit 变化 → windowCache.clear() 被调用
   （注入 spy windowFor 或观察后续 windowFor 行为）；阈值变化不清缓存；顺序异常产生 warn 日志、
   不抛错。
5. **validate 宽容矩阵**：越界（1.2、-0.1、NaN 序列化形）被 schema 拒；min≥max、max>emergency
   通过校验。
6. **detach 回落**：模拟 settings 服务脱离（触发 installSettingsSection 的 effect 清理路径）→
   source 回落到 baseEntry，env 继续可用。（对齐 helper 合同的消费者侧断言。）
7. **E2E-ish 全环**：用 `@deepseek-ai/dsh-settings` 导出的 `SettingsProvider` 基类造内存 provider
   ——子类实现 `writable/load/persist` 并在测试里**调用继承的 `this.publish(doc)`** 推送文档
   （publish 是 protected 方法，调用而非覆写），真实 service + `installSettingsSection` + 我们的接线：
   update → watch 回调 → env getter 反映 → kernelConfigFor 产物含新 pct →
   `replace({})` 重置回落。非法 section publish → last-good 保持。
8. **`windowFor` 活值语义**：设置 `modelContextLimit: 200000` → `windowFor` 返回
   `{ limit: 200000, source: 'explicit' }`；再 reset 该键 → 回到探测路径。这是「getter 化是
   隐式语义变更」的显式锁定用例（评审要求）。
9. **set 即时可见性**：`update` resolve 完成后、下一个 pre-step 前，`{ ...env }` 已反映新值
   （写队列串行化保证 update await 返回即生效）。
10. **kill switch**：`settingsEnabled: false` → 不触发注册路径（spy installSettingsSection 或
    断言无 settings 相关 effect）、env 读初始组合值、行为与今天完全一致。
11. **autoNudge 翻转**：false→true 时 `lastNudgeTurn.clear()` 被调用；true→false 不清。
12. **schema 边界实测**：`min(0).max(1)` 是否含边界——0 与 1 必须通过、1.0000001 被拒；
    `modelContextLimit` 的 `.step(1).min(1)`：1 通过、0 与小数被拒。
13. **/acp config**：列表输出含来源标记 + coreOverrides 脚注；set 合法/非法键（含 `.7` 小数、
    `'null'` 转 reset、垃圾串报错文案）；reset 单键与 all 的回落值展示；服务缺席时的降级文案。
14. **peer-range**：`tests/peer-range.test.ts` 补 dsh-settings 双元组断言。
15. **全量回归**：现有 162+ 测试全绿——env 形状不变是前提，任何下游测试红都说明接线侵入了
    不该侵入的地方。

## 7. 文档同步清单（同一 PR 内完成）

- README.md / README.en.md：配置表标注哪些键可热调（用 ✅/— 脚注式标记，不重构现有
  键/默认值/含义三列结构）；新增「运行时设置」节（settings.yaml 示例 + 优先级总表 +
  「reset 回落到组合行 base」的说明 + `/acp config` 用法）。
- docs/INSTALL.md：组合选项处补一段「settings.yaml 是运行时覆盖层」。
- docs/settings-integration-design.md：本文。
- AGENTS.md：模块图加 `src/settings.ts # M6`; 若实现中发现新的坑，沉淀为 hard-won rule
  （候选：「base 必须过滤到 schema 已知键」「写校验不得严于历史容忍度」）。
- docs/dsh-porting-verification.md：无需动（非 UPSTREAM workaround）。

## 8. 风险与开放问题

v2 状态：R1–R5 已由评审核验关闭，遗留两个实现期验证门（V1/V2）。

- **R1 schemastery API —— 已关闭**。`.int()`/`.positive()` 在 3.18.1 不存在（number 链仅
  min/max/step/pattern，lib/index.mjs:168-300；`Schema.natural = number().step(1).min(0)`）。
  schema 已改为 `.step(1).min(1)`；min/max 的 inclusive 语义以测试实测为准（§6 用例 12）。
- **R2 register 是否校验 base —— 已关闭**：不校验（lib/index.js:311-313 原样存入），且 object
  解析器非 strict 会把未知键透传进 deepFreeze 后的 resolved 快照（lib/index.mjs:479-487）。
  过滤保留，理由已改写为快照卫生（§4.2）。
- **R3 HMR 重载同名注册 —— 已关闭（附一个实现门）**。重复注册直接抛
  `settings namespace "X" is already registered`（lib/index.js:312），但注册生命周期挂在
  `ctx.effect` 上、disposer 执行 `registrations.delete(ns)`（lib/index.js:323-326）；cordis
  先 dispose 旧 fiber 再激活新 fiber，正常 HMR 顺序下不冲突。附带事实：对已注销 registration
  的排队写会抛 `registration was disposed before the queued … ran`（:454）。**V1 实现门**：
  合并前跑最小复现——挂内存 provider，构造引擎 → dispose fiber → 同 ctx 重新构造，断言成功；
  若失败（dispose 与构造并发竞争），预案是捕获注册失败降级为纯组合层 + warn。
- **R4 模块解析 —— 已关闭**。`@deepseek-ai/dsh-settings` 是 dsh-host-apiproxy 等 14+ 宿主包的
  运行时依赖，`@deepseek-ai/schemastery` 是约 86 个宿主包（含姊妹插件 dsh-compaction-basic）的
  运行时依赖，两包在 dsh 元包 node_modules 常驻，祖先链遍历可达。动态 import 降级预案删除。
- **R5 expectedRevision —— 决定记录在案**：首版不带（per-namespace 写队列串行；同键并发写为
  静默后者胜），set 成功输出注明此事；乐观锁 UX 留待真实冲突出现再议。
- **R6 描述文本**：`describe()` 的 redactSecrets 对本 ns 无意义（无 secret 键），但列表输出
  统一走 redact 路径以防未来加键踩线。
- **V1**：见 R3 的最小复现门。
- **V2**：schemastery ESM 解析链实装确认——tsup external glob `@deepseek-ai/*` 外置后由宿主
  node_modules 解析 `.mjs`（包为 CJS+ESM 双格式），构建产物在本机 dsh 安装下 smoke 一次即可。

## 修订记录

- **v2（评审吸收稿）**：三路独立评审（宿主接缝合规 / 引擎架构与回归风险 / 对抗性边界，
  全部「修改后通过」）+ 主笔人对关键指控的源码复核后修订：
  - 【阻断】schema `.int()/.positive()` 不存在（三路一致 + lib/index.mjs 复核）→
    `.step(1).min(1)`（§4.1）；
  - 【阻断】onChange 引用构造期闭包 prev 是悬垂 bug（helper 不透传 watch 的 next/prev）→
    自维护 `lastApplied` 快照（§4.3）；
  - 【阻断】`/acp config set` 裸 JSON.parse 弄坏 `.7` 小数与 null 语义 → 四步解析规则 +
    null 转 reset（§4.6）；
  - 【阻断】缺 kill switch → 组合层专属 `settingsEnabled`（默认 true，故意不进 schema）（§4.3、§2）；
  - 【修正】base 过滤理由改写：register 不校验 base、object 解析器非 strict 透传未知键进
    resolved 快照，过滤是快照卫生而非启动防御（§4.2）；
  - 【加固】onChange 同步异常 try/catch 兜底（防冒泡进 commit 循环）；autoNudge 关→开清
    `lastNudgeTurn`；validate 宽松理由精确化（首次注册失败即启动失败的宿主契约）；reset 回落
    base 而非引擎默认的文案与文档要求；列表输出补 coreOverrides 覆盖脚注；E2E publish 用词
    （protected 方法调用而非覆写）；测试计划从 10 条扩到 15 条（含 windowFor 活值语义、
    set 即时可见性、kill switch、翻转清去重、边界实测）；
  - 【关闭】R2/R3/R4 以源码证据定案，新增 V1/V2 两个实现期验证门（§8）。
- **v1（评审稿）**：初版。基于 2026-07 宿主 settings 接缝调查（dsh-settings 0.1.0-rc.6 lib 源码
  逐行核验）与本仓库配置面盘点。
