# 安装与验证指南

把 billion-context-dsh 装进真实 DSH 部署并验证它工作。以下步骤在本机 profile（`~/.dsh/profiles/web`）上实测过解析机制（组合行包名从 profile 目录向上解析 node_modules）。

## 1. 安装包

### 方式 A：开发迭代（symlink，改代码即生效）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s /Users/yintianan/GitHub/billion-context-dsh ~/.dsh/profiles/web/node_modules/billion-context-dsh
```

依赖说明：`dist/index.js` 内联了 acp-kernel，运行时只外链 `@deepseek-ai/dsh-compaction` 与 `@deepseek-ai/cordis`，二者由项目 `devDependencies` 提供（`billion-context-dsh/node_modules` 已在解析链上）。

### 方式 B：打包安装（发布前验证）

```bash
cd /Users/yintianan/GitHub/billion-context-dsh
npm pack                        # 产出 billion-context-dsh-0.0.0.tgz
mkdir -p ~/.dsh/profiles/web/node_modules
npm install --prefix ~/.dsh/profiles/web ./billion-context-dsh-0.0.0.tgz
```

## 2. 组合行

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: compaction-acp
      name: 'billion-context-dsh'
      config:
        modelContextLimit: 128000
```

作用：host 平面注册 `ctx.compaction` + 四个模型工具 + `/acp` 命令 + `agent/pre-step` nudge 监听。

> 生产替换 `compaction-basic` 时，不要放 host 平面，而是放进 agent preset 的 `compaction` isolate realm（见 README 的组合示例）——那时本引擎的 `compactIfNeeded` 才成为该 agent 的自动压缩策略（返回 null = 只 nudge 不自动摘要）。

## 3. 重启

组合变更需要重启 dsh web 进程（你当前的启动方式，如 `pnpm run dev:web` 或 `dsh --profile web`）。重启后打开/新建一个会话。

## 4. 验证清单

| 步骤 | 命令/操作 | 预期 |
|---|---|---|
| 1. 工具注册 | 新会话里要求模型列出可用工具，或观察工具目录 | 出现 `compress`、`decompress`、`search_context`、`acp_status` |
| 2. 状态可用 | 让模型调用 `acp_status` | 返回块数、压缩 token、估计上下文占用 |
| 3. 压缩闭环 | 在一个较长会话（消息多、上下文超过窗口时），模型按 nudge 或自行调用 `compress({ content: [{ startSeq, endSeq, summary }] })` | 返回 `Compressed N block(s)`；会话上下文明显缩小；`acp_status` 的 blocks 增加 |
| 4. 可恢复 | 调用 `decompress({ blockId })` | 返回被压缩范围的原文 |
| 5. 可搜索 | 调用 `search_context({ query })` | 命中被压缩块内信息 |
| 6. nudge | 持续对话直到上下文使用率进入 45%–75%（或超 95% 紧急） | 注入消息提示压缩，带 `seq a..b` 范围表 |
| 7. 持久性 | 重启后同一会话 | `acp_status` 仍能从日志重建块账本（block ledger 来自 `compaction/summary` 事件） |

## 5. 快速自检（不依赖真实模型）

```bash
cd /Users/yintianan/GitHub/billion-context-dsh
npm run typecheck && npm test && npm run build
```

20 个测试覆盖：seam 挂载、消息投影、压缩事务（事件序列 + surface 遮蔽）、日志重建账本、四工具端到端、nudge 注入/去重/紧急绕过。

## 6. 回滚

```bash
rm ~/.dsh/profiles/web/node_modules/billion-context-dsh   # 或对应 tarball 安装
# 从 cordis.patch.yml 删除 compaction-acp 行，重启
```
