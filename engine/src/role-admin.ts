// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Role and permission-overwrite bit math — no discord.js client calls, unit-testable.
 *
 * Backs discord_create_role, discord_edit_role and discord_set_channel_permission.
 * discord-client.ts owns the actual Discord API calls; everything here is pure
 * arithmetic on Discord permission bitfields, plus the two guardrails that keep
 * those tools from doing more than they were built to do:
 *
 *   1. Mutations are House of Solance only — the bot also sits in other
 *      people's servers, and must never edit them (assertHosMutation).
 *   2. Administrator is never grantable through these tools — that stays
 *      The owner's, by hand (assertNoAdministratorGrant).
 */

import { identity } from './config/identity.js';
import { PermissionFlagsBits } from 'discord.js';
import { HOS_SERVER_ID } from './presence-engine.js';

// PermissionFlagsBits is a plain { name: bigint } map of discord.js's own
// permission constants — no cast needed, but named here once for reuse below.
const PERMISSION_BITS: Record<string, bigint> = PermissionFlagsBits;

/**
 * Discord permission names (the discord.js PermissionFlagsBits keys, e.g.
 * ManageMessages, ViewChannel, CreatePublicThreads) -> a single bitfield.
 *
 * Throws naming the exact unknown name, rather than silently dropping it —
 * a typo'd permission should fail loud, not grant less than was asked.
 */
export function parsePermissionNames(names: string[]): bigint {
  let bits = 0n;
  for (const name of names) {
    const bit = PERMISSION_BITS[name];
    if (bit === undefined) {
      throw new Error(`Unknown Discord permission name: ${name}`);
    }
    bits |= bit;
  }
  return bits;
}

/** The reverse of parsePermissionNames — every name whose bit is set. */
export function namesFromBits(bits: bigint): string[] {
  return Object.entries(PERMISSION_BITS)
    .filter(([, bit]) => (bits & bit) === bit)
    .map(([name]) => name);
}

/**
 * Mutations are home-server only when one is configured (hosServerId). Throws unless serverId is the home server —
 * the bot's presence in other people's servers must stay read/reply-only.
 */
export function assertHosMutation(serverId: string): void {
  // No home server configured (generic build): the operator owns the bot, so any guild it is in is allowed.
  if (HOS_SERVER_ID && serverId !== HOS_SERVER_ID) {
    throw new Error(`Refusing to mutate server ${serverId} — role and permission edits are House of Solance only.`);
  }
}

/** A refusal the caller should read as is: a guard or a bad argument, not a Discord failure. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

/**
 * Home server only, strictly: unlike assertHosMutation, a build with no home server configured
 * refuses too (the audit log, thread locks and thread members are read or changed for the home server alone).
 */
export function assertHomeServerOnly(serverId: string | null | undefined, what: string): void {
  if (!HOS_SERVER_ID) {
    throw new ToolRefusal(`Refusing ${what}: no home server is configured (hosServerId in the house config file), and this works in the home server only.`);
  }
  if (serverId !== HOS_SERVER_ID) {
    throw new ToolRefusal(`Refusing ${what} in server ${serverId ?? '(none)'}: this works in the home server only.`);
  }
}

/** Granting Administrator stays the owner's, by hand — never through these tools. */
export function assertNoAdministratorGrant(bits: bigint): void {
  if ((bits & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
    throw new Error(`Refusing to grant Administrator through this tool — that stays ${identity.owner_name}'s, by hand.`);
  }
}

export interface OverwriteBits {
  allow: bigint;
  deny: bigint;
}

export interface OverwriteChange {
  allow: bigint;
  deny: bigint;
  neutral: bigint;
}

/**
 * Merge a requested allow/deny/neutral change into a channel overwrite's
 * current allow/deny bits.
 *
 * Neutral wins over both (clears a bit from allow AND deny — "unset", not
 * "deny"), and allow/deny remain mutually exclusive per Discord's own model:
 *
 *   allow' = (allow | A) & ~D & ~N
 *   deny'  = (deny  | D) & ~A & ~N
 *
 * Any bit untouched by A, D or N passes through unchanged.
 */
export function mergeOverwrite(current: OverwriteBits, change: OverwriteChange): OverwriteBits {
  const { allow, deny } = current;
  const { allow: A, deny: D, neutral: N } = change;
  return {
    allow: (allow | A) & ~D & ~N,
    deny: (deny | D) & ~A & ~N,
  };
}

/** A role's permission set after adding and removing bits: (current | add) & ~remove. */
export function applyRolePermEdit(current: bigint, add: bigint, remove: bigint): bigint {
  return (current | add) & ~remove;
}

/**
 * Run async jobs one at a time per key, in call order. Two overlapping
 * read-merge-write edits on the same channel+target would each read the same
 * "before" state, and the later write would drop the earlier one. A failed
 * job does not block the next; the key is forgotten once its queue drains.
 */
export function keyedSerializer() {
  const tails = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prior = tails.get(key) ?? Promise.resolve();
    const result = prior.then(job);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}
