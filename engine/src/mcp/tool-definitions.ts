// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The Mac server's tool list, built from the shared definitions
 * (modules/discord/mcp/definitions.ts, copied to ./shared by scripts/sync-shared.mjs)
 * so it can no longer drift from the cloud connector. List order is part of the
 * MCP contract and comes from the shared file.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type ToolDefinition, buildToolDefinitions } from './shared/definitions.js';

export interface JsonTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export const DEFINITIONS: ToolDefinition[] = buildToolDefinitions(z);

/** Drop the keys zod-to-json-schema adds that the hand-written list never had. */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'additionalProperties') continue;
      out[k] = clean(v);
    }
    return out;
  }
  return node;
}

/** JSON schema for a zod raw shape, in the form MCP tools/list carries. */
export function shapeToInputSchema(shape: Record<string, any>): JsonTool['inputSchema'] {
  // `any` on purpose: the shape is built at runtime, and typing it makes tsc recurse forever (TS2589).
  const toJson = zodToJsonSchema as (schema: unknown, options: Record<string, unknown>) => unknown;
  const schema = clean(toJson((z as any).object(shape), { $refStrategy: 'none', target: 'jsonSchema7' })) as any;
  return { type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] };
}

/** One tool as the Mac server lists it: the shared shape with the Mac-only fields merged over it. */
export function toLocalTool(def: ToolDefinition): JsonTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: shapeToInputSchema({ ...def.shape, ...(def.localShape ?? {}) }),
  };
}

const ALL: JsonTool[] = DEFINITIONS.map(toLocalTool);
const VIEW_INDEX = ALL.findIndex((t) => t.name === 'discord_view_attachment');

/** Tools before the view-attachment definition (list order is part of the MCP contract). */
export const TOOLS_BEFORE_VIEW: JsonTool[] = ALL.slice(0, VIEW_INDEX);
/** Tools after the view-attachment definition. */
export const TOOLS_AFTER_VIEW: JsonTool[] = ALL.slice(VIEW_INDEX + 1);
/** discord_view_attachment as the shared definition describes it. */
export const VIEW_ATTACHMENT_JSON_TOOL: JsonTool = ALL[VIEW_INDEX];

/** Assemble the full tool list, slotting the view-attachment definition between the two halves. */
export function composeTools(viewAttachmentTool: JsonTool): JsonTool[] {
  return [...TOOLS_BEFORE_VIEW, viewAttachmentTool, ...TOOLS_AFTER_VIEW];
}

export const TOOLS: JsonTool[] = composeTools(VIEW_ATTACHMENT_JSON_TOOL);
