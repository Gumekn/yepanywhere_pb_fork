/**
 * Cursor model expressions such as `grok-4.7[context=500k,reasoning_effort=high,fast=false]`
 * are picker state. The CLI only honors a bracket string when it exactly matches a
 * published variant; otherwise it exits or keeps the default variant (256K High Fast
 * for Grok 4.7). Launch the base model, then write each option after the session
 * exists and require Cursor to report those values back.
 */

import type {
  ClientCapabilities,
  SessionConfigOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { getLogger } from "../../logging/logger.js";

const log = getLogger();
const MODEL_CONFIG_ID = "model";
/**
 * Upper bound on full sweeps over the requested options. Each
 * `session/set_config_option` round-trip costs Cursor ~2-3s, and the whole
 * startup must fit inside the provider initialization timeout, so only options
 * whose active value differs are written and sweeping stops once all match.
 */
const MAX_APPLY_PASSES = 2;

export const CURSOR_ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { subagents: {}, parameterizedModelPicker: true },
};

export interface CursorModelParameter {
  id: string;
  value: string;
}

export interface ParsedCursorModel {
  /** Value passed to `--model`. Parameterized expressions use the base id. */
  launchModel: string | undefined;
  modelId: string | undefined;
  parameters: CursorModelParameter[];
}

interface CursorConfigClient {
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse>;
  /** Options reported by new/load session, when the agent sent them. */
  getSessionConfigOptions?(
    sessionId: string,
  ): SessionConfigOption[] | undefined;
}

export function parseCursorModelExpression(
  model: string | undefined,
): ParsedCursorModel {
  if (!model) {
    return { launchModel: undefined, modelId: undefined, parameters: [] };
  }
  const match = model.match(/^([^\[\]]+)(?:\[([^\[\]]*)\])?$/);
  const modelId = match?.[1];
  const body = match?.[2];
  if (!modelId || body === undefined) {
    return { launchModel: model, modelId: model, parameters: [] };
  }
  const parameters: CursorModelParameter[] = [];
  for (const entry of body.split(",")) {
    const parts = entry.split("=");
    const id = parts[0]?.trim();
    const value = parts[1]?.trim();
    if (parts.length !== 2 || !id || !value) {
      return { launchModel: model, modelId: model, parameters: [] };
    }
    parameters.push({ id, value });
  }
  if (parameters.length === 0) {
    return { launchModel: model, modelId: model, parameters: [] };
  }
  return { launchModel: modelId, modelId, parameters };
}

export function cursorLaunchModel(
  model: string | undefined,
): string | undefined {
  return parseCursorModelExpression(model).launchModel;
}

function optionValue(
  option: SessionConfigOption | undefined,
): string | undefined {
  if (!option) return undefined;
  if (option.type === "select") return option.currentValue;
  if (option.type === "boolean") return option.currentValue ? "true" : "false";
  return undefined;
}

/**
 * Cursor treats a full parameter set that is not an exact variant as invalid and
 * snaps back to the default. One changed option can also rewrite the others.
 * A second sweep lets a later option restore a value the previous snap cleared.
 * Options already active are never rewritten: every write is a slow round-trip.
 */
export async function applyCursorModelParameters(
  client: CursorConfigClient,
  sessionId: string,
  model: string | undefined,
): Promise<void> {
  const parsed = parseCursorModelExpression(model);
  if (!parsed.modelId || parsed.parameters.length === 0) return;

  let options: SessionConfigOption[] =
    client.getSessionConfigOptions?.(sessionId) ?? [];
  const active = (id: string) =>
    optionValue(options.find((option) => option.id === id));
  const pending = () =>
    parsed.parameters.filter(
      (parameter) => active(parameter.id) !== parameter.value,
    );

  if (active(MODEL_CONFIG_ID) !== parsed.modelId) {
    const result = await client.setSessionConfigOption(
      sessionId,
      MODEL_CONFIG_ID,
      parsed.modelId,
    );
    options = result.configOptions;
  }
  for (let pass = 0; pass < MAX_APPLY_PASSES; pass++) {
    if (pending().length === 0) break;
    for (const parameter of parsed.parameters) {
      if (active(parameter.id) === parameter.value) continue;
      const result = await client.setSessionConfigOption(
        sessionId,
        parameter.id,
        parameter.value,
      );
      options = result.configOptions;
    }
  }

  const mismatches = pending();
  if (mismatches.length > 0) {
    const detail = mismatches
      .map(
        (parameter) =>
          `${parameter.id}=${parameter.value} (active: ${active(parameter.id) ?? "missing"})`,
      )
      .join(", ");
    throw new Error(
      `Cursor did not apply ${parsed.modelId} parameters: ${detail}`,
    );
  }
  log.debug(
    { sessionId, modelId: parsed.modelId, parameters: parsed.parameters },
    "Cursor model parameters applied",
  );
}
