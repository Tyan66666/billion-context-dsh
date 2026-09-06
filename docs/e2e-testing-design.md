# 设计说明：headless profile 自动化集成测试（acp-e2e）

> 状态：设计稿 v4（已实现待验证）。层 A 落地为 `scripts/e2e/`，层 B（mock LLM）为后续方向。
> v2：容器化运行（Docker）已在本机 OrbStack（linux/arm64）全链路验证通过。
> v3：按评审定案——容器是**唯一**执行方式；权限用 `DSH_PERMISSION_MODE=danger-full-access` 完全开放（已实测）；launcher 只测覆盖线最新版。
> v4：按首测反馈定案——并行分道（多容器，weight 均衡）；默认只跑 smoke 集，全量显式选择；`npm run e2e` / `npm run e2e:full` 双入口。
> 结论先行：**不需要改 `src/`** —— 环境组装、运行、断言全部使用 DSH 原生机制，本插件只作为被安装、被观察的普通包参与。

## 问题

每个 PR 目前的验证流程是手工的：构建 → 把 worktree 以 `file:` 方式装进 web profile → 开一个真实会话跑任务 → 人肉观察 nudge 是否触发、压缩是否落盘、搜索是否命中 → 翻会话日志确认投影没被染成负数。这个流程有三个痛点：

1. **慢**——每个 PR 都要人来开环境、跑会话、盯输出；
2. **不可重复**——同样的场景每次手跑，观察点靠记忆；
3. **容易漏**——issue #54 那类"会话砖化"（投影计数变负 → 后续每个 turn 被 zod 拒绝）在真实长会话里跑了很久才暴露，肉眼几乎不可能第一时间发现。

## 现状与缺口

- 已有 189 个单测覆盖引擎内部算法（CJK 计价、范围求解、孤儿工具清理、影子价、包产物契约等），fixture 按 AGENTS.md rule 5 模拟真实结构。
- 单测覆盖不了的缺口正是"集成"：
  1. **真实宿主接线**——`dsh-session` 事件形状、agent 循环、token-meter/projection 的真实行为（单测用的是 fixture 复制品）；
  2. **真实 provider 消息流**——模型真的会调 `compress` 吗？调用的参数经过真实 schema 校验吗？
  3. **安装即生效契约**——bundle patch 在真实 launcher 组装下是否零配置生效（AGENTS.md 设计决策 8）。

DSH 原生提供了补上这个缺口需要的全部拼图：

| 拼图 | 事实（已在 dsh 0.1.2-rc.1 上验证） |
|---|---|
| 一次性运行器 | `@deepseek-ai/dsh-headless`：`dsh --profile headless "<task>"` 跑一个任务，最终回答打 stdout、推理过程打 stderr，退出码 0=完成 / 1=中止或出错；无端口、无 GUI、进程自清理 |
| profile 即环境 | `~/.dsh/profiles/<名字>/` 就是一个 pnpm 包目录：`dsh.profile.bundles` 声明组合层，`cordis.patch.yml` 是用户覆盖层；`@deepseek-ai/*` bundle 从 launcher 自带的 node_modules 解析，第三方插件装在 profile 目录里 |
| 干净组合 | headless profile 的组合就是 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`，没有任何多余 surface——加上本插件即为"只带我们插件的环境" |
| 隔离 | `DSH_HOME` 指向临时目录即可让会话日志、storage、凭据全部落在一次性目录里，多个场景可并行 |
| 断言面（oracle） | 会话日志是 append-only JSONL（`session.jsonl.zstd`）：`turn/start`、`step/*`、`tool/call`、`tool/result`、`request/context`，以及本插件写入的 `compaction/start` / `compaction/summary` / `compaction/prune` / `compaction/end`——事件即协议，可程序化断言 |

## 方案总览：两层

| | 层 A：headless E2E | 层 B：mock LLM 确定性回放（后续） |
|---|---|---|
| 模型 | 真实模型（API 计费，单场景约几美分） | 本地脚本化 OpenAI 兼容 mock（零成本） |
| 覆盖 | 真实全链路：launcher 组装、bundle patch 生效、真实 provider 流、模型行为 | 确定性回放：脚本规定"模型"每一步做什么，断言可精确到请求体 |
| 确定性 | 引擎侧断言确定；模型行为是软断言 | 完全确定 |
| 时机 | 先做（本文档的主体） | 层 A 验证有效后 |

## 层 A 详细设计

### 环境：一个只带本插件的 profile

runner 在临时 `$DSH_HOME/profiles/acp-e2e/` 下自建 profile（**不**用 `dsh plugin add`，理由见决策 2），内容等价于：

```jsonc
// profiles/acp-e2e/package.json（runner 生成）
{
  "name": "dsh-profile-acp-e2e",
  "private": true,
  "dependencies": {
    "billion-context-dsh": "file:<仓库绝对路径>"   // dist/ 已入库（v0.2.17 起），装上即用
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",        // 最小宿主：llm/session/agent/settings/credentials/持久化
        "@deepseek-ai/dsh-headless",    // 一次性运行器（exit code 契约）
        "billion-context-dsh"           // 唯一的第三方插件
      ]
    }
  }
}
```

- 生成后在该目录跑 `pnpm install`，然后 `dsh --profile acp-e2e "<task>"` 即启动。
- 本插件的 bundle patch（`cordis.patch.yml`）自动成为组合层：禁 `compaction-basic` + 挂 `compaction-acp`，**零手工配置**——这条"安装即生效"契约本身就是被测对象之一。
- 每次运行前 runner 整目录重建（幂等），不依赖机器上任何残留状态。

### 隔离与凭据

- `DSH_HOME=$(mktemp -d)`：会话日志、storage、遥测全部落在一次性目录，场景间互不污染、可并行。
- 凭据走环境继承（credentials 链的第一优先级是进程环境）：CI 里注入 `DEEPSEEK_API_KEY`，本地直接复用现有环境。
- `DSH_TELEMETRY_DISABLED=1` 关闭遥测上传。
- 模型路由：runner 生成 `$DSH_HOME/settings.yaml` 的 `agent-default-model` 段；默认用 launcher 自带路由（deepseek-official / deepseek-v4-flash），`ACP_E2E_PROVIDER` / `ACP_E2E_MODEL` 环境变量可覆盖（想用便宜模型跑常规回归、用目标模型验证特定行为）。

### 触发杠杆：把窗口压小

nudge 普通触发线有下限（`minContextLimitPct` 0.45，`src/index.ts` 配置注释），调阈值不能低于它；正确杠杆是**显式压小窗口**：

```yaml
# runner 通过 launcher 的 --patch 注入（repeatable，作用于 profile 层之后）
- id: compaction-acp
  config:
    modelContextLimit: 8000   # 显式小窗口；显式值优先于自动探测（windowFor 链）
```

45% 线 = 3600 tokens：两三次大工具输出就过线，场景不再需要真实几十万 token 的会话。per-scenario 差异（比如某个场景要验证 emergency 0.85 线）也走 `--patch`，profile 本身保持通用。

### 场景清单

每个场景 = 一次 headless run = 一个独立 session。场景集中定义在 `scripts/e2e/scenarios.mjs`（见「场景定义与断言读点」），fixture（大文件等）由 runner 在场景专用 cwd（临时目录）里物化。

| 场景 | 任务 | 硬断言 | 软断言（报告，不计失败） |
|---|---|---|---|
| S1 压力触发 | 依次完整读取 8 个大 fixture 文件并汇总字数 | exit 0；nudge 过线后出现 `compaction/*` 事件 | 模型真的调了 `compress` |
| S2 压缩后可用性 | S1 的任务延长版：压缩发生后要求模型检索早期内容 | `search_context` 工具调用发生且返回非空；exit 0 | 检索命中被压缩内容 |
| S3 批量鲁棒性 | 任务引导模型连续多次 compress | 每次 `compaction/summary` 的 `shadowedTokenCount ≥ 0`；事件序列配对 | — |
| S4 空会话基线 | 一个极短任务（一次问答） | exit 0；**无**任何 `compaction/*` 事件 | — |

### 断言（oracle = 会话日志）

运行后 `zstd -dc` 解包 `sessions/<workspace>/session-*/session.jsonl.zstd` 逐行断言：

- **硬断言**（失败即场景失败）：
  1. 进程退出码 0，stdout 有非空最终回答；
  2. `compaction/start` … `compaction/end` 严格配对，无悬挂 `start`（对应"悬挂 compaction start 恢复"那类修复的回归哨兵）；
  3. 所有 `compaction/summary` / `compaction/prune` 的 `shadowedTokenCount ≥ 0`；
  4. 全程无 turn error——出现 `Too small: expected number to be >=0` 之类的投影 zod 拒绝 = #54 类回归，立刻红；
  5. 场景专属断言（上表"硬断言"列）。
- **nudge 是否注入**：nudge 在 `agent/pre-step` 注入请求侧，不一定以独立事件落日志；实现时先查 `request/context` 事件是否携带，查不到就把这条断言归入层 B（层 B 直接看请求体）。层 A 不为它加日志事件（决策 4）。
- **解包注意**：日志是**多帧 zstd 拼接**（headless 的 durability barrier 会拆帧；已实测 Node 的 `zstdDecompressSync` 只解出第一帧）——必须用 `zstd` CLI 或逐帧解码。
- **失败分型**：连接错误/限流/模型不可用标记为"环境性失败"（不计入插件回归），断言不符才是真失败。

### 场景定义与断言读点（可读性已验证）

**场景即代码，单一事实源**：所有场景集中定义在 `scripts/e2e/scenarios.mjs`（每个场景一个对象：`id`、`issue`（关联 issue/PR 列表）、`task`（任务文本）、`patch`（可选 --patch 覆盖）、`fixtures()`（物化到场景 cwd 的文件）、`assert(events)`（断言函数）），不另设 md 描述文件——避免"文档说一套、代码跑一套"。基线场景沿用 S1–S4 编号，bug 回归场景用 `S<issue>` 编号（见下节）。

**断言读什么**——日志三种读点（形状已用真实会话日志核实）：

| 读点 | 日志形状 | 能断言什么 |
|---|---|---|
| 事件级 | `{type, seq, data}` | `compaction/*` 序列合法性、`shadowedTokenCount ≥ 0`、`turn/end` 理由、`sandbox/mode` / `approval/policy` 生效值 |
| 工具调用级 | `tool/call` → `data: {callId, name, arguments}`（arguments 为模型原始参数 JSON 字符串） | 模型传了什么参数、什么形态（普通 / wrapped `{arguments}` 信封 / scope=compressed / bN、mN 引用） |
| 工具结果级 | `tool/result` → `data.message.content[].text`（工具返回给模型的**完整原文**） | **acp_status 渲染了什么内容、是否正确**——kernel `buildStatusReport` 的每一行都逐字在日志里 |

**模型是可脚本化的驱动器**：任务文本直接指示模型"调用哪个工具、传什么参数形态"（模型对明确的格式指令执行度很高）。引擎契约类断言是硬的；"模型是否自发做某事"仍是软断言——但"模型被明确指示后是否照做"升级为硬断言，因为它考验的是我们的工具调用链路（schema 校验、信封拆解、引用解析），不是模型自由意志。

### bug 修复的回归表达（S<issue> 场景）

每个 bug 修复落地一个同名场景，文件头元数据钉住三元组：**症状（用户看到什么坏了）→ 修复（哪个 PR 改了什么）→ 断言读点（日志里哪一段证明修好了）**。bug → 测试可追溯，跑 E2E 即"重演一遍当时的病灶"。已知 bug 的映射示例：

| 场景 | 症状（issue） | 场景怎么制造前置条件 | 断言读点 |
|---|---|---|---|
| `S54-shadow-price` | CJK 会话投影变负、每个 turn 被 zod 拒（#54） | CJK 大文件读取场景，`modelContextLimit: 8000` 逼出多次压缩 | 所有 `compaction/summary`/`prune` 的 `shadowedTokenCount ≥ 0`；日志无 `Too small: expected number to be >=0`；`turn/end: completed` |
| `S47-status-all-blocks` | `/acp status` 只显示最老 10 个块（#47/#48） | 任务引导模型压缩 12 段后**调用 acp_status** | tool/result 原文含全部 12 个块行（b1…b12），而非只有前 10 |
| `S60-checkpoint-seqs` | ACTIVE 块缺 `Checkpoint seqs` 行，模型无从蒸馏（#60） | 压缩 1 段后调用 acp_status | tool/result 含 `Checkpoint seqs` 行且 seq 落在日志实际范围内 |
| `S9-envelope` | wrapped `{arguments}` 信封静默丢参（rule 9） | 任务**明确要求**以 `{"arguments":{"scope":"compressed"}}` 形态调用 acp_status | tool/call 的 `arguments` 原文确为包裹形态；tool/result 是 drilldown 报告（有 COMPRESSED BLOCKS 段、无 Nudge 决策行）——直接回归 `unwrapEnvelope` |
| `S35-mn-ref` | drilldown 的 mN 引用压缩失败（#35） | drilldown 后让模型用返回的 mN 边界调 compress | 对应 `compaction/summary` 落盘、surface 收缩 |

**边界**：不能通过正常使用路径触达的深状态 bug（崩溃孤儿清理、legacy 日志自愈——需要在运行中途注入残缺状态），继续由单测钉住（AGENTS.md 已有"每个 fix 必带回归测试"的惯例），E2E 不重复也不强求；上表回归的都是"用户/模型可见的协议面"。


### 运行器与产物

```
scripts/e2e/
├── run.mjs              # 无新依赖的 Node runner：构建镜像→起容器→逐场景跑→断言→报告
├── Dockerfile           # node:22-slim + zstd/git/pnpm10 + 钉版本的 @deepseek-ai/dsh
├── scenarios.mjs        # 场景即代码：id/issue/task/patch/fixtures/assert 单一事实源
└── out/                 # 运行产物（gitignore）：容器内 /out 挂载点、解包日志、报告
```

流程（宿主机要求 Docker + Node）：`run.mjs` 先在**宿主**跑 `npm run build` 保证 dist 是当前源码（容器不能用宿主 node_modules 构建——esbuild 等是平台二进制）→ `docker build` 镜像（有层缓存）→ `docker run` 挂载仓库（`/repo`）与产物目录（`/out`）→ **容器内** `container-main.mjs`：组装临时 home 与 profile（pnpm 安装 file:/repo，装的是刚构建的 dist）→ 逐场景 `dsh --profile acp-e2e` → 解包断言（容器自带 zstd + node）→ 结果 JSON 落 `/out` → 宿主机 runner 汇总报告（场景 / 退出码 / 各断言结果 / compaction 事件计数），任何硬断言失败则退出码非零。本地 `npm run e2e` 一条命令；`.gitignore` 已含 `scripts/e2e/out/`（临时 home、解包日志、凭据 env-file 永不入库）。

凭据注入细节：白名单内的宿主环境变量（`DEEPSEEK_API_KEY`、`AGICTO_API_KEY` 等 + `ACP_E2E_*` 路由描述）自动透传进容器；或写 `scripts/e2e/out/e2e.env` 作 `--env-file`。缺省路由 deepseek-official/deepseek-v4-flash；自定义路由用 `ACP_E2E_PROVIDER` + `ACP_E2E_BASE_URL` + `ACP_E2E_API_KEY_ENV`（settings.yaml 由执行器生成，只含路由信息不含密钥）。

实现状态（v3 同步）：`scripts/e2e/{Dockerfile, run.mjs, scenarios.mjs, container-main.mjs}` 已落地；场景 9 个（S4-baseline、S1-pressure、S2-search-after-compress、S3-batch-compress、S54-shadow-price、S47-status-all-blocks、S60-checkpoint-seqs、S9-envelope-drilldown、S35-mn-ref），每个带 `set`（smoke/full）与 `weight`（实测秒数，用于分道负载均衡）。运行入口：`npm run e2e`（默认 smoke 集：S4/S54/S60，约 1 分钟）、`npm run e2e:full`（全量）、`ACP_E2E_SCENARIOS=...`（显式列表）、`ACP_E2E_CONCURRENCY`（并行道数，默认 3）。

**并行模型（v4）**：场景按 weight 降序轮流发牌均衡分到 N 条"道"，每条道一个独立容器（独立 DSH_HOME、独立产物目录 `out/runs/<时间戳>/lane-N/`），道内串行、道间并行，宿主合并各道报告出汇总表。全量 9 场景墙钟从 ~15 分钟压到 ~4.6 分钟（3 道：259s/267s/274s）。道数默认 3 是 provider 限流与并行收益的折中。

### CI

可选 job（需要 `DEEPSEEK_API_KEY` secret）：手动触发或 nightly，不在每个 PR 上强制（成本与抖动考量）；层 B 成熟后接为每 PR 必跑。容器唯一化之后 CI 侧没有任何额外要求——`ubuntu-latest` 自带 Docker，job 就是"build 镜像 → run → 断言退出码"，key 走 secret 转 `--env-file`。

### 容器化运行（Docker，已验证；唯一执行方式）

E2E **每次都在容器里跑**：launcher、Node、pnpm、zstd 全部钉进镜像，宿主机只需要 Docker 和本仓库，不要求安装 `dsh` CLI。运行时与被测组合一起可复现，也顺带消掉了"宿主机没装 CLI"这一类环境问题。**已在 OrbStack（linux/arm64）实测全链路通过**，验证日期同本文档 v2：

1. 镜像（Node 22 slim + zstd/git/pnpm10 + `npm i -g @deepseek-ai/dsh@0.1.2-rc.1`，钉版本）构建成功；
2. 仓库以 volume 挂进容器，`file:` 安装进 profile（6.7s，`billion-context-dsh 0.2.19`），bundle patch 生效——`--dump-config` 显示 `compaction-acp` 已挂载、`compaction-basic` 已 `disabled: true`；
3. headless 应用可达（`--profile acp-e2e --help` 正常输出）；
4. **真实 LLM 任务跑通**：容器内 `dsh --profile acp-e2e "只回复两个字：正常"` → stdout `正常`、exit 0、会话日志完整（`turn/start … turn/end`）、且请求里可见 `"name":"compress"` 工具与 `acp_status`——插件确实到达了模型请求侧。

镜像配方（实现时落到 `scripts/e2e/Dockerfile`，以下为已验证的等价物）：

```dockerfile
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends zstd ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10
RUN npm i -g @deepseek-ai/dsh@0.1.2-rc.1   # 被测 launcher，钉版本 → 镜像可复现
ENV DSH_TELEMETRY_DISABLED=1
```

运行形态（等价验证命令）：

```sh
docker run --rm \
  --env-file <凭据env文件，用后即删> \
  -v <仓库>:/repo \
  -v <out目录>:/out \
  acp-e2e bash /out/run.sh     # 组装 profile → 逐场景 dsh --profile acp-e2e → 断言
```

容器模式带来的额外好处与注意点：

| | 说明 |
|---|---|
| 凭据注入 | API key 用 `--env-file` 传入（credentials 链第一优先级是进程环境），宿主机凭据文件**不需要**进容器；用最小 settings.yaml（只带 `agent-default-model` + 所需 `llm-pi-ai` provider 段，无密钥）即可点亮路由——实测 agicto 路由容器内可用 |
| 机器级隔离 | 容器内的写入只落在挂载卷（`/out` 产物、`/repo` 只读即可——pnpm `file:` 安装是复制，不写源目录） |
| 层 B 联动 | mock server 与被测进程同容器走 localhost；进阶可以 `--network none` 完全断网跑层 B，密封且零 API 依赖 |
| 实测坑 | ① pnpm 10 移除了 `--no-fund/--no-audit` 旗标；② `node:22-slim` 无 python3——断言脚本统一用 node 写；③ macOS 上 docker buildx 要写 `~/.docker/`，受限环境可用 `DOCKER_CONFIG=<临时目录>` 引开；④ 镜像体积可观（dsh CLI 全量依赖），首次构建几分钟，之后有层缓存 |

容器模式定位为**唯一执行方式**（`npm run e2e` 内部就是一次 `docker run`）：场景与断言代码只有一套，宿主机直跑模式不保留——双入口意味着两套行为差异要维护，而容器内跑的额外成本（首次镜像构建几分钟，之后全是层缓存）是一次性的。

#### 权限与审批：容器内完全开放（已验证）

headless 无人应答审批：`approval=ask` 在没有应答者时**必然 fail closed**（工具调用直接被拒），所以"受限权限 + 默认放行"这个中间态在 headless 结构上不成立。E2E 采用官方内置的环境开关**完全开放**——反正隔离在容器里：

```sh
DSH_PERMISSION_MODE=danger-full-access   # dsh-base 的两个行都读它：
#   sandbox-policy.config.mode  → danger-full-access（文件效果边界全开）
#   approval.config.policy      → never（无审批拦截）
```

容器实测：跑"运行 bash 命令 echo acp-e2e-ok 并告诉我输出"——模型真实执行了 bash、stdout 返回 `acp-e2e-ok`、exit 0，日志里 `permission/preset: danger-full-access`、`sandbox/mode: danger-full-access`、`approval/policy: never` 三个事件与预期完全一致。runner 把这个变量固定写进 `docker run -e`。

## 层 B 详细设计（后续）

- 机制：`$DSH_HOME/settings.yaml` 写一个 `llm-pi-ai` provider 段（`baseURL: http://127.0.0.1:<port>/v1` + `apiKeyEnv` 指向假变量名）——`dsh-llm-pi-ai` 的设计就是"组合决定适配器存在，settings 决定 provider 运行"，无需改组合。
- 本地 mock server 脚本化回放：固定脚本依次返回"大工具输出 → compress 调用 → search_context 调用"，从而**确定性**断言：
  - 请求体里 nudge 文本在压力过线后出现（层 A 做不到的断言）；
  - `compress` 参数（含 wrapped `{ arguments }` 信封形态）经过真实 schema 校验；
  - 同一场景每次运行字节级可比对。
- 局限：mock 与真实 provider 线格式可能漂移——用真实 OpenAI SDK 形状的流式响应、并在层 A 保留真实模型冒烟来对冲。
- 更远的备选：in-process cordis boot 复用 dsh-base patch 进 `npm test`。首选仍是独立进程方案：走真实 launcher，"组装"本身在被测范围里。

## 决策记录

1. **为什么用 headless 而不是 web profile 做自动化**：headless 有进程级契约（stdout=最终回答、exit code=结果）、无端口无 GUI 自清理；web 面向交互，自动化要对付浏览器层。web profile 保留给人肉 exploratory 测试。
2. **为什么 runner 自建 profile 而不用 `dsh plugin add`**：`dsh plugin add` 的 scaffold 模板按 profile 名选取（`PROFILE_TEMPLATES[name]`，已验证），非模板名只能得到 `[dsh-base, <被装包>]`，要补 `@deepseek-ai/dsh-headless` 仍得手改 manifest；且后续 `dsh plugin add` 的 bundles reconcile 行为可能与手改项冲突。自建目录让 runner 对环境有完整所有权、幂等可重建。（备选：临时 home 里用名为 `headless` 的 profile 再 add 插件——同样得到目标组合，但名字歧义、多场景配置不便，弃。）
3. **为什么 oracle 是会话日志**：append-only、格式稳定、`compaction/*` 事件本来就是我们写入的对外协议——测"协议消费方看到的世界"，而不是引擎内部状态。
4. **为什么不改 `src/`**：所有断言消费现有事件与现有配置项；将来若需要更深观测，优先用层 B（请求体直接可见）而不是给引擎加日志事件——测试需求不应该反向污染运行时协议。
5. **为什么压窗口而不是压阈值**：`nudgeMaxContextLimitPct` 有 0.45 下限约束；`modelContextLimit` 显式值本来就优先于自动探测，是现成且合规的杠杆。
6. **为什么容器是唯一执行方式**：把 Node 版本、launcher 版本、pnpm、zstd 全部钉进镜像，运行时与被测组合一起可复现，且宿主机不要求装 `dsh` CLI——环境差异类失败被整体消掉。代价（首次镜像构建几分钟）是一次性的，不值得为它保留双入口。
7. **为什么容器内完全开放权限**：headless 下 `approval=ask` 无应答者必然 fail closed，"受限 + 自动放行"的中间态不存在；`DSH_PERMISSION_MODE=danger-full-access` 是官方开关（同时设 sandbox 与 approval 两个旋钮），且容器本身提供隔离边界——开放只影响容器内的一次性文件系统。
8. **launcher 版本线怎么测**：只测 peer range 覆盖线里的**最新版**（当前即 0.1.2-rc.1，镜像钉住它）；不逐版本回归。只有当用户报告或上游发布引入了新版本兼容性问题时，才针对那个具体版本加测（必要时再建一个钉该版本的镜像变体）。
9. **并行分道 + 默认精简集**：场景彼此独立（各自容器、各自 DSH_HOME），按 weight 降序均衡分道并行，重场景（S47/S3）不再决定总墙钟；日常回归默认只跑 smoke 集（S4/S54/S60——覆盖基线、#54 影子价哨兵、#60 蒸馏入口，约 1 分钟），全量（`npm run e2e:full`）留给发布前或专项排查。首次全量实测的证据支持这个分层：9 场景里 4 个失败全是测试侧问题，且重场景耗时是轻场景的 10 倍以上。

## 风险与开放问题

- **审批/沙箱策略在 headless 下如何表现**：web 会话里有 `permission/preset` / `approval/policy` 事件；headless 无人应答审批，场景任务的工具调用必须落在默认放行范围内。首次实现时确认；若被拦，用 profile patch / 环境变量显式设置放行策略。
- **launcher 版本线**：只测覆盖线最新版（当前 0.1.2-rc.1，镜像钉住；决策 8）。peer range 已覆盖该线（`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.4`，issue #68）；新版本兼容性问题出现时再针对该版本专项加测。
- **模型抖动**：同一场景两次运行的模型行为可能不同——硬断言只钉引擎契约，模型行为一律软断言；环境性失败（网络/限流）单独分型。
- **~~`dsh` CLI 不在 PATH 的环境~~（已消解）**：容器是唯一执行方式（决策 6），镜像自带全部运行时，宿主机只需要 Docker。
- **审批/沙箱在 headless 下如何表现（已解决）**：`approval=ask` 无应答者 fail closed，中间态不存在；runner 固定注入 `DSH_PERMISSION_MODE=danger-full-access`（官方开关，容器内实测通过，见「权限与审批」小节）。
- **凭据与容器**：API key 只经 `--env-file` 进入容器进程环境，宿主机凭据文件不挂载进容器；env-file 用后即删、产物目录 gitignore。CI 中 key 走 secret 注入，不落盘。
