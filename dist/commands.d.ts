/**
 * M4 — the `/acp` slash command: a human-friendly window into the same
 * machinery the model tools expose (status, one-shot compress, decompress).
 * @module billion-context-dsh/commands
 */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { type ToolEnvironment } from './tools.ts';
/** Register the /acp command (idempotent per engine). */
export declare function acpCommand(env: ToolEnvironment): CommandDefinition;
