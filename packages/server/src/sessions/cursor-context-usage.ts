import type { ContextCategoryEntry, ContextUsage } from "@yep-anywhere/shared";

/**
 * Cursor CLI 2026.10.01-e373342 native protobuf schema (index.js):
 * ConversationStateStructure.token_details = 5;
 * ConversationTokenDetails: used_tokens = 1, max_tokens = 2, breakdown = 3;
 * PromptTokenBreakdownSnapshot: total_used_tokens = 1, max_tokens = 2,
 * categories = 3; category: id = 1, label = 2, estimated_tokens = 3.
 *
 * Read only the current root, never historical roots/subagent state. Counts
 * already include the prompt and tools; summing transcript text loses both
 * those costs and compaction boundaries.
 */
export function readCursorContextUsage(root: Buffer): ContextUsage | undefined {
  try {
    const details = bytesField(readFields(root), 5);
    if (!details) return undefined;
    const fields = readFields(details);
    const inputTokens = uint32Field(fields, 1);
    const contextWindow = uint32Field(fields, 2);
    if (contextWindow === 0) return undefined;
    const usage: ContextUsage = {
      inputTokens,
      contextWindow,
      percentage: Math.round((inputTokens / contextWindow) * 1000) / 10,
    };
    // A damaged/older optional breakdown must not hide valid top-level counts.
    try {
      const breakdown = bytesField(fields, 3);
      if (breakdown) {
        const snapshot = readFields(breakdown);
        if (
          uint32Field(snapshot, 1) === inputTokens &&
          uint32Field(snapshot, 2) === contextWindow
        ) {
          const categories: ContextCategoryEntry[] = [];
          for (const category of snapshot.get(3) ?? []) {
            if (!Buffer.isBuffer(category)) continue;
            const entry = readFields(category);
            const id = bytesField(entry, 1)?.toString("utf8");
            const name = bytesField(entry, 2)?.toString("utf8") || id;
            if (!name) continue;
            categories.push({ id, name, tokens: uint32Field(entry, 3) });
          }
          if (categories.length > 0) usage.categories = categories;
        }
      }
    } catch {
      // Native usage is still usable without category estimates.
    }
    return usage;
  } catch {
    return undefined;
  }
}

type Fields = Map<number, (Buffer | bigint)[]>;

function bytesField(fields: Fields, field: number): Buffer | undefined {
  const value = fields.get(field)?.at(-1);
  if (value === undefined) return undefined;
  if (!Buffer.isBuffer(value)) throw new Error("Invalid protobuf bytes field");
  return value;
}

function uint32Field(fields: Fields, field: number): number {
  const value = fields.get(field)?.at(-1) ?? 0n;
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffffn) {
    throw new Error("Invalid protobuf uint32 field");
  }
  return Number(value);
}

/** Small bounded protobuf reader; unknown fields, including uint64s, are skipped. */
function readFields(data: Buffer): Fields {
  if (data.length > 2_000_000) throw new Error("Protobuf node too large");
  const fields: Fields = new Map();
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = data[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) break;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < data.length) {
    const tag = varint();
    const field = Number(tag >> 3n);
    if (field < 1 || field > 0x1fff_ffff)
      throw new Error("Invalid protobuf tag");
    const wire = Number(tag & 7n);
    let value: Buffer | bigint;
    if (wire === 0) {
      value = varint();
    } else if (wire === 2) {
      const size = Number(varint());
      if (!Number.isSafeInteger(size) || size > data.length - offset) {
        throw new Error("Truncated protobuf field");
      }
      value = data.subarray(offset, offset + size);
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new Error("Truncated protobuf field");
      continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const values = fields.get(field) ?? [];
    values.push(value);
    fields.set(field, values);
  }
  return fields;
}
