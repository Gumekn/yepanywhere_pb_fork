import type { ModelInfo } from "@yep-anywhere/shared";

export function getCursorModelSelection(
  models: ModelInfo[],
  value: string | null,
) {
  const raw = value === "default" ? "auto" : value;
  const match = raw?.match(/^([^\[\]]+)(?:\[([^\[\]]+)\])?$/);
  const model = models.find(
    (candidate) => candidate.id === (match?.[1] ?? raw),
  );
  const parameters = Object.fromEntries(
    (model?.cursorConfigOptions ?? []).map((option) => [
      option.id,
      option.currentValue,
    ]),
  );
  let valid = Boolean(model);
  if (match?.[2]) {
    for (const entry of match[2].split(",")) {
      const [key, selected, extra] = entry.split("=");
      const option = model?.cursorConfigOptions?.find(
        (option) => option.id === key,
      );
      if (
        extra !== undefined ||
        !selected ||
        !option?.options.some((value) => value.value === selected)
      ) {
        valid = false;
        break;
      }
      parameters[key as string] = selected;
    }
  }
  return { model: valid ? model : undefined, parameters, raw };
}

/** A single native model expression persists every independent option. */
export function buildCursorModelValue(
  model: ModelInfo,
  parameters: Record<string, string> = {},
): string {
  const entries = (model.cursorConfigOptions ?? []).map((option) => {
    const value = parameters[option.id] ?? option.currentValue;
    if (!option.options.some((candidate) => candidate.value === value)) {
      throw new Error(`Unsupported Cursor parameter: ${option.id}`);
    }
    return `${option.id}=${value}`;
  });
  return entries.length ? `${model.id}[${entries.join(",")}]` : model.id;
}

export function getPreferredCursorModelId(
  models: ModelInfo[],
  saved?: string | null,
): string | null {
  // Preserve old variant IDs too: the CLI can still accept them. The picker
  // exposes the saved value until the user deliberately selects a native model.
  if (saved) {
    const selection = getCursorModelSelection(models, saved);
    if (selection.model?.cursorConfigOptions) {
      return buildCursorModelValue(selection.model, selection.parameters);
    }
    return saved === "default" ? "auto" : saved;
  }
  return (
    models.find((model) => model.id === "auto")?.id ?? models[0]?.id ?? null
  );
}
