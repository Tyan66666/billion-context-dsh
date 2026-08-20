# Autonomous Memory Implementations — Cross-Product Research

> **Purpose**: Research for the billion-context-dsh project (Active Context Pruning engine for DSH).  
> **Core question**: How do products/plugins implement "autonomous memory saving" at the product/plugin layer?  
> **Covers**: save timing, memory tool description wording, retrieval format, session boundary handling.

---

## 1. Claude Code Auto Memory

**URL**: [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | Source: `extractMemories.ts`, `prompts.ts` ([claude-code-analysis](https://github.com/liuup/claude-code-analysis))

### Save Timing
- **Trigger**: End of each complete query loop — when the model produces a final response with no more tool calls, via `handleStopHooks` in `stopHooks.ts`
- **Implementation**: `runForkedAgent` — a perfect fork of the main conversation sharing the parent's prompt cache (no re-computation)
- **Mutual exclusion**: if the main agent already wrote memories this turn, extraction skips entirely
- **7-layer memory architecture**: CLAUDE.md (human) → Auto Memory (AI-written) → Background Extract → Session Memory → Agent Memory → Relevant Memories → Auto Dream (idle-time consolidation)

### Memory Tool / System Prompt
- **Tools allowed in extraction fork**: FileRead, Grep, Glob, read-only Bash, FileEdit/FileWrite ONLY for auto-memory directory paths; `Bash rm` is denied
- **Storage path**: `~/.claude/projects/<sanitized-git-root>/memory/`
- **Taxonomy** (closed, 4 types): `user` (role/preferences), `feedback` (corrections/confirmations), `project` (context/decisions), `reference` (pointers to external systems)
- **What NOT to save** (explicit negative prompt): code patterns, git history, debugging plans, content already in CLAUDE.md, temporary task status
- **Key design**: even when the user explicitly asks to save something, the AI should ask "what about it was surprising or non-obvious?" — the non-obvious part is what's worth keeping

### Retrieval Format
- Each memory in its own `.md` file with frontmatter, indexed in `MEMORY.md` (≤200 lines, ≤25KB)
- `MEMORY.md` injected into context at session start (traditional path) or replaced by Relevant Memories prefetch (new path with feature gate `tengu_moth_copse`)

### Session Boundary Handling
- Auto memory is **cross-session** — persists across all sessions for the same repository
- Session memory (layer 4) is single-session, stored at `~/.claude/projects/<slug>/<sessionId>/session-memory/summary.md`
- All worktrees of the same repo share the same memory directory (via `findCanonicalGitRoot()`)

### Insights
- **Prompt-code co-design**: code guarantees directory existence (`ensureMemoryDirExists`), prompt tells AI "directory already exists — write directly" to avoid wasted `ls`/`mkdir -p` turns
- **Background extraction is fire-and-forget** from the stop hook; closure-scoped state with mutex + trailing-run pattern for overlapping triggers
- **Team memory** syncs via HTTP endpoints with secret scanning (pre-write and push-time), with a `pushSuppressedReason` gate to prevent infinite retry on auth failure

---

## 2. Cline Memory Bank

**URL**: [github.com/cline/prompts/.clinerules/memory-bank.md](https://github.com/cline/prompts/blob/main/.clinerules/memory-bank.md)

### Save Timing
- When discovering new patterns
- After significant changes
- When the user says "update memory bank"
- When context needs clarification

### Structure — 6 Core Files
| File | Purpose |
|---|---|
| `projectBrief.md` | Foundation — project overview |
| `productContext.md` | Why the project exists, problems it solves |
| `activeContext.md` | Current work focus, recent changes, next steps |
| `systemPatterns.md` | Architecture, key technical decisions, design patterns |
| `techContext.md` | Technologies, dev setup, constraints |
| `progress.md` | What works, what's left, known issues |

### Key Design Principle
> "My memory resets completely between sessions. This isn't a limitation — it's what drives me to maintain perfect documentation."

- ALL files must be read at start of EVERY task (mandatory)
- Files build on each other in a hierarchy: `projectBrief` → others → `activeContext` → `progress`

### Session Boundary Handling
- Explicit "amnesia model" — memory resets between sessions by design
- The entire memory bank IS the memory; no implicit recall mechanism

### Insights
- **Radical transparency** about memory limitations drives better documentation
- Fixed 6-file structure makes memory predictable but rigid
- No automatic save — entirely prompted by rules text in the system context

---

## 3. mem0 / OpenMemory

**URL**: [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) | Config: `configs/prompts.py` (1062 lines)

### Save Timing
- **Two-phase pipeline**, application-level (NOT model tool-calling):
  1. **Phase 1 — Fact Extraction**: `FACT_RETRIEVAL_PROMPT` / `USER_MEMORY_EXTRACTION_PROMPT` extracts facts as JSON `{"facts": [...]}`
  2. **Phase 2 — Update Decision**: `DEFAULT_UPDATE_MEMORY_PROMPT` decides ADD/UPDATE/DELETE/NONE for each fact vs existing memory
- LLM is called separately by the application to extract/update — the model doesn't call memory tools

### Tool Description / Prompts
- **Fact extraction categories**: personal preferences, personal details, plans/intentions, activity preferences, health/wellness, professional details, miscellaneous
- **Update prompt**: smart memory manager with 4 operations (ADD/UPDATE/DELETE/NONE); includes detailed few-shot examples for each operation including ID management
- Separate prompts for user facts vs agent facts (`AGENT_MEMORY_EXTRACTION_PROMPT`)
- `PROCEDURAL_MEMORY_SYSTEM_PROMPT`: comprehensive agent execution history summarization with verbatim output preservation

### Retrieval Format
- Memories stored as structured entries with IDs
- Retrieval via semantic search returning matching memory entries

### Session Boundary Handling
- Extraction happens at application layer, not tied to session lifecycle
- Can run asynchronously after session ends

### Insights
- **Decoupled extraction**: the model doesn't need to decide when to save — the application extracts after every interaction
- **Structured update operations** (ADD/UPDATE/DELETE with ID management) give fine-grained control
- **Few-shot examples** in the update prompt are critical for consistent behavior

---

## 4. Letta / MemGPT

**URL**: [docs.letta.com](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/) | [github.com/letta-ai/letta](https://github.com/letta-ai/letta)

### Save Timing
- **Agent-driven**: the model decides when to save based on conversation content
- Model explicitly calls tools to update memory blocks

### Memory Tools
| Tool | Purpose |
|---|---|
| `core_memory_append` | Add to in-context core memory |
| `core_memory_replace` | Update in-context core memory |
| `archival_memory_insert` | Store in archival (long-term) memory |
| `archival_memory_search` | Search archival memory semantically |

### Three Memory Types
| Type | Lifecycle | Visibility |
|---|---|---|
| **Core Memory** | In-context, always visible | Typed sections in the context window |
| **Archival Memory** | Semantically searchable long-term | Retrieved on demand |
| **File-based** | Read on demand | External files |

### Architecture
- Memory blocks are typed sections in the context window
- The model explicitly decides when to call `core_memory_append`/`core_memory_replace` vs `archival_memory_insert`
- Context hierarchy: Core Memory is always in the prompt; Archival Memory requires search

### Session Boundary Handling
- Core Memory persists across sessions (it's the in-context state)
- Archival Memory is permanent store, searched on demand
- The "sleep-time" concept: background consolidation of memories

### Insights
- **Explicit tool-calling for memory** gives the model full control but requires it to "remember to remember"
- **Core vs Archival split** mirrors human working memory vs long-term memory
- **Sleep-time processing** for consolidation is a key pattern for background memory management

---

## 5. LangMem / LangGraph Memory

**URL**: [github.com/langchain-ai/langmem](https://github.com/langchain-ai/langmem) | Source: `src/langmem/knowledge/tools.py` (530 lines)

### Save Timing
- Agent-driven via tool calls, with explicit prompt guidance

### Memory Tools

**`create_manage_memory_tool()`** — creates a tool with actions create/update/delete:
```
Default instructions: "Proactively call this tool when you:
1. Identify a new USER preference.
2. Receive an explicit USER request to remember.
3. Are working and want to record important context.
4. Identify that an existing MEMORY is incorrect or outdated."
```

- Tool signature: `manage_memory(content, action, id)` — `content` for new/updated, `id` for update/delete
- Configurable instructions parameter for custom guidance

**`create_search_memory_tool()`** — semantic search via LangGraph `BaseStore`:
```
Description: "Search your long-term memories for information relevant to your current context."
Signature: search_memory(query, limit=10, offset=0, filter=None)
```

### Retrieval Format
- Memories stored in namespaced `BaseStore` with `{langgraph_user_id}` runtime substitution
- Injected into system prompt via `<memories>` block
- Schema customization supported via Pydantic models

### Session Boundary Handling
- Memories persist in the `BaseStore` across sessions
- Namespacing by user ID ensures isolation
- Integrates with `create_react_agent` pattern

### Insights
- **Proactive instruction** ("proactively call when...") is the key wording pattern — it tells the model WHEN to save, not just HOW
- **Namespace-based isolation** is clean and extensible
- **`<memories>` block injection** into system prompt is a standard retrieval pattern

---

## 6. DSH Ecosystem Memory Plugins

### 6a. dsh-memento

**URL**: [github.com/PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento)

**Save Timing**:
- `memory` tool with Save/Skip guidance in the tool description
- Approval gate: `writePolicy` ask/auto/off; ALL writes forced through approval waterfall
- Proposals: auto-capture after successful compaction; max 8 pending, 2000 chars each

**Memory Tool**:
- `memory` tool: add/replace/remove/consolidate/query
- `memory_recall` tool: bounded memory matches + recent session-history matches

**Architecture**:
- Typed `ctx.memory` seam + SQLite provider + frozen snapshot in system prompt
- Two tracks (user/agent) × two layers (user-global/workspace) × per-agent key
- Hard per-track/per-layer character budgets (default user 2000 / agent 4000 chars)
- Frozen snapshot at session start, never changes mid-session

**Storage**: SQLite WAL, 0600 permissions, zero network

**Protocol**: dsh-memory-protocol v1: entry spec, write semantics (idempotent unique-substring), audit contract, budget model

### 6b. dsh-memory

**URL**: [github.com/Jesse-njx/dsh-memory](https://github.com/Jesse-njx/dsh-memory)

**Key Idea**: "summaries are an index into ground truth, never the truth"

**Save Timing**:
- Background distillation pass extracts durable facts into small markdown files
- Every memory carries citation `(sessionId, [start..end])` pointing at exact log events

**Tools**: `memory_read(name)` full memory, `memory_expand(name)` cited original log excerpt

**Retrieval Format**: One markdown file per memory with JSON header comment (name, description, type, citations, createdAt, updatedAt, rev)

**Types**: user (cross-project), project (facts about project), feedback (corrections)

### 6c. dsh-mem

**URL**: [github.com/Jelee0145/dsh-mem](https://github.com/Jelee0145/dsh-mem)

**Architecture**: Capability seam: Service Definition + Service Provider + Consumer

**Tools**: `memory_save`, `memory_recall`, `memory_forget`, `memory_list`

**Storage**: `$DSH_HOME/memory/memory.json` atomic JSON-file persistence

**Search**: Case-insensitive substring search on content + exact tag match

### 6d. dsh-memory-evolve

**URL**: [github.com/csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve)

**Save Timing**:
- Auto-records progress each turn end
- Key memories require user confirmation before saving

**Five-track memory**: user profile, global facts, project key memories (with git branch awareness), project log/daily log

**Features**: Emotion feedback recording, cross-device sync via git branches, self-review loop option

---

## 7. MemOS

**URL**: [github.com/MemTensor/MemOS](https://github.com/MemTensor/MemOS)

**Save Timing**: Auto-recall before task + retain after successful turn (DSH plugin integration)

**Architecture**: Memory Operating System — unified store/retrieve/manage API

**Capabilities**:
- Multi-modal memory: text, images, tool traces, personas
- Multi-cube knowledge base management
- Async ingestion via MemScheduler
- Memory feedback & correction with natural language

**Benchmarks**: LoCoMo 88.83, LongMemEval 89.20

---

## 8. Basic Memory

**URL**: [basicmemory.com](https://basicmemory.com) | [github.com/basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory)

**Architecture**: MCP-based knowledge graph

**Key Concept**: Bridge between Claude's working memory and durable knowledge graph

**Persistence**: Decisions, architecture, project context carry over across sessions

---

## Summary: Engineering Patterns for Autonomous Memory

### Pattern 1: Save Timing Taxonomy

| Strategy | Products | Trade-off |
|---|---|---|
| **End-of-turn hook** | Claude Code, dsh-memory-evolve | Reliable but may miss in-flight insights |
| **Agent-driven tool call** | Letta, LangMem, dsh-memento | Flexible but model may forget to save |
| **Application-level extraction** | mem0 | Decoupled from model but requires separate LLM call |
| **Manual prompt-triggered** | Cline | Simple but relies on user/system prompt |
| **Background distillation** | dsh-memory | Non-blocking but citation chain needed |

### Pattern 2: Memory Tool Description Wording

The most effective tool descriptions use **proactive instruction** with **concrete triggers**:

| Product | Wording Pattern |
|---|---|
| **LangMem** | "Proactively call this tool when you: 1. Identify a new USER preference. 2. Receive an explicit USER request to remember. 3. Are working and want to record important context. 4. Identify that an existing MEMORY is incorrect or outdated." |
| **Claude Code** | "What NOT to save" is as important as what to save — explicit negative taxonomy prevents memory bloat |
| **Letta** | Implicit — model learns from core_memory_append/replace tool descriptions |
| **mem0** | N/A — extraction is application-level, not model tool-calling |

**Best practice**: Combine positive triggers (WHEN to save) with negative constraints (what NOT to save). The "what not to save" guidance is undersupplied in most implementations.

### Pattern 3: Retrieval Format

| Format | Products | Use Case |
|---|---|---|
| **Markdown files with frontmatter** | Claude Code, dsh-memory, Cline | Human-readable, git-friendly |
| **Structured JSON/SQLite** | mem0, dsh-mem, dsh-memento | Queryable, atomic operations |
| **Semantic vector store** | Letta (archival), LangMem, MemOS | Natural language retrieval |
| **In-context blocks** | Letta (core), LangMem (`<memories>`) | Always-visible, token-expensive |

**Hybrid trend**: Small always-visible core (like Letta's Core Memory or dsh-memento's frozen snapshot) + searchable long-term store.

### Pattern 4: Session Boundary Handling

| Strategy | Products | Key Insight |
|---|---|---|
| **Shared across worktrees** | Claude Code | `findCanonicalGitRoot()` ensures one memory per repo |
| **Amnesia by design** | Cline | Forces perfect documentation as compensation |
| **Citation to log** | dsh-memory | "Summaries are an index into ground truth" |
| **Frozen snapshot** | dsh-memento | Snapshot at start, never changes mid-session |
| **Namespace isolation** | LangMem | `{langgraph_user_id}` substitution |

### Pattern 5: Memory Consolidation

| Strategy | Products | Trigger |
|---|---|---|
| **Auto Dream** | Claude Code | Session idle time |
| **Sleep-time processing** | Letta | Background agent |
| **Self-review loop** | dsh-memory-evolve | Configurable interval |
| **Consolidation tool** | dsh-memento | Model-initiated |

### Key Takeaways for billion-context-dsh (ACP Engine)

1. **Save timing matters most**: the end-of-turn hook (Claude Code pattern) is the most reliable for automatic capture; agent-driven tool calls (Letta/LangMem) give flexibility but risk the model "forgetting to remember."

2. **Negative constraints are undersupplied**: most implementations focus on WHEN to save; Claude Code's "what NOT to save" taxonomy is a standout pattern that prevents memory bloat.

3. **Hybrid retrieval wins**: small in-context summary (frozen snapshot or `<memories>` block) + searchable long-term store is the emerging standard.

4. **Citation chains add trust**: dsh-memory's "summaries are an index into ground truth" pattern — every memory pointing at exact log events — is valuable for debugging and verification.

5. **Memory budgets prevent bloat**: dsh-memento's hard per-track/per-layer character budgets (2000/4000 chars) and Claude Code's MEMORY.md limits (200 lines / 25KB) are critical guardrails.

6. **Application-level extraction** (mem0 pattern) decouples memory from model behavior but costs an extra LLM call; **model-driven extraction** (Claude Code/Letta) is cheaper but relies on prompt engineering.

---

*Research compiled for billion-context-dsh (Active Context Pruning engine for DSH). All URLs verified from source code fetches and search results.*
