export interface NormalizedCodexImageGeneration {
  id?: string;
  status?: string;
  revisedPrompt?: string;
  result?: string;
  path?: string;
  url?: string;
}

export function isCodexImageGenerationRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.type === "image_generation" ||
    value.type === "imageGeneration" ||
    value.type === "image_generation_call" ||
    value.type === "imageGenerationCall" ||
    value.type === "image_generation_end" ||
    value.type === "imageGenerationEnd"
  );
}

export function normalizeCodexImageGenerationRecord(
  record: Record<string, unknown>,
  options: { defaultStatus?: string } = {},
): NormalizedCodexImageGeneration {
  const id = getFirstString(record.id);
  const status = getFirstString(record.status) ?? options.defaultStatus;
  const revisedPrompt = getFirstString(
    record.revisedPrompt,
    record.revised_prompt,
  );
  const result = getFirstString(record.result);
  const explicitPath = getFirstString(
    record.savedPath,
    record.saved_path,
    record.path,
  );
  const path = resolveCodexImageGenerationPath(explicitPath, result);
  const url = path ? undefined : resolveCodexImageGenerationUrl(result);

  return {
    ...(id ? { id } : {}),
    ...(status ? { status } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}),
    ...(result ? { result } : {}),
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
  };
}

export function summarizeCodexImageGenerationResult(result: string): string {
  if (result.startsWith("data:") || detectBase64ImageMimeType(result)) {
    return "[image data]";
  }

  const trimmed = result.trim();
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

export function buildCodexImageGenerationResultText(input: {
  path?: string;
  url?: string;
  status?: string;
  result?: string;
}): string {
  if (input.path) {
    return `Generated image: ${input.path}`;
  }

  if (input.url) {
    return "Generated image";
  }

  if (input.status && input.status !== "completed") {
    return `Image generation ${input.status}`;
  }

  if (input.result) {
    return `Image generation result: ${summarizeCodexImageGenerationResult(
      input.result,
    )}`;
  }

  return "Image generated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveCodexImageGenerationPath(
  explicitPath: string | undefined,
  result: string | undefined,
): string | undefined {
  if (explicitPath) {
    const fileUrlPath = parseFileUrlPath(explicitPath);
    return fileUrlPath ?? explicitPath;
  }

  if (!result) {
    return undefined;
  }

  const fileUrlPath = parseFileUrlPath(result);
  if (fileUrlPath) {
    return fileUrlPath;
  }

  return isAbsoluteLocalPath(result) ? result : undefined;
}

function resolveCodexImageGenerationUrl(
  result: string | undefined,
): string | undefined {
  if (!result) {
    return undefined;
  }

  const trimmed = result.trim();
  if (trimmed.startsWith("data:") || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const mimeType = detectBase64ImageMimeType(trimmed);
  return mimeType ? `data:${mimeType};base64,${trimmed}` : undefined;
}

function parseFileUrlPath(value: string): string | undefined {
  if (!value.startsWith("file://")) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function detectBase64ImageMimeType(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length < 128 || !/^[A-Za-z0-9+/=\s]+$/.test(normalized)) {
    return undefined;
  }

  let header: Buffer;
  try {
    header = Buffer.from(normalized.slice(0, 256), "base64");
  } catch {
    return undefined;
  }

  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    header.length >= 6 &&
    header.slice(0, 6).toString("ascii").startsWith("GIF")
  ) {
    return "image/gif";
  }
  if (
    header.length >= 12 &&
    header.slice(0, 4).toString("ascii") === "RIFF" &&
    header.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}
