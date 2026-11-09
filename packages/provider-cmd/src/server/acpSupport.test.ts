import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  COMMAND_CODE_SUPPORTED_RUNTIME_MODES,
  commandCodeAcpSpawnInput,
  commandCodeLaunchRuntimeMode,
  commandCodeSessionModeForRuntimeMode,
  runtimeModeForCommandCodeSessionMode,
} from "./acpSupport.ts";
import {
  COMMAND_CODE_DEFAULT_MODEL_SLUG,
  COMMAND_CODE_PROVIDER,
  resolveCommandCodeAcpModelId,
} from "./models.ts";

describe("commandCodeSessionModeForRuntimeMode", () => {
  it("maps every offered runtime mode to Command Code's own mode id", () => {
    expect(
      COMMAND_CODE_SUPPORTED_RUNTIME_MODES.map((mode) => [
        mode,
        commandCodeSessionModeForRuntimeMode(mode),
      ]),
    ).toEqual([
      ["approval-required", "default"],
      ["auto-accept-edits", "auto-accept"],
      ["auto", "dont-ask"],
      ["full-access", "bypass"],
    ]);
  });

  it("round-trips each mode through the reverse lookup", () => {
    for (const mode of COMMAND_CODE_SUPPORTED_RUNTIME_MODES) {
      expect(runtimeModeForCommandCodeSessionMode(commandCodeSessionModeForRuntimeMode(mode))).toBe(
        mode,
      );
    }
  });

  it("reads plan as the supervised level it enforces", () => {
    expect(runtimeModeForCommandCodeSessionMode("plan")).toBe("approval-required");
  });

  it("compares only the mode half of a namespaced mode id", () => {
    expect(runtimeModeForCommandCodeSessionMode("command-code#bypass")).toBe("full-access");
  });

  it("reports an unknown mode as unknown rather than guessing", () => {
    expect(runtimeModeForCommandCodeSessionMode("turbo")).toBeUndefined();
  });
});

describe("commandCodeLaunchRuntimeMode", () => {
  const policy = (
    overrides: Partial<Parameters<typeof commandCodeLaunchRuntimeMode>[0]> = {},
  ): Parameters<typeof commandCodeLaunchRuntimeMode>[0] => ({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
    ...overrides,
  });

  it("follows the runtime mode when no explicit policy is set", () => {
    expect(commandCodeLaunchRuntimeMode(policy())).toBe("full-access");
  });

  it("opens asking when an explicit approval policy is set", () => {
    expect(commandCodeLaunchRuntimeMode(policy({ approvalPolicy: "untrusted" }))).toBe(
      "approval-required",
    );
  });

  it("opens asking when an explicit sandbox policy is set", () => {
    expect(commandCodeLaunchRuntimeMode(policy({ sandboxPolicy: "workspace-write" }))).toBe(
      "approval-required",
    );
  });
});

describe("commandCodeAcpSpawnInput", () => {
  it("runs the documented ACP entry point", () => {
    expect(commandCodeAcpSpawnInput({ binaryPath: "cmd" }, "/work")).toEqual({
      command: "cmd",
      args: ["acp"],
      cwd: "/work",
    });
  });

  it("honours a configured binary path and passes the instance environment", () => {
    expect(
      commandCodeAcpSpawnInput({ binaryPath: "/opt/cmd" }, "/work", { COMMANDCODE_HOME: "/data" }),
    ).toEqual({
      command: "/opt/cmd",
      args: ["acp"],
      cwd: "/work",
      env: { COMMANDCODE_HOME: "/data" },
    });
  });
});

describe("resolveCommandCodeAcpModelId", () => {
  it("uses the shared default sentinel the ACP adapter skips", () => {
    // Any other slug is validated against the session's choices and rejected as unavailable.
    expect(COMMAND_CODE_DEFAULT_MODEL_SLUG).toBe("default");
  });

  it("never sends the default sentinel to the agent", () => {
    expect(resolveCommandCodeAcpModelId(COMMAND_CODE_DEFAULT_MODEL_SLUG)).toBeUndefined();
    expect(resolveCommandCodeAcpModelId("")).toBeUndefined();
    expect(resolveCommandCodeAcpModelId(undefined)).toBeUndefined();
  });

  it("keeps a real vendor model id unchanged", () => {
    expect(resolveCommandCodeAcpModelId("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
  });

  it("is branded with the driver kind", () => {
    expect(COMMAND_CODE_PROVIDER).toBe(ProviderDriverKind.make("command-code"));
  });
});
