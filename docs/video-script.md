# 项目介绍视频——制作指南与文案大纲

> 目标：为 **billion-context-dsh** 制作一条项目介绍视频（推荐 B 站，3–5 分钟，中文口播 + 真实演示）。
> 本文档 = 工具调查总结 + 分镜文案大纲 + 可录制的演示清单。

## 一、先定三个问题

| 问题 | 建议 |
|---|---|
| 平台 | **B 站**（技术社区，中文，符合你的受众）；可同步 YouTube |
| 时长 | **3–5 分钟**（再长完播率掉；再短讲不清原理） |
| 形式 | **录屏讲解型**（真实演示最有说服力，素材现成）+ 口播 + 字幕 |

## 二、工具调查总结

### 方案 A：录屏讲解型（推荐——你有真实演示素材）

| 环节 | 工具 | 说明 |
|---|---|---|
| 录屏 | **[Recordly](https://github.com/webadderallorg/Recordly)**（开源免费，Mac/Win/Linux） | 录屏 + 编辑一体，**自动缩放、光标润色、样式化背景**——专为演示视频设计，不需要剪辑经验 |
| 或录屏 | OBS（免费） | 最通用，录屏 + 麦克风；需要手动剪辑 |
| 剪辑+字幕+配音 | **剪映（CapCut）**（免费） | 字幕自动识别、内置 TTS 配音、BGM、贴纸——中文创作者首选 |
| 配音 | 剪映 TTS / edge-tts（免费） | 不想真人出声就用 TTS；真人声更有温度 |

### 方案 B：全自动/AI 生成型（适合没有录屏素材时）

- **剪映 + [jianying-editor-skill](https://github.com/luoluoluo22/jianying-editor-skill)**：可从 README 自动生成"安装→演示"教程（HTML/CSS 动画 + TTS + 字幕，`readme_to_tutorial` 流程）。适合快速出"安装教程"类短片，但缺少真实产品说服力。
- **Screen Studio**（Mac 付费）：平滑运镜录屏，适合高质量演示。

### 通用流程（两种方案都适用）

1. **写脚本**（用下面的大纲）→ 2. **收集素材**（录真实会话、截代码/配置图）→ 3. **录制**（Recordly/OBS）→ 4. **剪辑**（剪映：掐头去尾、字幕、BGM）→ 5. **发布**（B 站标题/封面/简介，简介放 GitHub+npm 链接）。

> 新手最容易踩的坑：**先录再写稿**（画面和文案对不上）。正确顺序是"写稿 → 按稿分镜 → 录画面 → 剪辑时对着稿配音/字幕"。

## 三、文案大纲（3–5 分钟口播，约 1000–1300 字）

采用"钩子 → 信任 → 问题 → 理念 → 演示 → 原理 → 价值 → 行动号召"八段结构：

### 第 0 段 · 钩子（0–15s）——先抓住人
**口播**："你的 AI 编程助手聊着聊着，前面的内容就'忘了'——不是它笨，是上下文窗口满了。大多数工具选择把旧对话'摘要压缩'。但今天这个项目走了一条完全不同的路：**压缩这件事，让模型自己决定**。"

**画面**：项目口号动画（Billion-Context：One billion, not one million）+ 一个"上下文满了"的示意（可用 `acp_status` 输出 128000 窗口打满的画面）。

### 第 1 段 · 开场 + 信任（15–25s）
**口播**："我是 XXX（作者），这个项目叫 billion-context-dsh——给 DeepSeek Harness 的主动上下文压缩插件，刚发布 v0.1.0，GitHub 和 npm 都开源了。它的理念来自 ACP 主动上下文压缩（opencode-acp / billion-context-pi 的作者 ranxianglei），我把它移植到了 DeepSeek Harness 上。"

**画面**：GitHub 仓库页、npm 页面。

### 第 2 段 · 问题（25–55s）——讲清"为什么需要"
**口播**："LLM 的上下文窗口是有限的，128K 看着多，聊长项目几下就满。窗口满了怎么办？多数方案是**自动摘要**——用一次额外的 LLM 调用把旧对话压成一份摘要。这有两个问题：第一，每次压缩都花一次模型的调用费；第二，自动摘要**丢细节**——文件路径、错误信息、关键决策，摘要器不知道哪些重要，全给你揉没了。"

**画面**：对比示意图（自动摘要 = 一个黑盒生成摘要；我们 = 模型自己写摘要）。

### 第 3 段 · 理念（55–85s）——本项目核心卖点
**口播**："billion-context-dsh 的核心是：**模型自己决定何时压缩、压缩什么**。我们给模型一个 `compress` 工具——模型觉得哪段历史没用了，就自己写一份高保真摘要替换掉。没有强制、没有二次摘要调用。窗口快满时，系统只会**建议**（nudge）：'上下文用了 52%，你可以考虑压缩已消费的内容——选择权在你。'"

**画面**：nudge 注入消息的真实截图（我们有现成的："Context usage is at 52% ... the choice and timing are yours"）。

### 第 4 段 · 演示（85s–2min）——最出效果的部分
**口播**："看一个真实会话。这个 agent 在通读一个项目，上下文涨到 46%——系统注入建议。它继续读，到 52%……读完一批源码后，它自己决定压缩：调用 compress，把 378 条消息压成一份摘要——注意看输出：`Compressed 1 block, seqs 2282..2282, adjusted to balanced edges`。系统自动把边界平衡到 tool-call 配对点。再看 acp_status：6 个块、上下文从 52% 回收到了 20%。想找回原文？`decompress` 一条命令，被压缩的内容从日志里恢复回来；想搜索？`search_context` 直接在块里找。"

**画面**：真实会话录屏（读文件 → nudge → compress → compaction/start|summary|end → acp_status 20%）——这些我们都有现成素材，重录一遍即可。

### 第 5 段 · 原理（2min–2min30s）——讲深一点，建立专业感
**口播**："原理上，它没有改动 DeepSeek Harness 的架构，而是实现了它的 `CompactionEngine` 接口。压缩不是删消息——DSH 的会话日志是 append-only 的，compress 只是把一段范围的**表面**替换成摘要节点，原文永远留在日志里。所以 decompress 和搜索都能从日志重建，重启也不丢。引用方式也简洁：用表面 seq 当引用，范围边界自动平衡，模型传错格式（带 #callId）也能容错。"

**画面**：架构图 / 事件流示意（compaction/start → summary → user/message replace → end）。

### 第 6 段 · 对比 + 价值（2min30s–2min50s）
**口播**："和传统自动压缩比：它**不花第二次摘要调用**（模型写摘要顺便就用上了）、**保真**（路径/签名/错误原文保留）、**可逆可搜**（decompress / search_context）、**模型驱动**（该压什么模型最清楚）。测试版的一个提醒：项目还在 beta，DeepSeek Harness 也是，生产环境先别上。"

**画面**：对比表（传统 vs 本项目：调用费 / 保真度 / 可逆性 / 谁决定）。

### 第 7 段 · 行动号召 + 致谢（2min50s–3min10s）
**口播**："项目在 GitHub（Tyan66666/billion-context-dsh），npm 装 `npm install billion-context-dsh` 就能试。觉得有意思给个 Star。最后感谢上游——ranxianglei 的 billion-context-pi、acp-kernel、opencode-acp，以及 DeepSeek Harness 团队，这个项目站在他们的肩膀上。"

**画面**：GitHub 仓库页 + Star 按钮特写 + 上游项目链接列表。

## 四、可录制的演示清单（素材准备）

| # | 演示 | 命令/操作 | 素材来源 |
|---|---|---|---|
| 1 | 安装 | `npm install billion-context-dsh` + 组合行 | README |
| 2 | nudge 注入 | 长会话里上下文过 20%（阈值已调小） | 真实 acp 会话 |
| 3 | compress | `compress({ content: [{ startSeq, endSeq, summary }] })` | 真实会话（seqs 2282..2282 那次） |
| 4 | 事务确认 | 观察 `compaction/start → summary → end` | 会话日志 |
| 5 | acp_status | 压缩前后对比（52% → 20%） | 真实输出 |
| 6 | decompress | `decompress({ blockId })` 恢复原文 | 真实输出 |
| 7 | search_context | `search_context({ query })` 命中块内信息 | 真实输出 |

> 录制技巧：录屏前把终端字号调大（36pt+）、深色主题、关掉无关窗口；每个演示先跑一遍确保输出干净；脚本里的台词和画面**逐句对应**，剪映里按台词切画面。

## 五、发布清单（B 站）

- **标题**参考："让 AI 助手聊一年不丢上下文：billion-context-dsh 模型驱动的上下文压缩｜DeepSeek Harness 插件"
- **封面**：项目 slogan + "One billion, not one million" + 上下文回收对比（52%→20%）
- **简介**：GitHub 链接、npm 链接、上游致谢、时间戳目录（0:00 钩子 / 0:25 问题 / 0:55 理念 / 1:25 演示 / 2:00 原理 / 2:50 行动号召）
- **标签**：DeepSeek Harness、上下文压缩、LLM、开源、插件
