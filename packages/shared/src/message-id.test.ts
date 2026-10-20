import { describe, expect, it } from "vitest";
import { nonEmptyMessageId, stringMessageId } from "./message-id.js";

describe("message identity", () => {
  it("prefers a non-empty uuid and skips blanks", () => {
    expect(nonEmptyMessageId({ uuid: "uuid-1", id: "id-1" })).toBe("uuid-1");
    expect(nonEmptyMessageId({ uuid: "", id: "id-1" })).toBe("id-1");
    expect(nonEmptyMessageId({ uuid: "", id: "" })).toBeUndefined();
    expect(nonEmptyMessageId({ uuid: 12, id: "id-1" })).toBe("id-1");
    expect(nonEmptyMessageId({})).toBeUndefined();
  });

  it("keeps a blank string identity and still skips non-strings", () => {
    expect(stringMessageId({ uuid: "", id: "id-1" })).toBe("");
    expect(stringMessageId({ id: "" })).toBe("");
    expect(stringMessageId({ uuid: 12, id: "id-1" })).toBe("id-1");
    expect(stringMessageId({ uuid: 12 })).toBeUndefined();
    expect(stringMessageId({})).toBeUndefined();
  });
});
