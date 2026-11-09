import {
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";

import type { CommandCodeSettings } from "../settings.ts";
import {
  COMMAND_CODE_DEFAULT_MODEL_SLUG,
  COMMAND_CODE_PROVIDER,
  EMPTY_COMMAND_CODE_CAPABILITIES,
} from "./models.ts";
import { COMMAND_CODE_SUPPORTED_RUNTIME_MODES, makeCommandCodeAcpRuntime } from "./acpSupport.ts";

const COMMAND_CODE_PRESENTATION = {
  displayName: "Command Code",
  badgeLabel: "cmd",
  // Command Code has a native `plan` mode that the shared adapter selects whenever a thread's
  // interaction mode is plan, but the toggle stays hidden because cmd's plan output arrives as
  // plan steps rather than T3's proposed-plan card.
  showInteractionModeToggle: false,
  supportedRuntimeModes: COMMAND_CODE_SUPPORTED_RUNTIME_MODES,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const ACP_INITIALIZE_TIMEOUT_MS = 20_000;

const COMMAND_CODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COMMAND_CODE_DEFAULT_MODEL_SLUG,
    name: "Command Code default",
    isCustom: false,
    capabilities: EMPTY_COMMAND_CODE_CAPABILITIES,
  },
];

function commandCodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = COMMAND_CODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels ?? [],
    EMPTY_COMMAND_CODE_CAPABILITIES,
  );
}

export const buildInitialCommandCodeProviderSnapshot = Effect.fn(
  "CommandCodeProviderStatus.buildInitialCommandCodeProviderSnapshot",
)(function* (settings: CommandCodeSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = commandCodeModelsFromSettings(settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      driver: COMMAND_CODE_PROVIDER,
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Command Code is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    driver: COMMAND_CODE_PROVIDER,
    presentation: COMMAND_CODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Command Code CLI availability...",
    },
  });
});

const runCommandCodeCli = Effect.fn("CommandCodeProviderStatus.runCommandCodeCli")(function* (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "cmd";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export interface CommandCodeStatusOutput {
  readonly authenticated: boolean | null;
  readonly account: string | undefined;
}

/**
 * `cmd status` exits 0 whether or not a session exists, so only its text reports sign-in.
 * An unrecognised message stays unknown rather than being read as signed in.
 */
export function parseCommandCodeStatusOutput(output: string): CommandCodeStatusOutput {
  const authenticated = /authentication verified|authenticated as/i.test(output)
    ? true
    : /not authenticated|not logged in|no account/i.test(output)
      ? false
      : null;
  const account = output.match(/Authenticated as\s+(\S+)/i)?.[1];
  return { authenticated, account };
}

const MODEL_LINE = /^(\S+)\s{2,}(\S.*)$/;
// Ids are either `vendor/model` or a bare family id such as `claude-opus-5-5`.
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/;
// The count banner is the only line before the footer shaped like a row; it carries a `·`.
const MODEL_TABLE_BANNER = "·";
// `cmd --list-models` ends the table here and then prints usage examples that look like rows.
const MODEL_TABLE_FOOTER = /^Pass the full id/i;

/**
 * `cmd --list-models` prints one aligned row per model between section headings, then usage
 * examples that also look like rows. Headings carry no description column, so a row is a bare
 * token followed by two or more spaces and a description.
 */
export function parseCommandCodeModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (MODEL_TABLE_FOOTER.test(line.trim())) break;
    if (line.includes(MODEL_TABLE_BANNER)) continue;
    const match = MODEL_LINE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const slug = match[1].trim();
    if (!MODEL_SLUG.test(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const description = match[2].trim();
    models.push({
      slug,
      name: description.replace(/\s*\(default\)\s*$/i, "").trim() || slug,
      isCustom: false,
      ...(/\(default\)\s*$/i.test(description) ? { isDefault: true } : {}),
      capabilities: EMPTY_COMMAND_CODE_CAPABILITIES,
    });
  }
  return models;
}

const probeCommandCodeModels = Effect.fn("CommandCodeProviderStatus.probeCommandCodeModels")(
  function* (settings: CommandCodeSettings, environment: NodeJS.ProcessEnv) {
    const result = yield* runCommandCodeCli(settings, ["--list-models"], environment).pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    // Only a clean exit is parsed; a failed invocation prints help that must not become models.
    if (
      Result.isFailure(result) ||
      Option.isNone(result.success) ||
      result.success.value.code !== 0
    ) {
      yield* Effect.logWarning("Command Code model listing failed or timed out.", {
        errorTag: Result.isFailure(result)
          ? result.failure._tag
          : Option.isNone(result.success)
            ? "Timeout"
            : `ExitCode${result.success.value.code}`,
      });
      return [];
    }
    return parseCommandCodeModelsOutput(
      `${result.success.value.stdout}\n${result.success.value.stderr}`,
    );
  },
);

const probeCommandCodeStatus = Effect.fn("CommandCodeProviderStatus.probeCommandCodeStatus")(
  function* (settings: CommandCodeSettings, environment: NodeJS.ProcessEnv) {
    const result = yield* runCommandCodeCli(settings, ["status"], environment).pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(result) || Option.isNone(result.success)) {
      yield* Effect.logWarning("Command Code status probe failed or timed out.", {
        errorTag: Result.isFailure(result) ? result.failure._tag : "Timeout",
      });
      return { authenticated: null, account: undefined } satisfies CommandCodeStatusOutput;
    }
    return parseCommandCodeStatusOutput(
      `${result.success.value.stdout}\n${result.success.value.stderr}`,
    );
  },
);

/**
 * Proves the ACP entry point answers without opening a session, so a broken `cmd acp` is reported
 * instead of failing on the first turn. This never calls `authenticate` or `session/new`, so it
 * cannot start MCP servers, run hooks, or open a browser login.
 */
const probeCommandCodeAcp = Effect.fn("CommandCodeProviderStatus.probeCommandCodeAcp")(function* (
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runtime = yield* makeCommandCodeAcpRuntime({
    commandCodeSettings: settings,
    environment,
    cwd: process.cwd(),
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  return yield* runtime.initialize();
}, Effect.scoped);

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        driver: COMMAND_CODE_PROVIDER,
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCommandCodeCli(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        driver: COMMAND_CODE_PROVIDER,
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Command Code CLI (`cmd`) is not installed or not on PATH."
            : "Failed to execute the Command Code CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        driver: COMMAND_CODE_PROVIDER,
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but timed out running `cmd --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Command Code version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      return buildServerProvider({
        driver: COMMAND_CODE_PROVIDER,
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but failed to run.",
        },
      });
    }

    const [status, listedModels, acpExit] = yield* Effect.all(
      [
        probeCommandCodeStatus(settings, environment),
        probeCommandCodeModels(settings, environment),
        probeCommandCodeAcp(settings, environment).pipe(
          Effect.timeoutOption(ACP_INITIALIZE_TIMEOUT_MS),
          Effect.exit,
        ),
      ],
      { concurrency: "unbounded" },
    );

    const acpReady = acpExit._tag === "Success" && Option.isSome(acpExit.value);
    if (!acpReady) {
      yield* Effect.logWarning("Command Code ACP initialize probe failed or timed out.", {
        errorTag: acpExit._tag === "Failure" ? causeErrorTag(acpExit.cause) : "Timeout",
      });
    }

    const models =
      listedModels.length > 0
        ? commandCodeModelsFromSettings(settings.customModels, listedModels)
        : fallbackModels;

    const auth: ServerProviderAuth =
      status.authenticated === true
        ? {
            status: "authenticated",
            type: "cached_token",
            // `cmd status` prints the account name, not an address, so it belongs in the label.
            label: status.account
              ? `Command Code account (${status.account})`
              : "Command Code account",
          }
        : status.authenticated === false
          ? { status: "unauthenticated" }
          : { status: "unknown" };

    // A ready probe replaces the cached model list, so a fallback-only list must not be ready.
    const incompleteMessage = !acpReady
      ? "Command Code CLI is installed but `cmd acp` did not initialize. Turns may fail."
      : listedModels.length === 0
        ? "Command Code CLI did not list any models. Model options may be incomplete."
        : undefined;

    if (auth.status === "unauthenticated") {
      return buildServerProvider({
        driver: COMMAND_CODE_PROVIDER,
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        slashCommands: [COMPACT_SLASH_COMMAND],
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: "Command Code CLI is installed but not signed in. Run `cmd login`.",
        },
      });
    }

    return buildServerProvider({
      driver: COMMAND_CODE_PROVIDER,
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: incompleteMessage ? "warning" : "ready",
        auth,
        ...(incompleteMessage ? { message: incompleteMessage } : {}),
      },
    });
  },
);

export const enrichCommandCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Command Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
