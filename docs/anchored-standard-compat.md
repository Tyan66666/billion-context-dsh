# 与 dsh-anchored-standard 的兼容配置

[dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 是一个两阶段启动的 DSH 预设：启动阶段只暴露 2 个工具（bash + str_replace_editor）以锚定模型的聚焦型推理，常驻阶段再逐步解锁更多工具。

billion-context-dsh（ACP）可以与它配合使用，只需在 anchored-standard 的配置中把 ACP 工具加入 `compactionTools`。

## 为什么需要这个配置

anchored-standard 会按白名单过滤工具：

| 阶段 | 默认可见工具 |
|------|------------|
| 启动阶段 | bash, str_replace_editor |
| 常驻阶段 | 上述 + dev_tool_search, skill_search, skill_load + 模型主动解锁的 |
| 压缩恢复 | 上述 + compactionTools |

ACP 的 4 个工具（compress, decompress, search_context, acp_status）不在默认白名单中。加入 `compactionTools` 后，它们只在**压缩恢复阶段**自动可用——不影响启动阶段的锚定效果。

## 配置方法

编辑 anchored-standard 的 `agent.cordis.yml`，找到 `tool-bootstrap` 行，添加 `compactionTools`：

```yaml
- id: tool-bootstrap
  source: ./tool-bootstrap.mjs
  config:
    bootstrapTools: [bash, str_replace_editor]
    compactionTools: [compress, decompress, search_context, acp_status]  # ← 添加这行
    promoteOn: either
```

## 工作流程

```
启动阶段（2 个工具，聚焦推理）
    │
    ▼  上下文压力大 → nudge 通过 system prompt 提醒模型
    │
    ▼  触发 compaction → 进入压缩恢复阶段
    │
    ▼  compactionTools 生效 → ACP 工具可用 ✅
    │
    ▼  模型用 compress 压缩 → 产生新 promotion signal
    │
    ▼  回到常驻阶段 → ACP 工具隐藏，推理风格不受影响
```

## 不装 anchored-standard 的情况

如果不装 dsh-anchored-standard，这个配置项会被忽略，ACP 的行为与现在完全一致——4 个工具始终可用。

## 推荐的 ACP 配置

与 anchored-standard 配合时，建议关闭 ACP 的自动 nudge（由 system prompt 中的 ACP 指导替代），避免 nudge 消息被 anchored-standard 的上下文过滤器剥离：

```yaml
# 在你的 DSH composition 中
- id: acp-billion-context
  name: 'billion-context-dsh'
  config:
    autoNudge: false          # 关闭自动 nudge
    nudgeMaxContextLimitPct: 0.7
    nudgeEmergencyThresholdPct: 0.85
```

这样 nudge 逻辑仍然通过 system prompt 中的 ACP 指导生效，但不会产生额外的 `agent/pre-step` 消息被过滤。
