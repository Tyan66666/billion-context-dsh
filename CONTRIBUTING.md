# Contributing — billion-context-dsh

> 完整开发规范见 [AGENTS.md](AGENTS.md)（最高优先级）。本文只讲协作流程。

## 开发准备

```bash
npm install
npm run typecheck   # 严格 TS 检查
npm test            # 单元测试（node --import tsx --test）
npm run build       # tsup 打包
```

- 不用 `as any` / `@ts-ignore`，测试用 ESM 静态导入。
- **每个 bug 修复都要带回归测试**（AGENTS.md §4）。
- `acp-kernel` 升级走 AGENTS.md §4b 的手动 SOP，不要自行改版本号。

## 提交规范（Commit Convention）

主分支只接受 **squash 合并**：合并进 main 的提交信息 = **PR 标题**，必须符合下面的格式。
**PR 内部的提交不做任何约束**（你们自己定），最终 squash 时以 PR 标题为准。

| 类型 | 格式 | 用途 |
|---|---|---|
| 功能 | `(feat) <summary>` | 新功能（如 `(feat) tier-2/3 block distillation — …`） |
| 修复 | `(fix) <summary>` | bug 修复 |
| 重构 | `(refactor) <summary>` | 内部结构调整，不改行为 |
| 测试 | `(test) <summary>` | 只改测试 |
| 工具 | `(chore) <summary>` | CI / 依赖 / 脚本等流程性改动 |
| 文档 | `docs: <summary>` | 只改 README / docs/ / AGENTS.md |
| 发布 | `release vX.Y.Z` | 发布提交（严格按 AGENTS.md §5） |

`<summary>` 用一句话描述，信息要有用，结尾不带句号。

PR 标题由 CI 强制校验（`.github/workflows/pr-lint.yml`，规则在 `scripts/check-pr-title.mjs`），
标题不合格 PR 无法合并。

## 提 PR 的流程

1. 从 `main` 切一个分支（`git switch -c <your-branch> main`）。
2. 在分支里提交（内部随便怎么写）。
3. 打开 PR，**标题**按上面的规范写——它会成为合并到 main 的提交信息。
4. CI 必须全绿：`ci`（typecheck + test + build）+ `pr-title`（标题校验），这是合并前置条件。
5. 合并由**人工**执行。AGENTS.md §5：PR 合并永远由人来点，Agent 禁止合并任何 PR。

## 主分支保护（已启用）

`main` 已启用分支保护：

- 禁止直接 push，只能通过 PR 合并；
- 要求 PR 通过 CI（`ci`）与标题校验（`pr-title`）两个状态检查；
- 禁止 force push、禁止删除分支；
- 不要求 reviewer 批准（单人维护时作者无法批准自己的 PR）。

## 发布流程

见 AGENTS.md §5：`npm version` 升版本 → 同步文档版本号 → `npm publish` → `release vX.Y.Z` 提交 → `gh release create` → Pages 自动重建。
