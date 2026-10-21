/**
 * MiniMax Code model catalog helpers.
 *
 * mcode advertises models through the ACP `model` select config option whose
 * values encode `m:<provider>:<model>:v:<variant>` (variant optional, `u` when
 * absent) — see references/minimax/pretty/run-acp-command.js `Qg`/`or`.
 * A model usually has a plain variant ("") and a `thinking` variant; the
 * thinking depth comes from the separate `thinkingEffort` option.
 *
 * Yep shows one picker entry per `provider/model` and folds the variants into
 * reasoning efforts: `off` = plain variant, every other value = `thinking`
 * variant + that effort.
 */

import type { ModelInfo } from "@yep-anywhere/shared";

export const MCODE_MODEL_CONFIG_ID = "model";
export const MCODE_EFFORT_CONFIG_ID = "thinkingEffort";
export const MCODE_PERMISSION_CONFIG_ID = "permissionMode";
export const MCODE_REASONING_OFF = "off";
const THINKING_VARIANT = "thinking";

export interface McodeModelSelection {
  providerId: string;
  modelId: string;
  variant?: string;
}

export interface McodeSelectOption {
  value: string;
  name: string;
}

export interface McodeConfigOptionLike {
  id: string;
  type?: string;
  currentValue?: unknown;
  options?: unknown;
}

export function parseMcodeModelValue(
  value: string,
): McodeModelSelection | null {
  const [tag, provider, model, kind, variant, ...rest] = value.split(":");
  if (
    tag !== "m" ||
    !provider ||
    !model ||
    (kind !== "u" && kind !== "v") ||
    (kind === "u" && variant !== undefined) ||
    (kind === "v" && variant === undefined) ||
    rest.length > 0
  ) {
    return null;
  }
  try {
    return {
      providerId: decodeURIComponent(provider),
      modelId: decodeURIComponent(model),
      ...(kind === "v" ? { variant: decodeURIComponent(variant ?? "") } : {}),
    };
  } catch {
    return null;
  }
}

export function mcodeModelRef(selection: McodeModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

function flattenSelectOptions(options: unknown): McodeSelectOption[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry): McodeSelectOption[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    // Grouped select options carry their own nested `options` array.
    if (Array.isArray(record.options)) {
      return flattenSelectOptions(record.options);
    }
    if (typeof record.value !== "string") return [];
    return [
      {
        value: record.value,
        name: typeof record.name === "string" ? record.name : record.value,
      },
    ];
  });
}

export function getMcodeSelectOptions(
  configOptions: readonly McodeConfigOptionLike[] | undefined,
  id: string,
): { current?: string; options: McodeSelectOption[] } {
  const option = configOptions?.find((candidate) => candidate.id === id);
  if (!option) return { options: [] };
  return {
    current:
      typeof option.currentValue === "string" ? option.currentValue : undefined,
    options: flattenSelectOptions(option.options),
  };
}

/** Strip mcode's " · thinking" display suffix from a variant's label. */
function baseDisplayName(name: string): string {
  return name.replace(/\s*·\s*thinking\s*$/iu, "").trim() || name;
}

/** Build Yep's picker catalog from the ACP config options. */
export function buildMcodeModelCatalog(
  configOptions: readonly McodeConfigOptionLike[] | undefined,
): ModelInfo[] {
  const models = getMcodeSelectOptions(configOptions, MCODE_MODEL_CONFIG_ID);
  const efforts = getMcodeSelectOptions(configOptions, MCODE_EFFORT_CONFIG_ID);
  const effortValues = efforts.options.map((option) => option.value);
  const grouped = new Map<
    string,
    { name: string; variants: Set<string>; hasUnvaried: boolean }
  >();
  for (const option of models.options) {
    const parsed = parseMcodeModelValue(option.value);
    if (!parsed) continue;
    const ref = mcodeModelRef(parsed);
    const entry = grouped.get(ref) ?? {
      name: baseDisplayName(option.name),
      variants: new Set<string>(),
      hasUnvaried: false,
    };
    if (parsed.variant === undefined) entry.hasUnvaried = true;
    else entry.variants.add(parsed.variant);
    if (parsed.variant !== THINKING_VARIANT) {
      entry.name = baseDisplayName(option.name);
    }
    grouped.set(ref, entry);
  }

  const current = models.current ? parseMcodeModelValue(models.current) : null;
  const currentRef = current ? mcodeModelRef(current) : null;
  const result: ModelInfo[] = [];
  for (const [id, entry] of grouped) {
    const thinking = entry.variants.has(THINKING_VARIANT);
    const plain = entry.hasUnvaried || entry.variants.has("");
    const info: ModelInfo = { id, name: entry.name };
    if (thinking && effortValues.length > 0) {
      const selectable = plain
        ? [MCODE_REASONING_OFF, ...effortValues]
        : effortValues;
      info.supportedReasoningEfforts = selectable.map((reasoningEffort) => ({
        reasoningEffort,
      }));
      info.defaultReasoningEffort =
        id === currentRef && current?.variant !== THINKING_VARIANT && plain
          ? MCODE_REASONING_OFF
          : efforts.current && effortValues.includes(efforts.current)
            ? efforts.current
            : effortValues[Math.floor(effortValues.length / 2)];
      info.supportsEffort = true;
    } else if (thinking && plain) {
      info.supportedReasoningEfforts = [
        { reasoningEffort: MCODE_REASONING_OFF },
        { reasoningEffort: "on" },
      ];
      info.defaultReasoningEffort = "on";
      info.supportsEffort = false;
    }
    result.push(info);
  }
  // Keep the session/default model first so it becomes the picker default.
  if (currentRef) {
    result.sort((a, b) =>
      a.id === currentRef ? -1 : b.id === currentRef ? 1 : 0,
    );
  }
  return result;
}

/**
 * Resolve the exact ACP model value for a picker choice. `model` may be a
 * picker ref (`provider/model`), mcode's `provider/model#variant` syntax, or a
 * raw ACP value. Returns null when the model is not advertised.
 */
export function resolveMcodeModelValue(
  configOptions: readonly McodeConfigOptionLike[] | undefined,
  model: string,
  reasoningEffort: string | undefined,
): string | null {
  const { options } = getMcodeSelectOptions(
    configOptions,
    MCODE_MODEL_CONFIG_ID,
  );
  if (options.some((option) => option.value === model)) return model;
  const [ref, explicitVariant] = model.split("#", 2);
  const candidates = options.flatMap((option) => {
    const parsed = parseMcodeModelValue(option.value);
    return parsed && mcodeModelRef(parsed) === ref
      ? [{ value: option.value, variant: parsed.variant }]
      : [];
  });
  if (candidates.length === 0) return null;
  const wantsPlain = reasoningEffort === MCODE_REASONING_OFF;
  const desiredVariant =
    explicitVariant !== undefined
      ? explicitVariant
      : wantsPlain
        ? ""
        : THINKING_VARIANT;
  return (
    candidates.find((candidate) => candidate.variant === desiredVariant)
      ?.value ??
    (wantsPlain
      ? candidates.find((candidate) => candidate.variant === undefined)?.value
      : undefined) ??
    candidates[0]?.value ??
    null
  );
}

/** Small fallback when no catalog could be probed yet. */
export const MCODE_FALLBACK_MODELS: ModelInfo[] = [
  { id: "minimax/MiniMax-M3", name: "MiniMax-M3" },
  { id: "minimax/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash" },
];
