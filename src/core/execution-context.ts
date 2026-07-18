import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionLeaseClaim } from "./types.js";

export interface ExecutionAuthorityContext {
  claim: ExecutionLeaseClaim;
  assert(): Promise<void>;
  beginEffect(kind: string): Promise<string>;
  recordEffectChild(invocationId: string, pid: number | null): Promise<void>;
  endEffect(invocationId: string): Promise<void>;
}

const executionAuthority = new AsyncLocalStorage<ExecutionAuthorityContext>();
interface ActiveExecutionEffect {
  invocationId: string;
  tainted: boolean;
}
const activeEffect = new AsyncLocalStorage<ActiveExecutionEffect>();
const checkoutAllocation = new AsyncLocalStorage<boolean>();
const authorityPreflight = new AsyncLocalStorage<boolean>();
const effectQueues = new WeakMap<ExecutionAuthorityContext, Promise<void>>();

export function currentExecutionAuthority(): ExecutionAuthorityContext | undefined {
  return executionAuthority.getStore();
}

export function runWithExecutionAuthority<T>(
  context: ExecutionAuthorityContext,
  operation: () => Promise<T>,
): Promise<T> {
  return executionAuthority.run(context, operation);
}

export function runWithCheckoutAllocationAuthority<T>(operation: () => Promise<T>): Promise<T> {
  return checkoutAllocation.run(true, operation);
}

export function currentCheckoutAllocationAuthority(): boolean {
  return checkoutAllocation.getStore() === true;
}

/** Run read-only authority probes without recursively recording them as effects. */
export function runWithExecutionAuthorityPreflight<T>(operation: () => Promise<T>): Promise<T> {
  return authorityPreflight.run(true, operation);
}

export async function assertCurrentExecutionAuthority(): Promise<void> {
  const context = executionAuthority.getStore();
  if (!context) throw new Error("External execution effect requires an active execution lease");
  await context.assert();
}

export async function waitForCurrentExecutionEffects(): Promise<void> {
  const context = executionAuthority.getStore();
  if (!context || activeEffect.getStore()) return;
  await (effectQueues.get(context) ?? Promise.resolve()).catch(() => undefined);
}

export async function beginCurrentExecutionEffect(kind: string): Promise<string | null> {
  const context = executionAuthority.getStore();
  return context ? context.beginEffect(kind) : null;
}

export async function recordCurrentExecutionEffectChild(
  invocationId: string | null,
  pid: number | null,
): Promise<void> {
  if (invocationId === null) return;
  await executionAuthority.getStore()?.recordEffectChild(invocationId, pid);
}

export async function endCurrentExecutionEffect(invocationId: string | null): Promise<void> {
  if (invocationId === null) return;
  await executionAuthority.getStore()?.endEffect(invocationId);
}

/** Serialize top-level effects for one lease; nested work joins the active effect group. */
export async function withCurrentExecutionEffect<T>(kind: string, operation: () => Promise<T>): Promise<T> {
  const context = executionAuthority.getStore();
  if (!context) return operation();
  if (authorityPreflight.getStore()) {
    await context.assert();
    return operation();
  }
  const nested = activeEffect.getStore();
  if (nested) {
    await context.assert();
    return operation();
  }
  // Complete checkout verification before reserving the serialized effect
  // turn. Verification itself may need Git, so waiting after reservation can
  // deadlock the verifier behind the effect that is waiting for it.
  await context.assert();
  const prior = effectQueues.get(context) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  effectQueues.set(context, prior.then(() => turn, () => turn));
  await prior.catch(() => undefined);
  let invocationId: string | null = null;
  let effect: ActiveExecutionEffect | null = null;
  try {
    invocationId = await context.beginEffect(kind);
    effect = { invocationId, tainted: false };
    return await activeEffect.run(effect, async () => {
      // Check checkout identity after this durable effect owns the serialized
      // turn and immediately before the operation. Verifier Git commands nest
      // into this active group, closing both re-entry deadlocks and TOCTOU gaps.
      await context.assert();
      return operation();
    });
  } finally {
    try {
      if (invocationId !== null && effect?.tainted !== true) await context.endEffect(invocationId);
    } finally {
      release();
    }
  }
}

export async function recordActiveExecutionChild(pid: number | null): Promise<void> {
  const context = executionAuthority.getStore();
  const effect = activeEffect.getStore();
  if (!context || !effect) return;
  try {
    await context.recordEffectChild(effect.invocationId, pid);
  } catch (error) {
    // Never clear a durable effect whose spawned child could not be bound.
    effect.tainted = true;
    throw error;
  }
}
