# 安装与验证指南

把 billion-context-dsh 装进真实 DSH 部署并验证它工作。以下步骤在本机 profile（`~/.dsh/profiles/web`）上实测过解析机制（组合行包名从 profile 目录向上解析 node_modules）。

## 1. 安装包

### 方式 A：开发迭代（symlink，改代码即生效）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s /Users/yintianan/GitHub/billion-context-dsh ~/.dsh/profiles/web/node_modules/billion-context-dsh
```

依赖说明：`dist/index.js` 内联了 acp-kernel，运行时把四个 seam 包 `@deepseek-ai/dsh-compaction`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 作为**外部依赖**（由 `devDependencies` 提供并同时声明为 `peerDependencies`，`billion-context-dsh/node_modules` 已在解析链上）；`@deepseek-ai/cordis` 同为 peer。这四个 seam 包共享同一个 **peer 范围** `^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.4`，同时覆盖 `0.1.0-rc.x` 与 `0.1.1-rc.x` 两条 rc 线以及 `0.1.2-alpha.x` 线（DSH 0.1.2-alpha.x 及以后）。范围必须写成并集：node-semver 的预发布匹配要求 range 中带与候选相同 `[major, minor, patch]` 元组的比较器，单一 `^0.1.0-rc.6` 匹配不了 `0.1.1-rc.x`（issue #68），也匹配不了 `0.1.2-alpha.x`。四个包一并声明为 peer（而非只声明 `dsh-compaction`），是为了让安装在 pnpm 的集成/封存布局下仍能把它们解析到**宿主自己的副本**，而不是某个与宿主不一致的陈旧嵌套副本。

### 方式 B：打包安装（发布前验证）

```bash
cd /Users/yintianan/GitHub/billion-context-dsh
npm pack                        # 产出 billion-context-dsh-0.2.1.tgz
mkdir -p ~/.dsh/profiles/web/node_modules
npm install --prefix ~/.dsh/profiles/web ./billion-context-dsh-0.2.1.tgz
```

### 方式 C：bundle 安装（v0.2.0+，`dsh plugin` / 商店一键装）——装完即全局生效

包已声明 `dsh.bundle` manifest（`package.json` 的 `dsh.bundle.patch` → 仓库根的
[../cordis.patch.yml](../cordis.patch.yml)）。DSH 的插件机制（`dsh plugin` 命令与
插件商店走同一条路径）安装后会把该补丁**自动挂进 profile 的层栈**，补丁包含两行：

```yaml
- id: compaction-basic   # 禁用 host 自动压缩后端，避免同一 realm 双 provider 冲突
  disabled: true
- insert:                # 把 ACP 引擎挂到 host 平面 = 该 profile 全局生效
    - id: compaction-acp
      name: 'billion-context-dsh'
```

```bash
dsh plugin --profile web add billion-context-dsh
```

装完重启 `dsh`（bundle 层在启动时组合）即生效：四个模型工具、`/acp` 命令、nudge、
窗口自动探测默认全开，**无需手写任何组合行**。需要自定义 `config`（`modelContextLimit`
/ `prompts` / nudge 阈值）时，在 profile 的 `cordis.patch.yml` 里写一个**同 id**
（`compaction-acp`）的行并附 `config:` 即可覆盖 bundle 默认行（见 §2 的例子）。

### 方式 D：git 源安装（`github:` 规格，商店条目展示的形态）

预构建产物 `dist/` 已提交到仓库（与 npm 发布产物一致），所以从 git 源安装是纯文件
安装——pnpm 11 默认拦截依赖构建脚本（`allowBuilds`），但本包 git 安装**零构建脚本**，
不受影响：

```bash
dsh plugin --profile web add github:Tyan66666/billion-context-dsh#v0.2.17
```

建议带 `#<tag>`，拿到与对应 npm 版本完全一致的产物；不带 ref 则装默认分支的最新构建。
只有 clone 仓库自行从源码构建才需要放行构建。为什么必须入库预构建产物、为什么不能加
`prepare` 脚本，见 [git-source-install-design.md](git-source-install-design.md)（issue #92）。

## 2. 组合行

手动挂载的两种范围，按你想要生效的范围选。**方式 C（bundle/商店安装）用户已默认
全局生效，本节是「纯 npm 安装路径」与「自定义 config」的完整参考**——自定义时只需
同 id 行 + `config:`，bundle 已带的行可省略。

### 2a. 全局生效（host 平面，所有模式）——推荐

编辑 `~/.dsh/profiles/web/cordis.patch.yml`（你的 profile 的补丁文件），追加：

```yaml
# ACP 作为全局压缩后端：四个模型工具 + `/acp` 命令 + nudge + ACP 提示词段，
# 对每个模式（standard / code / minimal / cordis / 自定义预设）都生效。
# 通常应禁用 host 的 compaction-basic（同一 realm 内两个后端同时
# provide `ctx.compaction` 会冲突），但注意：dsh 0.1.0-rc.6+ 上 web-app
# bundle 已自带该行的 disabled: true，此处显式禁用是冗余的（无害，保留
# 仅作兼容提醒；若 bundle 默认值跟踪变化，可省略此段）。
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        # 模型的真实上下文窗口！省略（推荐）时会自动从模型 API 探测
        # （agent.ctx.llm.resolveModelInfo），探测失败回退默认 128000；
        # 显式配置则优先且跳过探测。分母配小（如百万窗口模型配 128K）
        # 会让使用率虚高 8 倍、nudge 过频。growth 触发阈值（50000）不随此值变化。
        modelContextLimit: 128000
        # （可选）自定义提示词文案：按槽位覆盖 nudge / 范围表 / system prompt /
        # 工具描述，模板 + 命名占位符，构造期校验（拼写错误启动即抛）。未配置时
        # 用内置默认文案（逐字节不变）。槽位与占位符清单见
        # docs/configurable-prompts-design.md。
        # prompts:
        #   nudge:
        #     normal: '上下文使用率 {pct}%。这是建议而非命令——由你决定是否压缩。'
        #   tools:
        #     acpStatus: '报告 ACP 块账本：压缩块数、回收 token、当前上下文压力。'
```

作用：host 平面注册 `ctx.compaction` + 四个模型工具 + `/acp` 命令 + `agent/pre-step` nudge 监听，所有模式共享一份。

注意：shipped 预设（standard / code / cordis）各自内部仍带着 realm 级 `dsh-compaction-basic` 兜底（shipped 安装不可改），所以这些模式里"自动压力压缩"仍由 basic 兜底，但 ACP 的 `compress` 工具、nudge、提示词段照常可用；minimal 与不带 compaction realm 的预设直接使用 host 的 ACP 引擎。

### 2a-2. 可选：关闭 shipped 模式的系统自动压缩（纯模型驱动）

2a 方案下，shipped 预设（standard / code / cordis）的 realm 里仍挂着一份 `dsh-compaction-basic` 兜底，其 `auto` 默认开启——上下文压力超阈值时会**自动摘要**，与 ACP 的"模型驱动"理念并存但不一致。若你希望某个模式也完全由模型决定压缩时机，可以复制该预设并关闭自动压缩（shipped 安装不可直接编辑，复制是唯一正路；`auto: false` 是 `dsh-compaction-basic` 的原生配置）：

```bash
# 1) 复制 shipped 预设到用户目录（以 standard 为例）
mkdir -p ~/.dsh/.agent-presets/standard-np
cp <deepseek-harness>/apps/cli/config/agent-presets/standard/{agent.cordis.yml,preset.yml} \
   ~/.dsh/.agent-presets/standard-np/
```

```yaml
# 2) 编辑 ~/.dsh/.agent-presets/standard-np/agent.cordis.yml，
#    在 compaction realm 组的 compaction-basic 行下加：
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        auto: false        # 关闭系统自动压力压缩，只保留手动 /compact
```

保存后重启（或新开会话），GUI 里选择新的 `standard-np` 模式即可。该模式不再自动摘要，ACP 的 `compress` / nudge / 提示词段照常工作。已验证：复制 + `auto: false` 后预设可正常挂载（`standingKeyFor` → `mounted OK`）。

- **standard / code**：可直接复制，无冲突。
- **cordis**：含 `tool-cordis` 行（进程全局 inspect provider），复制会与已挂载的 shipped cordis 冲突——除非同时删除该预设里的 `tool-cordis` 行（代价：失去 cordis 的插件开发工具）。要纯模型驱动的 cordis，建议保留 shipped 原版，接受其 realm 兜底，或从 standard 副本开始按需补行。

### 2b. 单模式生效（agent preset 的 `compaction` realm）

放进某个 preset 的 `compaction` isolate realm，并**用本引擎替换该 realm 的 `dsh-compaction-basic`**：先禁用（或删除）realm 内原有的 `dsh-compaction-basic` 行，再插入本引擎——同一 realm 内两个后端同时 provide `ctx.compaction` 会冲突：

```yaml
# 先禁用 realm 内默认后端（或直接删掉这一行）
- id: compaction-basic
  disabled: true

# 再插入本引擎
- id: compaction-acp
  name: 'billion-context-dsh'
  config:
    # 同上：省略时自动探测模型真实窗口，显式配置优先（默认 128000 按 128K 窗口）。
    modelContextLimit: 128000
```

只对该模式生效，不是全局。此时本引擎的 `compactIfNeeded` 成为该 agent 的自动压缩策略（返回 null = 只 nudge 不自动摘要）。

## 3. 重启

组合变更后，若你的 profile 开启了补丁热加载（如 `dsh --profile web` 对 `cordis.patch.yml` 的配置热更新）则立即生效，否则重启 dsh web 进程（你当前的启动方式，如 `pnpm run dev:web` 或 `dsh --profile web`）。重启后打开/新建一个会话。

## 4. 验证清单

| 步骤 | 命令/操作 | 预期 |
|---|---|---|
| 1. 工具注册 | 新会话里要求模型列出可用工具，或观察工具目录 | 出现 `compress`、`decompress`、`search_context`、`acp_status` |
| 2. 状态可用 | 让模型调用 `acp_status`（或带钻取参数 `{"scope":"uncompressed","view":"messages","limit":5}`） | 返回 CONTEXT BREAKDOWN（tool/text/summaries 占可见总量）、压缩块列表、nudge 状态行（不含上下文窗口信息）；钻取模式逐行/逐块列出体积，行 ref 为内核 mN——可直接作为 `compress` 的 `startSeq`/`endSeq`（自动映射为 live surface seq） |
| 3. 压缩闭环 | 在一个较长会话（消息多、上下文超过窗口时），模型按 nudge 或自行调用 `compress({ content: [{ startSeq, endSeq, summary }] })` | 返回 `Compressed N block(s)`；会话上下文明显缩小；`acp_status` 的 COMPRESSED BLOCKS 增加 |
| 4. 可恢复 | 调用 `decompress({ blockId })` | 返回被压缩范围的原文 |
| 5. 可搜索 | 调用 `search_context({ query })` | 命中被压缩块内信息 |
| 6. nudge | 持续对话到出现可压缩堆积。增长路径：某层 pending ≥ 5 万 token 且较上次检测增长 ≥ 2.25 万 token（无百分比下限，中前期就可能触发）；保证线：使用率 ≥ 70%；紧急：≥ 85% | 注入消息提示压缩，带 `seq a..b` 范围表 |
| 7. 持久性 | 重启后同一会话 | `acp_status` 仍能从日志重建块账本（block ledger 来自 `compaction/summary` 事件） |

## 5. 快速自检（不依赖真实模型）

```bash
cd /Users/yintianan/GitHub/billion-context-dsh
npm run typecheck && npm test && npm run build
```

162 个测试覆盖：seam 挂载、窗口探测、CJK 感知 token 估算、消息投影、压缩事务（事件序列 + surface 遮蔽）、日志重建账本、四工具端到端、nudge 注入/去重/紧急绕过、可配置提示词模板与校验、**影子价格宿主词汇端到端**（真实 TokenMeter + SessionProjectionRegistry 复现 issue #54：claim == 宿主 meter 价、投影 messageTokens 非负、/acp compress resolved 边界、prune 宿主定价）、**T2 蒸馏可用性**（issue #60：nudge tier seqs 首尾直接压成 tier-2 块端到端；每次压缩结果都报告 tier——含 tier 1，无静默降级）。

## 6. 回滚

```bash
rm ~/.dsh/profiles/web/node_modules/billion-context-dsh   # 或对应 tarball 安装
# 从 cordis.patch.yml 删除 compaction-acp 插入行；若按 2a 全局方案装的，
# 还要删除对 compaction-basic 的 disabled: true（恢复默认自动压缩）。
# 注意：dsh 0.1.0-rc.6+ 上 bundle 自带该 disabled: true，如未显式添加则无需删除。
# 视热加载/重启策略生效。
```
