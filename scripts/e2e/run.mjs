// E2E 宿主机编排（docs/e2e-testing-design.md）。
//
// 宿主机要求：Docker + Node（构建 dist；开发者环境本来就有）。
// 不要求安装 dsh CLI / pnpm / zstd —— 全部在镜像里（容器唯一执行方式，决策 6）。
//
// 并行模型（决策 9）：场景按 weight 降序均衡分到 N 条"道"（lane），
// 每条道一个独立容器（独立 DSH_HOME 与产物目录），道内串行、道间并行。
// N = ACP_E2E_CONCURRENCY（默认 3；兼顾 provider 限流）。
//
// 场景选择（决策 9：日常不必全量）：
//   ACP_E2E_SCENARIOS=S4-baseline,...   显式列表（最高优先级）
//   ACP_E2E_SET=full|all                全量 9 场景（或 npm run e2e:full）
//   缺省                                smoke 集（S4/S54/S60，~1 分钟量级）
//
// 模型凭据（二选一，都不落盘入库）：
//   1. 宿主环境直接 export（白名单内的变量自动透传进容器）
//   2. 写进 scripts/e2e/out/e2e.env（gitignore；KEY=value 每行一条，作 --env-file）
//
// 缺省路由 deepseek-official/deepseek-v4-flash（只需 DEEPSEEK_API_KEY）；
// 自定义路由示例（pi-ai provider，本机当前即此配置）：
//   ACP_E2E_PROVIDER=xiaomi-token-plan-cn ACP_E2E_MODEL=mimo-v2.5 \
//   ACP_E2E_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1 ACP_E2E_API_KEY_ENV=LLM_API_KEY

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenariosForSet, selectScenarios } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(dirname(here))
const outDir = join(here, 'out')
const IMAGE = 'billion-context-dsh-e2e:latest'

const step = (msg) => process.stdout.write(`\n[e2e] ${msg}\n`)

// 透传进容器的宿主环境变量白名单：key 本体 + 路由描述（ACP_E2E_SCENARIOS
// 除外——每条道由宿主显式注入自己的场景列表）。
const ENV_PASSTHROUGH = [
  'DEEPSEEK_API_KEY', 'AGICTO_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY', 'LLM_API_KEY',
  'ACP_E2E_PROVIDER', 'ACP_E2E_MODEL', 'ACP_E2E_BASE_URL', 'ACP_E2E_API',
  'ACP_E2E_API_KEY_ENV', 'ACP_E2E_API_KEY', 'ACP_E2E_TIMEOUT_MS',
]

// 0. preflight：docker daemon 必须可用
const dockerInfo = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' })
if (dockerInfo.status !== 0) {
  console.error('[e2e] Docker daemon 不可用（docker info 失败）。请先启动 Docker/OrbStack。')
  process.exit(2)
}

// 1. 构建被测对象：当前源码 → dist（容器无法用宿主 node_modules 构建：平台二进制不同）
if (process.env.ACP_E2E_NO_BUILD !== '1') {
  step('构建 dist（npm run build）')
  const build = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })
  if (build.status !== 0) {
    console.error('[e2e] npm run build 失败，终止。')
    process.exit(2)
  }
} else if (!existsSync(join(repo, 'dist', 'index.js'))) {
  console.error('[e2e] ACP_E2E_NO_BUILD=1 但 dist/index.js 不存在，终止。')
  process.exit(2)
}

// 2. 构建镜像（层缓存：内容不变时秒级完成）
step(`构建镜像 ${IMAGE}`)
const img = spawnSync('docker', ['build', '-t', IMAGE, here], { stdio: ['ignore', 'ignore', 'inherit'] })
if (img.status !== 0) {
  console.error('[e2e] docker build 失败，终止。')
  process.exit(2)
}

// 3. 解析场景集合与分道
const explicit = process.env.ACP_E2E_SCENARIOS
const scenarios = explicit ? selectScenarios(explicit) : scenariosForSet(process.env.ACP_E2E_SET || 'smoke')
if (scenarios.length === 0) {
  console.error('[e2e] 没有匹配到任何场景。检查 ACP_E2E_SCENARIOS / ACP_E2E_SET。')
  process.exit(2)
}
const concurrency = Math.max(1, Math.min(Number(process.env.ACP_E2E_CONCURRENCY || 3), scenarios.length))
// 按 weight 降序轮流发牌：重场景（S47/S3）均摊到不同道，墙钟时间≈最重的一道
const lanes = Array.from({ length: concurrency }, () => [])
for (const s of [...scenarios].sort((a, b) => (b.weight || 0) - (a.weight || 0))) {
  lanes.sort((a, b) => a.reduce((t, x) => t + (x.weight || 0), 0) - b.reduce((t, x) => t + (x.weight || 0), 0))
  lanes[0].push(s)
}
step(`并行 ${concurrency} 道，共 ${scenarios.length} 个场景：${lanes.map((l, i) => `道${i + 1}[${l.map((s) => s.id).join(',')}]`).join(' ')}`)

// 4. 每条道一个容器，同时启动
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const envFile = process.env.ACP_E2E_ENV_FILE || join(outDir, 'e2e.env')

function runLane(laneIndex, lane) {
  const laneOut = join(outDir, 'runs', runId, `lane-${laneIndex + 1}`)
  mkdirSync(laneOut, { recursive: true })
  const args = [
    'run', '--rm',
    '-e', 'DSH_PERMISSION_MODE=danger-full-access', // 容器内完全开放（headless 下 ask 必然 fail closed）
    '-v', `${repo}:/repo`,
    '-v', `${laneOut}:/out`,
    '-e', `ACP_E2E_SCENARIOS=${lane.map((s) => s.id).join(',')}`,
  ]
  if (existsSync(envFile)) args.push('--env-file', envFile)
  for (const k of ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) args.push('-e', `${k}=${process.env[k]}`)
  }
  args.push(IMAGE, 'bash', '-lc', 'node /repo/scripts/e2e/container-main.mjs')
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => process.stdout.write(`[道${laneIndex + 1}] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`[道${laneIndex + 1}] ${d}`))
    child.on('exit', (code) => resolve({ laneIndex, code, laneOut }))
  })
}

step('执行场景（并行容器内）')
const t0 = Date.now()
const laneResults = await Promise.all(lanes.map((lane, i) => runLane(i, lane)))
const wallSec = Math.round((Date.now() - t0) / 1000)

// 5. 合并各道报告 → 汇总
const merged = []
for (const r of laneResults) {
  const p = join(r.laneOut, 'report.json')
  if (!existsSync(p)) continue
  try { merged.push(...JSON.parse(readFileSync(p, 'utf8')).scenarios) } catch { /* 该道容器在写报告前失败 */ }
}
const missing = scenarios.filter((s) => !merged.some((m) => m.id === s.id))
for (const s of missing) {
  merged.push({ id: s.id, title: s.title, issues: s.issues, exitCode: -1, durationMs: 0,
    summaryCount: 0, pruneCount: 0, passed: false,
    results: [{ name: '容器未产出结果', pass: false, detail: '该道在写报告前失败，向上翻容器输出', soft: false }] })
}
const report = { passed: merged.every((r) => r.passed), wallSec, concurrency, generatedAt: new Date().toISOString(), scenarios: merged }
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))

// 6. 打印表格
process.stdout.write(`\n══════ E2E 报告（并行 ${concurrency} 道，墙钟 ${wallSec}s）══════\n`)
for (const s of report.scenarios) {
  process.stdout.write(`\n${s.passed ? '✓' : '✗'} ${s.id} — ${s.title}` +
    `（exit=${s.exitCode}，${Math.round(s.durationMs / 1000)}s，summary=${s.summaryCount}，prune=${s.pruneCount}）\n`)
  for (const a of s.results) {
    const mark = a.pass ? '✓' : (a.soft ? '～' : '✗')
    const suffix = a.detail ? ` — ${a.detail}` : ''
    process.stdout.write(`   ${mark} ${a.name}${suffix}\n`)
  }
  if (s.issues?.length) process.stdout.write(`   关联 issue: #${s.issues.join(', #')}\n`)
}
const hardFailed = report.scenarios.flatMap((s) => s.results.filter((a) => !a.pass && !a.soft))
process.stdout.write(`\n结论: ${report.passed ? '全部通过' : `失败 ${hardFailed.length} 项硬断言`}（产物: scripts/e2e/runs/${runId}/）\n`)
process.exit(report.passed ? 0 : 1)
