/**
 * Registry of task-type → agent handler. The orchestrator will only claim a task whose type is registered here; every other
 * task type stays 'queued' indefinitely and is reported by the API as `agentAvailable: false` — never silently skipped,
 * never fabricated as having run. See docs/RESEARCH-STUDIO-PLAN.md for which types are (and are not) implemented in M1.
 */
import { AgentHandler } from './types';

const registry = new Map<string, AgentHandler>();
export function registerAgent(type: string, handler: AgentHandler): void { registry.set(type, handler); }
export function runnableTypes(): string[] { return [...registry.keys()]; }
export function handlerFor(type: string): AgentHandler | undefined { return registry.get(type); }
/** Test helper. */
export function clearRegistry(): void { registry.clear(); }
