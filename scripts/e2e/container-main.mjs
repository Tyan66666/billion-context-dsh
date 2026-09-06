// E2E 容器内执行器（docs/e2e-testing-design.md「运行器与产物」）。
//
// 由宿主机 run.mjs 通过 `docker run` 调起，前置条件：
//   - /repo   挂载本仓库（dist 已由宿主 npm run build 构建为最新）
//   - /out    挂载产物目录（宿主 scripts/e2e/out）：dshhome/、results/、report.json
//   - 环境变量：DSH_PERMISSION_MODE=danger-full-access（run.mjs 固定注入）；
//     API key 经 --env-file / docker -e 传入本进程环境（credentials 链第一优先级）
//   - ACP_E2E_SCENARIOS（可选，逗号分隔 id，缺省全跑）、ACP_E2E_TIMEOUT_MS（单场景超时）
//   - ACP_E2E_PROVIDER / ACP_E2E_MODEL / ACP_E2E_BASE_URL / ACP_E2E_API /
//     ACP_E2E_API_KEY_ENV（可选；缺省用 launcher 自带 deepseek-official 路由）
//
// 本进程只依赖 Node 内置模块 + 容器内已装好的 dsh/pnpm/zstd。

import { spawnSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCENARIOS, selectScenarios, parseSessionLog, indexToolCalls, compactionEvents } from './scenarios.mjs'

const HOME = '/out/dshhome'
const OUT = '/out'
const PROFILE = join(HOME, 'profiles', 'acp-e2e')

const log = (msg) => process.stdout.write(`[e2e] ${msg}\n`)

// ── 1. settings.yaml：模型路由（JSON 是合法 YAML，直接 stringify）──────────

function writeSettings() {
  const provider = process.env.ACP_E2E_PROVIDER || 'deepseek-official'
  const model = process.env.ACP_E2E_MODEL || 'deepseek-v4-flash'
  const doc = { 'agent-default-model': { provider, model } }
  if (provider !== 'deepseek-official') {
    // dsh-llm-pi-ai 的设计：组合决定适配器存在，settings 决定 provider 运行。
    // key 按名字引用环境变量（credentials 链：进程环境优先），本文件不含密钥。
    const keyEnv = process.env.ACP_E2E_API_KEY_ENV || 'ACP_E2E_API_KEY'
    const baseURL = process.env.ACP_E2E_BASE_URL
    if (!baseURL) throw new Error('ACP_E2E_PROVIDER 非 deepseek-official 时必须提供 ACP_E2E_BASE_URL')
    doc['llm-pi-ai'] = {
      providers: {
        [provider]: {
          api: process.env.ACP_E2E_API || 'openai-completions',
          baseURL,
          apiKeyEnv: keyEnv,
          models: [{ id: model, name: model }],
        },
      },
    }
  }
  writeFileSync(join(HOME, 'settings.yaml'), JSON.stringify(doc, null, 2))
  log(`settings.yaml: provider=${provider} model=${model}`)
}

// ── 2. profile 组装（runner 自建，幂等；决策 2：不用 dsh plugin add）──────────

function assembleProfile() {
  rmSync(join(HOME, 'profiles'), { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-acp-e2e',
    private: true,
    dependencies: { 'billion-context-dsh': 'file:/repo' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'billion-context-dsh'] } },
  }, null, 2))
  // 我们的 bundle patch（cordis.patch.yml，随 file: 安装生效）自动禁 compaction-basic
  // 并挂 compaction-acp —— "安装即生效"契约本身就是被测对象，用户层保持空。
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')
  const r = spawnSync('bash', ['-lc', `cd '${PROFILE}' && pnpm install --silent`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`profile pnpm install 失败:\n${r.stdout}\n${r.stderr}`)
  log(`profile 组装完成: ${PROFILE}`)
}

// ── 3. 会话日志定位与解码 ──────────────────────────────────────────────

function sessionDirNames() {
  // diff 的粒度必须是 slug/session-uuid 两级：同一 cwd 的 slug 目录会跨运行
  // 复用（headless 每次新建 session-<uuid>，但 slug 目录同名）——首测教训：
  // 只 diff slug 层会把"同 slug 下的新 uuid"误判为旧目录，丢掉整份日志。
  const root = join(HOME, 'sessions')
  const out = new Set()
  if (!existsSync(root)) return out
  for (const slug of readdirSync(root)) {
    const sd = join(root, slug)
    let subs = []
    try { subs = readdirSync(sd) } catch { continue }
    for (const s of subs) out.add(slug + '/' + s)
  }
  return out
}

/** 找出本次运行新产生的（before 里没有的）最新 session.jsonl.zstd。 */
function newestSessionLog(before) {
  const root = join(HOME, 'sessions')
  if (!existsSync(root)) return null
  let best = null
  for (const slug of readdirSync(root)) {
    const sd = join(root, slug)
    let subs = []
    try { subs = readdirSync(sd) } catch { continue }
    for (const s of subs) {
      if (before.has(slug + '/' + s)) continue
      const candidate = join(sd, s, 'session.jsonl.zstd')
      if (!existsSync(candidate)) continue
      const m = statSync(candidate).mtimeMs
      if (!best || m > best.m) best = { log: candidate, m }
    }
  }
  return best?.log ?? null
}

function decodeLog(logPath) {
  // 多帧 zstd 拼接：Node 的 zstdDecompressSync 只解第一帧，必须用 zstd CLI。
  return execSync(`zstd -dc '${logPath}'`, { maxBuffer: 256 * 1024 * 1024 }).toString()
}

// ── 4. 逐场景执行 ──────────────────────────────────────────────

function runScenario(sc) {
  const cwd = join(OUT, 'scen', sc.id, 'cwd')
  rmSync(join(OUT, 'scen', sc.id), { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  sc.fixturesOf = sc.fixtures ? sc.fixtures.call(sc, cwd) : null
  const task = typeof sc.task === 'function' ? sc.task.call(sc) : sc.task

  const args = ['--profile', 'acp-e2e']
  if (sc.patch) {
    const patchPath = join(OUT, 'scen', sc.id, 'patch.yml')
    writeFileSync(patchPath, sc.patch + '\n')
    args.push('--patch', patchPath)
  }
  args.push(task)

  const before = sessionDirNames()
  const t0 = Date.now()
  const r = spawnSync('dsh', args, {
    cwd,
    encoding: 'utf8',
    timeout: Number(process.env.ACP_E2E_TIMEOUT_MS || 420000),
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: HOME },
  })
  const durationMs = Date.now() - t0

  const sessionLog = newestSessionLog(before)
  let events = []
  let rawLogText = ''
  if (sessionLog) {
    rawLogText = decodeLog(sessionLog)
    events = parseSessionLog(rawLogText)
  } else {
    log(`⚠ ${sc.id}: 未找到新产生的会话日志`)
  }

  const ctx = {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    events,
    rawLogText,
    sessionLog,
    tools: indexToolCalls(events),
    comp: compactionEvents(events),
  }
  const results = sc.assert.call(sc, ctx)
  const hardFailed = results.filter((x) => !x.soft && !x.pass)
  return {
    id: sc.id,
    title: sc.title,
    issues: sc.issues,
    exitCode: ctx.exitCode,
    durationMs,
    sessionLog: ctx.sessionLog,
    summaryCount: ctx.comp.summaries.length,
    pruneCount: ctx.comp.prunes.length,
    task,
    results,
    passed: hardFailed.length === 0 && ctx.sessionLog !== null,
  }
}

// ── main ──────────────────────────────────────────────

mkdirSync(HOME, { recursive: true })
mkdirSync(join(OUT, 'results'), { recursive: true })
assembleProfile()
writeSettings()

const scenarios = selectScenarios(process.env.ACP_E2E_SCENARIOS)
if (scenarios.length === 0) throw new Error(`ACP_E2E_SCENARIOS 没有匹配到任何场景: ${process.env.ACP_E2E_SCENARIOS}`)
log(`共 ${scenarios.length} 个场景: ${scenarios.map((s) => s.id).join(', ')}`)

const runs = []
for (const sc of scenarios) {
  log(`▶ ${sc.id} — ${sc.title}`)
  let run
  try {
    run = runScenario(sc)
  } catch (err) {
    run = { id: sc.id, title: sc.title, issues: sc.issues, exitCode: -1, durationMs: 0, sessionLog: null,
      summaryCount: 0, pruneCount: 0, task: '', results: [{ name: '执行器异常', pass: false, detail: String(err?.stack || err), soft: false }], passed: false }
  }
  runs.push(run)
  // 每个场景的结果立即落盘：中途失败/被杀时，已完成场景的证据不丢
  //（首测教训：只写最终 report.json，中途诊断只能去翻原始日志）。
  writeFileSync(join(OUT, 'results', `${run.id}.json`), JSON.stringify(run, null, 2))
  const failed = run.results.filter((x) => !x.pass)
  log(`${run.passed ? '✓' : '✗'} ${sc.id} (${Math.round(run.durationMs / 1000)}s, summary=${run.summaryCount})` +
    (failed.length ? ` — 失败: ${failed.map((f) => f.name).join('; ')}` : ''))
}

const report = {
  passed: runs.every((r) => r.passed),
  generatedAt: new Date().toISOString(),
  scenarios: runs,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
log(`报告: ${join(OUT, 'report.json')} — ${report.passed ? '全部通过' : '存在失败'}`)
process.exit(report.passed ? 0 : 1)
