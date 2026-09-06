# 预设设计（Presets Design）— v1

> **修订记录（v1，首次落地，issue #105）：**
> - **P1**：新增 `config.preset`，一句话选择 nudge 的激进程度——`preserve` / `relaxed` / `balanced` / `efficient` / `aggressive` 五档。只填充三个 nudge 阈值，优先级 **显式值 > preset > engine 默认**。
> - **P2**：`balanced` 逐字节等于当前开箱阈值（min 0.45 = 内核默认、max 0.70、emergency 0.85），选它相对今天零变化。
> - **P3**：未知名称在引擎构造期抛错并列出合法值（与自定义提示词模板同一 fail-fast 约定），不静默回退默认。
> - **P4**：`preset` 是**展示字段**——进 env 仅供 `/acp status` 命名当前档位，永不进 `kernelConfigFor`；真正喂给内核的是解析后的三个 pct。
> - **P5**：落在**组合配置层**（安装 / `cordis.patch.yml`），今天即可用；settings.yaml 热加载暴露 `preset` 别名待 #75 Phase 1 落地后跟进。
>
> **范围说明：** 原始需求里的 `growthRatio`（内核已有 `nudge.growthRatio`，可经 `coreOverrides` 调）与 `protectedLastMessages`（≈ 内核 `preserveRecentMessages`）**不是本项目的一等旋钮**，是否采纳为命名键 / UI 项属维护者决策，本次未擅自并入预设（见 §6）。

## 1. 问题（issue #105）

#105「Feature Request: Presets + Custom UI」要求用户能用一个词选择压缩策略，而不是逐个调三个百分比。维护者在 issue 里把范围钉死为**五个预设**（preserve / relaxed / balanced / efficient / aggressive），其余能力归 #75：

- 自定义模式的三个阈值旋钮 → #75 Phase 1（settings.yaml 热加载 + `/acp config` list/set/reset）
- 可编辑提示词 → #75 Phase 2
- 图形化 Web UI → #75 Phase 3（DSH 0.1.2 线已放开 `WEB_SETTINGS_NAMESPACES` 门，剩下的只是我们自己的 client card）

路线图顺序：Phase 1 → 预设（本 issue）→ Phase 3。

## 2. 关键依赖事实（已验证）

- **#75 Phase 1 尚未合入 main。** main = `bb9f2f6`（release v0.2.21），无 `src/settings.ts`；分支 `feat/runtime-settings-75` 有该文件但未合并，且基于 v0.2.20 之前。PR 合并仅人工，无法拉进一个以 main 为基的 PR。
- **因此预设先落在组合配置层**：引擎构造时读 `config.preset`，随 bundle 安装或 `cordis.patch.yml` 的 `config:` 生效，今天就能用。等 #75 把六个标量键接进 settings 命名空间后，再把 `preset` 别名暴露到同一通道是个小跟进（不与 #75 冲突——#75 加的是六个标量键，不是预设别名，两者正交）。

## 3. 五档取值

三列均为上下文窗口的占比（fraction），满足内核不变量 `min ≤ max ≤ emergency`（acp-kernel `validateConfig` 反向即抛）。五档构成单调谱系：越靠下，三个值越小 = 越早提醒压缩。

| `preset` | min | max | emergency | 定位 |
|---|---|---|---|---|
| `preserve` | 0.55 | 0.78 | 0.93 | 尽量保留上下文，接近上限才提醒 |
| `relaxed` | 0.50 | 0.75 | 0.90 | 轻度压缩，比 preserve 稍早 |
| `balanced` | 0.45 | 0.70 | 0.85 | 默认平衡——等于插件开箱阈值（选它不改） |
| `efficient` | 0.40 | 0.60 | 0.78 | 更勤快修剪，偏向低 token 占用 |
| `aggressive` | 0.30 | 0.50 | 0.70 | 精简上下文，更早更频繁 |

`balanced` 之所以等于开箱默认：engine 的 `DEFAULT_CONFIG` 设了 `nudgeMaxContextLimitPct: 0.70` / `nudgeEmergencyThresholdPct: 0.85`（刻意低于宿主 compaction-basic 的 80% 自动压缩线与内核默认的 0.95），而 min 走内核默认 0.45——三者正好对应 balanced 行。这样「balanced」对用户是心智上的零成本锚点。

## 4. 优先级机制与实现位置

优先级：**显式值 > preset > engine 默认**。实现在 `src/index.ts` `resolveAcpConfig`：

```ts
const base = { ...DEFAULT_CONFIG, ...config }
if (base.preset === undefined) return base
const preset = resolvePreset(base.preset)          // 未知名称在此抛错（fail-fast）
return {
  ...base,
  nudgeMinContextLimitPct:     config.nudgeMinContextLimitPct     ?? preset.nudgeMinContextLimitPct,
  nudgeMaxContextLimitPct:     config.nudgeMaxContextLimitPct     ?? preset.nudgeMaxContextLimitPct,
  nudgeEmergencyThresholdPct:  config.nudgeEmergencyThresholdPct  ?? preset.nudgeEmergencyThresholdPct,
}
```

要点：

- **只填没设的**：`config.X ?? preset.X` —— 调用方显式给了就用显式的，没给才落到 preset。所以「preset + 某个阈值」并存时该阈值以显式为准。
- **不碰其他旋钮**：`modelContextLimit` / `autoNudge` / `autoTools` / `autoCommand` / `prompts` / `coreOverrides` 原样透传；`coreOverrides.nudge` 仍最后落地、同名键最高优先（见 v0.2.13 的三层合并）。
- **踩过的坑（回归测试钉住）**：第一版误写成 `base.X ?? preset.X`。因为 `base` 已经把 `DEFAULT_CONFIG` 合进去了（max=0.70、emergency=0.85 非 undefined），`??` 永远命中默认值，preset 被默认遮蔽、完全不生效。必须从**原始入参 `config`**（而非合并后的 `base`）判断显式与否。`tests/presets.test.ts` 的「explicit wins over preset」「partial override keeps the rest」两条即为此而生。

## 5. 展示（display-only）

- `ToolEnvironment`（`src/tools.ts`）新增 `readonly preset?: PresetName`，引擎构造时填 `this.config.preset`。**它不进 `kernelConfigFor`**——真正驱动 nudge 决策的是解析后的三个 pct（经 `kernelConfigFor(env)` 进入 `buildNudge` / 工具路径）。preset 只是让 `/acp status` 能说出「现在跑的是哪一档」。
- `/acp status`（`src/commands.ts` `statusText`）在有 preset 时追加一行：
  `preset: <name> (<label>) [min X% · max Y% · emergency Z%]`
  括号里的三个值读的是**解析后的 env 值**，所以你在 preset 之上做的显式覆盖也会如实显示。

## 6. 明确不做的事（留给 owner）

- **`growthRatio`**：内核 `nudge.growthRatio`（默认 0.05）已存在，今天就能经 `coreOverrides.nudge.growthRatio` 调（v0.2.13 修好了这条通路）。是否提升为一等命名键 / 进预设 / 进 UI——owner 拍板。
- **`protectedLastMessages`**：内核无同名项，最接近的是顶层 `preserveRecentMessages`（+ `preserveRecentTokens`、`protectedTools`）。同样不是一等旋钮，是否采纳由 owner 决定。

这两项都不进预设，避免把一个「五档阈值包」悄悄扩成「一堆杂旋钮包」，也避免替 owner 做架构取舍。

## 7. 验证

- `npm run typecheck` 通过；`npm test` **227 全绿**（新增 13 条 `tests/presets.test.ts`，含 214 条既有回归无回退）；`npm run build` 打包成功（tsup 内联 `src/presets.ts`）。
- 13 条新测试覆盖：内核不变量逐行成立；单调谱系（相邻档三值严格递减）；`PRESET_NAMES` 恰好五键且有序；`balanced == 开箱默认`；`isPresetName` 守卫（大小写 / 空格 / 非串全拒）；`resolvePreset` 命中 + 未知名报错并列合法值；`resolveAcpConfig` 全填 / 显式优先 / 部分覆盖保留其余 / 未知名 fail-fast / 省略 preset 行为逐字节不变；解析值经 `kernelConfigFor` 原样到达内核（`growthRatio` 等无关键保持默认）；端到端——同一 ~61% 用量下 `efficient`（max 0.60）触发过限 nudge 而 `balanced`（max 0.70）保持安静（证明档位真的改变内核决策）。
- 测试小坑：Node 22 下 `assert.throws(fn)` 返回 `undefined`，故断言错误信息改用正则校验器参数（`assert.throws(fn, /…/)`），并以 `.*` 桥接错误消息中引号名与合法值列表之间的分隔符。

## 8. 后续 TODO

- #75 Phase 1 落地后：把 `preset` 别名暴露进 settings 命名空间，`/acp config set preset <tier>` 热切换（与六个标量键同一通道）。
- owner 决策后：视需要把 `growthRatio` / `protectedLastMessages` 提为一等键或纳入预设维度。
