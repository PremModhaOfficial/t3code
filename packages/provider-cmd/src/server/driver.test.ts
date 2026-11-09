import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import { CommandCodeDriver } from "./driver.ts";
import { checkCommandCodeProviderStatus } from "./status.ts";

/**
 * Command Code is off by default, so most users never install `cmd`. Building the driver must not
 * spawn the CLI or reach the network: a spawn or request here would run on every server start.
 */
const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Building Command Code must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Building Command Code must not spawn a process"),
);

const createDriver = (input: { readonly enabled: boolean; readonly binaryPath?: string }) =>
  CommandCodeDriver.create({
    instanceId: ProviderInstanceId.make("commandCode"),
    displayName: "Command Code test",
    enabled: input.enabled,
    environment: [],
    config: {
      ...CommandCodeDriver.defaultConfig(),
      ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath }),
    },
  });

it.layer(layerTest)("command code startup safety", (it) => {
  it.effect("builds a disabled instance without spawning or calling out", () =>
    Effect.gen(function* () {
      const instance = yield* createDriver({ enabled: false });
      const snapshot = yield* instance.snapshot.getSnapshot;

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
  );

  it.effect("builds an enabled instance without spawning at startup", () =>
    Effect.gen(function* () {
      const instance = yield* createDriver({ enabled: true });

      expect(instance.driverKind).toBe("commandCode");
      expect(instance.enabled).toBe(true);
      expect(instance.orchestrationAdapter).toBeDefined();
      expect(instance.textGeneration).toBeDefined();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
  );

  it.effect("reports a missing binary instead of failing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCommandCodeProviderStatus(
        {
          ...CommandCodeDriver.defaultConfig(),
          enabled: true,
          binaryPath: "cmd-not-installed-xyz",
        },
        { PATH: "/nonexistent-bin" },
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
