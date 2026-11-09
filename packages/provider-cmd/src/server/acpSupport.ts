import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderApprovalOption, RuntimeMode } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { CommandCodeSettings } from "../settings.ts";

/** Command Code signs in through its own CLI account, so this is the only advertised method. */
export const COMMAND_CODE_AUTH_METHOD_ID = "command-code-cli";

/**
 * Command Code enforces all four levels natively with its own modes, so T3 offers every mode
 * instead of hiding the ones the agent would have to imitate.
 */
export const COMMAND_CODE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** Command Code's own ACP mode ids, exactly as `session/new` advertises them. */
export const COMMAND_CODE_SESSION_MODES = {
  standard: "default",
  acceptEdits: "auto-accept",
  plan: "plan",
  dontAsk: "dont-ask",
  bypass: "bypass",
} as const;

// `session/new` always opens at `default` (Standard), so argv cannot loosen the start mode and
// `session/set_mode` is the one authoritative switch. Verified against CLI 1.88.5: passing
// `--permission-mode` did not change the mode a new session reported.
export const COMMAND_CODE_SESSION_MODE_FOR_RUNTIME_MODE: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": COMMAND_CODE_SESSION_MODES.standard,
  "auto-accept-edits": COMMAND_CODE_SESSION_MODES.acceptEdits,
  auto: COMMAND_CODE_SESSION_MODES.dontAsk,
  "full-access": COMMAND_CODE_SESSION_MODES.bypass,
};

/** Some agents namespace mode ids as `agent#mode`; compare only the mode half. */
function modeName(modeId: string): string {
  return modeId.slice(modeId.lastIndexOf("#") + 1);
}

export function commandCodeSessionModeForRuntimeMode(runtimeMode: RuntimeMode): string {
  return COMMAND_CODE_SESSION_MODE_FOR_RUNTIME_MODE[runtimeMode];
}

/**
 * An explicit approval or sandbox policy outranks the runtime mode, so the session opens asking
 * rather than in whatever mode the stored setting names. Same guard Grok needs.
 */
export function commandCodeLaunchRuntimeMode(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
    ? policy.runtimeMode
    : "approval-required";
}

/**
 * The runtime mode a native session mode grants. `plan` only narrows, so it reads as the
 * supervised level it enforces.
 */
export function runtimeModeForCommandCodeSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeName(modeId)) {
    case COMMAND_CODE_SESSION_MODES.standard:
    case COMMAND_CODE_SESSION_MODES.plan:
      return "approval-required";
    case COMMAND_CODE_SESSION_MODES.acceptEdits:
      return "auto-accept-edits";
    case COMMAND_CODE_SESSION_MODES.dontAsk:
      return "auto";
    case COMMAND_CODE_SESSION_MODES.bypass:
      return "full-access";
    default:
      return undefined;
  }
}

type CommandCodeAcpRuntimeSettings = Pick<CommandCodeSettings, "binaryPath">;

export interface CommandCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly commandCodeSettings: CommandCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** `cmd acp` is Command Code's documented ACP entry point. */
export function commandCodeAcpSpawnInput(
  settings: CommandCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "cmd",
    args: ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

function commandCodeAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  return {
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeCommandCodeAcpRuntime = Effect.fn(
  "CommandCodeAcpSupport.makeCommandCodeAcpRuntime",
)(function* (
  input: CommandCodeAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const processGroupPlatform = yield* HostProcess.Platform.pipe(Effect.provide(NodeServices.layer));
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: commandCodeAcpSpawnInput(input.commandCodeSettings, input.cwd, input.environment),
      authMethodId: COMMAND_CODE_AUTH_METHOD_ID,
      ...commandCodeAcpRuntimeProcessOwnership(processGroupPlatform),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

/**
 * Command Code asks with the spec's four permission kinds, and its `allow_always` choices persist
 * a project grant. Pass its own option ids through the shared selection unchanged.
 */
export function commandCodeApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind);
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Decline" } as const] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession", label: "Allow all this session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Approve" } as const] : []),
  ];
}
