import type { ModelCapabilities } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

export const COMMAND_CODE_PROVIDER = ProviderDriverKind.make("commandCode");

/**
 * Product slug meaning "keep whatever model the session opened with". It must be the shared
 * `default` sentinel: the ACP adapter skips its model write for that exact value, whereas any other
 * slug is validated against the session's choices and rejected as unavailable.
 */
export const COMMAND_CODE_DEFAULT_MODEL_SLUG = "default";

export const EMPTY_COMMAND_CODE_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Command Code validates its own model ids, so an unknown slug passes through unchanged. */
export function resolveCommandCodeAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === COMMAND_CODE_DEFAULT_MODEL_SLUG) return undefined;
  // `normalizeModelSlug` answers null when no alias applies, which means "send it verbatim".
  return normalizeModelSlug(trimmed, COMMAND_CODE_PROVIDER) ?? trimmed;
}
