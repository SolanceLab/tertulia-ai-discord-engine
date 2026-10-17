// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * identity.ts — the running deployment's identity (names, labels, reserved wording) and the one
 * function that turns a sentence template into text. Engine code asks for a sentence by key
 * (`say('away.intro', { mention })`) and never spells a name itself. See identity-defaults.ts.
 */
import { houseConfig } from './house-config.js';
import { DEFAULT_TEXT, type Identity } from './identity-defaults.js';

export const identity: Identity = houseConfig.identity;

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The variables every sentence template can use. */
export function identityVars(id: Identity = identity): Record<string, string> {
  return {
    owner: id.owner_name,
    Owner: cap(id.owner_name),
    OWNER: id.owner_name.toUpperCase(),
    bot: id.bot_name,
    Bot: cap(id.bot_name),
    bot_full: id.bot_full_name,
    bot_role: id.bot_role,
    owner_label: id.owner_label,
    bot_label: id.bot_label,
  };
}

/** Fill `${name}` slots. A slot with no value is left as written. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

/** A sentence by key: the deployment's own text if it has one, the generic text otherwise. */
export function say(key: string, vars: Record<string, string> = {}, id: Identity = identity): string {
  const template = key in id.text ? id.text[key] : DEFAULT_TEXT[key];
  if (template === undefined) throw new Error(`identity: no sentence "${key}"`);
  return fill(template, { ...identityVars(id), ...vars });
}


/** The owner's Discord user id from the environment: OWNER_USER_ID first, then the deployment's alias variable. */
export function resolveOwnerUserId(env: NodeJS.ProcessEnv = process.env, id: Identity = identity): string {
  return env.OWNER_USER_ID || (id.owner_user_id_env ? env[id.owner_user_id_env] : '') || '';
}
