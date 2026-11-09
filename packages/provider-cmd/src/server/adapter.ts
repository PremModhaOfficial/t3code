import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import { CommandCodeSettings } from "../settings.ts";
import {
  commandCodeApprovalOptions,
  commandCodeLaunchRuntimeMode,
  commandCodeSessionModeForRuntimeMode,
  makeCommandCodeAcpRuntime,
  runtimeModeForCommandCodeSessionMode,
} from "./acpSupport.ts";
import { COMMAND_CODE_PROVIDER, resolveCommandCodeAcpModelId } from "./models.ts";

export const COMMAND_CODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(COMMAND_CODE_PROVIDER);
const DEFAULT_COMMAND_CODE_SETTINGS = Schema.decodeSync(CommandCodeSettings)({});

/**
 * Every override below is something a live `cmd acp` session advertised (CLI 1.88.5): a `model`
 * config option plus `session/set_model`, `session/set_mode`, `sessionCapabilities.list`,
 * `sessionUpdate: "plan"`, and `mcpCapabilities.http`. Flags the shared adapter already derives
 * from the agent's own capabilities are left alone.
 */
const CommandCodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // `session/set_mode` works, but the shared adapter only sends it from `configureSession`, which
    // re-runs on a model or interaction-mode change and not on a runtime-mode change. Claiming an
    // in-session switch would leave a live session in its old mode, so T3 detaches and respawns
    // instead, and the new session opens under the new mode.
    supportsRuntimeModeSwitchInSession: false,
  },
  streaming: {
    ...AcpProviderCapabilitiesV2.streaming,
    streamsPlanText: true,
  },
  // Command Code enforces its four modes itself; T3's approval answers are not the only guard.
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CommandCodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CommandCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function makeCommandCodeAcpAdapterFlavor(
  options: CommandCodeAdapterV2Options,
): AcpAdapterV2Flavor {
  return {
    driver: COMMAND_CODE_PROVIDER,
    runtimeHarness: "Command Code",
    capabilities: CommandCodeProviderCapabilitiesV2,
    // `session/new` always opens at `default` (Standard), so the mode is chosen with
    // `session/set_mode` and cannot be loosened by argv or a stored config.
    sessionModeForPolicy: (policy) =>
      commandCodeSessionModeForRuntimeMode(commandCodeLaunchRuntimeMode(policy)),
    runtimeModeForSessionMode: runtimeModeForCommandCodeSessionMode,
    approvalOptions: commandCodeApprovalOptions,
    resolveModelId: (selection) => resolveCommandCodeAcpModelId(selection.model),
    // Command Code answers `/compact` natively.
    supportsCompaction: true,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeCommandCodeAcpRuntime({
          ...input,
          commandCodeSettings: options.settings,
          environment: options.environment,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeCommandCodeAdapterV2 = Effect.fn("makeCommandCodeAdapterV2")(function* (
  options: CommandCodeAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCommandCodeAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CommandCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const CommandCodeAdapterV2Driver: ProviderAdapterDriver<
  CommandCodeSettings,
  CommandCodeAdapterV2DriverEnv
> = {
  driverKind: COMMAND_CODE_PROVIDER,
  configSchema: CommandCodeSettings,
  defaultConfig: (): CommandCodeSettings => DEFAULT_COMMAND_CODE_SETTINGS,
  create: Effect.fn("CommandCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CommandCodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeCommandCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: COMMAND_CODE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COMMAND_CODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Command Code ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
