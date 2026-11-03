/**
 * Capability metadata for gateway models Yep registers with Pi dynamically.
 *
 * Pi's built-in catalog is generated with per-model quirks (see
 * `references/pi/packages/ai/scripts/generate-models.ts`), but a model Yep
 * registers at runtime starts with none of them. That is not cosmetic: current
 * Claude releases reject the legacy budget-based thinking payload outright with
 *
 *   400 "thinking.type.enabled" is not supported for this model. Use
 *       "thinking.type.adaptive" and "output_config.effort" ...
 *
 * because `anthropic-messages` only emits the adaptive shape when the model
 * carries `compat.forceAdaptiveThinking`. The rules below mirror upstream's
 * `isAnthropicAdaptiveThinkingModel`, `isAnthropicTemperatureUnsupportedModel`
 * and its adaptive-effort level maps, keyed on the same substrings so both
 * `claude-opus-4-8` and `claude-opus-4.8` style ids match.
 */

/** Thinking levels Pi understands, mapped to a provider effort or disabled. */
export type PiThinkingLevelMap = Record<string, string | null>;

export interface PiAnthropicModelTraits {
  compat?: {
    forceAdaptiveThinking?: true;
    supportsTemperature?: false;
  };
  thinkingLevelMap?: PiThinkingLevelMap;
}

function hasVersion(id: string, family: string, version: string): boolean {
  return (
    id.includes(`${family}-${version.replace(".", "-")}`) ||
    id.includes(`${family}-${version}`)
  );
}

/** Claude releases that require the adaptive thinking payload. */
function isAdaptiveThinkingModel(id: string): boolean {
  return (
    hasVersion(id, "opus", "4.6") ||
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5") ||
    hasVersion(id, "sonnet", "4.6") ||
    id.includes("sonnet-5") ||
    id.includes("sonnet.5") ||
    id.includes("fable-5")
  );
}

function isTemperatureUnsupportedModel(id: string): boolean {
  return (
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5")
  );
}

/**
 * Claude releases whose Anthropic endpoint rejects
 * `thinking: { type: "disabled" }`; adaptive effort is the only control.
 * Verified against the gateway: Opus 5.5 answers 400 and Fable 5 answers 500.
 */
function isThinkingAlwaysOnModel(id: string): boolean {
  return (
    id.includes("fable-5") || id.includes("opus-5-5") || id.includes("opus-5.5")
  );
}

/**
 * Effort levels above `high` that an adaptive Claude model accepts.
 *
 * Follows Anthropic's adaptive-thinking documentation as encoded upstream:
 * `max` on every adaptive model, `xhigh` only on Opus 4.7/4.8/5.x, Sonnet 5
 * and Fable 5. The gateway translates OpenAI-style `reasoning_effort` into the
 * same `output_config.effort`, so the map applies to both request protocols.
 * Without it Pi clamps a requested `xhigh`/`max` down to `high`.
 */
function adaptiveEffortLevelMap(id: string): PiThinkingLevelMap | undefined {
  if (!isAdaptiveThinkingModel(id)) return undefined;
  const supportsXhigh =
    hasVersion(id, "opus", "4.7") ||
    hasVersion(id, "opus", "4.8") ||
    id.includes("opus-5") ||
    id.includes("opus.5") ||
    id.includes("sonnet-5") ||
    id.includes("sonnet.5") ||
    id.includes("fable-5");
  return { max: "max", ...(supportsXhigh ? { xhigh: "xhigh" } : {}) };
}

/**
 * Resolve the Anthropic-protocol traits for one bare gateway model id.
 *
 * Models that cannot disable thinking additionally carry `off: null` (the
 * upstream encoding) \u2014 without it Pi would send
 * `thinking: { type: "disabled" }` for a model that rejects it.
 */
export function piAnthropicModelTraits(
  bareModelId: string,
): PiAnthropicModelTraits {
  const id = bareModelId.toLowerCase();
  const effortMap = adaptiveEffortLevelMap(id);
  if (!effortMap) return {};

  const thinkingLevelMap: PiThinkingLevelMap = {
    ...effortMap,
    ...(isThinkingAlwaysOnModel(id) ? { off: null } : {}),
  };

  return {
    compat: {
      forceAdaptiveThinking: true,
      ...(isTemperatureUnsupportedModel(id)
        ? { supportsTemperature: false as const }
        : {}),
    },
    thinkingLevelMap,
  };
}

/**
 * Thinking level map for the OpenAI-compatible route of a gateway model.
 *
 * Only the extended efforts are carried over. `off` stays a valid level here:
 * Pi then omits `reasoning_effort`, which the gateway accepts even for models
 * whose Anthropic endpoint rejects an explicit disable. Marking it `null` would
 * make Pi clamp `off` up to `minimal`, an effort Claude rejects.
 */
export function piOpenAiCompatibleThinkingLevelMap(
  bareModelId: string,
): PiThinkingLevelMap | undefined {
  return adaptiveEffortLevelMap(bareModelId.toLowerCase());
}

/** Named efforts every Pi gateway model offers in Yep's picker. */
const PI_BASE_PICKER_EFFORTS = ["low", "medium", "high"] as const;

/**
 * Efforts Yep's picker advertises for a Pi gateway model, lowest first.
 *
 * `minimal` is never offered (the shared picker has no such preset and Claude
 * rejects it); `xhigh`/`max` only where Pi will actually send them.
 */
export function piPickerReasoningEfforts(bareModelId: string): string[] {
  const effortMap = adaptiveEffortLevelMap(bareModelId.toLowerCase());
  return [
    ...PI_BASE_PICKER_EFFORTS,
    ...(effortMap?.xhigh ? ["xhigh"] : []),
    ...(effortMap?.max ? ["max"] : []),
  ];
}
