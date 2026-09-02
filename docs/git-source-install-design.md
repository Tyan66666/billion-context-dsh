# 设计说明:git 源安装为什么必须带预构建产物(dist 入库)

> 关联 issue:[#92 git 源安装失败:仓库未提供 dist 预构建产物,且 pnpm 默认拦截构建脚本(allowBuilds)](https://github.com/Tyan66666/billion-context-dsh/issues/92)
> 状态:v0.2.17 起随 dist 入库生效,本文记录决策依据,防止未来被"清理"回去。

## 问题

从 git 源安装(插件商店展示的形式,如 `dsh plugin add github:Tyan66666/billion-context-dsh`)在 pnpm 11 上必然失败,报 `nothing installable: the plugin(s) need a build step (blocked by default, see allowBuilds) or ship no prebuilt artifacts`。而商店条目里该插件的一键安装命令恰恰就是这个 git 形式。

## 根因(三个,叠加)

1. **`dist/` 未入库**——`.gitignore` 排除了 `dist/`,而 `package.json` 的 `main`/`types`/`exports`/`files` 全指向 `dist`。git clone 下来没有任何可运行产物(只有 npm 发布版的 tarball 里才有)。
2. **没有任何 `prepare` 脚本**——pnpm 对 git 依赖只运行 `prepare` 来构建;本仓库只有 `build` 脚本,所以即使放行构建也产不出 `dist`。
3. **pnpm ≥10/11 默认拦截依赖构建脚本**——pnpm 11 用 [`allowBuilds`](https://pnpm.io/settings/build) 替换了旧的 `onlyBuiltDependencies` 系列,依赖的构建脚本默认一律不放行。

## 为什么"让用户手动放行"救不了

- 对 **git 托管包**,`allowBuilds` 的 key 必须是"包名@git+URL#完整 commit hash"的 depPath 形式,按包名的 key(`billion-context-dsh: true`)**不匹配**,而且依赖的 commit 一变 key 就得跟着换([pnpm#12367](https://github.com/pnpm/pnpm/issues/12367)、[pnpm#12294](https://github.com/pnpm/pnpm/pull/12294))。这条路在 pnpm 11 上基本不可用。
- 就算放行,包里没有 `prepare` 脚本,`dist` 也构建不出来(根因 2)。

## 决策:提交 `dist/` 入库,并且保持零构建脚本

**提交 `dist/`**(与 `npm pack` 产物完全一致的一组文件),git 源安装变成纯文件安装:pnpm 拉下来即含可运行的 `dist/`,没有任何构建脚本可拦,`allowBuilds` 机制无从触发。

候选方案的取舍:

| 方案 | 结果 |
|---|---|
| 提交 `dist/`(采用) | 任意 git 形式(`github:#<tag>`、商店条目)开箱即用;不依赖用户配置 |
| GitHub Release 附 tgz、安装指向 tarball URL | 也能开箱即用,但改不了商店里已有的 `github:` 安装命令;手动 git 安装仍失败 |
| 加 `prepare` 脚本 | **适得其反**:pnpm 11 会先拦 `prepare` 再报错,把本来(有 dist 时)能成功的安装搞挂;放行又要维护 commit-hash key |

**配套约束(防止契约被无声破坏):**

- **永远不要给这个包加 `prepare`/`preinstall`/`install`/`postinstall` 脚本**——见上表第三行;`tests/package-artifacts.test.ts` 守护这条契约。
- **CI 在每次构建后校验 `dist/` 与源码一致**(`.github/workflows/ci.yml` 的 "Check committed dist matches the source" 步骤,`git status --porcelain -- dist`)——防止入库产物过期,git 安装装到旧代码。
- **改动 `src/` 的 PR 必须同步重新构建并提交 `dist/`**(CI 会红着提醒);发布 PR 尤其要带最新产物,使 `#<tag>` 安装与对应 npm 版本完全一致。
- 建议用户安装时带 `#<tag>`;不带 ref 则装默认分支的最新构建(可能与最近一次发布有少量滞后)。
