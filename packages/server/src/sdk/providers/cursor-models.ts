import { homedir } from "node:os";
import type { CursorModelConfigOption, ModelInfo } from "@yep-anywhere/shared";
import { ACPClient } from "./acp/client.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const cleanName = (value: string) =>
  value.replace(/\u200b|\u200c|\u200d|\ufeff/g, "").trim();
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value);

/** Validate the public catalog before using it to construct CLI overrides. */
export function parseCursorModelCatalog(value: unknown): ModelInfo[] {
  const rawModels = record(value).models;
  if (!Array.isArray(rawModels))
    throw new Error("Invalid Cursor model catalog");
  const models: ModelInfo[] = [];
  for (const raw of rawModels) {
    const model = record(raw);
    if (
      !identifier(model.value) ||
      typeof model.name !== "string" ||
      !Array.isArray(model.configOptions)
    )
      continue;
    const configOptions: CursorModelConfigOption[] = [];
    let valid = true;
    for (const rawConfig of model.configOptions) {
      const config = record(rawConfig);
      if (
        !identifier(config.id) ||
        typeof config.name !== "string" ||
        typeof config.currentValue !== "string" ||
        !Array.isArray(config.options)
      ) {
        valid = false;
        break;
      }
      const options = config.options.flatMap((rawOption) => {
        const option = record(rawOption);
        return identifier(option.value) && typeof option.name === "string"
          ? [{ value: option.value, name: cleanName(option.name) }]
          : [];
      });
      if (
        options.length !== config.options.length ||
        !options.some((option) => option.value === config.currentValue)
      ) {
        valid = false;
        break;
      }
      configOptions.push({
        id: config.id,
        name: cleanName(config.name),
        category:
          typeof config.category === "string" ? config.category : undefined,
        currentValue: config.currentValue,
        options,
      });
    }
    if (!valid) continue;
    models.push({
      id: model.value === "default" ? "auto" : model.value,
      name: cleanName(model.name),
      cursorConfigOptions: configOptions,
    });
  }
  if (!models.length) throw new Error("Empty Cursor model catalog");
  return models;
}

/** Read-only ACP discovery: no session, prompt, or login flow is created. */
export async function loadCursorModelCatalog(
  path: string,
): Promise<ModelInfo[]> {
  const client = new ACPClient();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect({ command: path, args: ["acp"], cwd: homedir() });
        await client.initialize();
        // initialize already detects existing CLI credentials; unlike calling
        // authenticate, this cannot open an interactive login for signed-out users.
        return parseCursorModelCatalog(
          await client.requestExtension("cursor/list_available_models"),
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cursor model catalog timed out")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
