/**
 * Session message identity shared by readers that already used the same rule.
 *
 * `nonEmptyMessageId` skips blank strings, so `uuid: ""` can fall through to
 * `id`. `stringMessageId` keeps a blank string and does not look further.
 * Call sites that use `uuid ?? id` are a third rule: a non-string `uuid`
 * blocks `id`. Those stay local.
 */
export interface MessageIdentitySource {
  uuid?: unknown;
  id?: unknown;
}

export function nonEmptyMessageId(
  message: MessageIdentitySource,
): string | undefined {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return undefined;
}

export function stringMessageId(
  message: MessageIdentitySource,
): string | undefined {
  if (typeof message.uuid === "string") return message.uuid;
  if (typeof message.id === "string") return message.id;
  return undefined;
}
