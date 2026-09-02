/**
 * Minimal Blue frontend identity for marketplace discovery and compatibility
 * admission. ACP keeps its existing Harness command and model tools; this
 * entry deliberately contributes no Blue-specific UI or session access.
 * @module billion-context-dsh/blue
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BluePluginHost } from '@dsh-blue/blue-api';
type BlueContext = Context & {
    readonly bluePluginHost: BluePluginHost;
};
export declare const name = "billion-context-dsh-blue";
export declare const inject: string[];
export declare function apply(ctx: BlueContext): void;
export {};
