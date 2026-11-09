import { describe } from "@effect/vitest";

import { CommandCodeOrchestratorReplayHarness } from "../Adapters/CommandCodeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Command Code replay fixtures", () => {
  itRunsReplayFixtures("command-code", (input) =>
    runReplayFixture({ ...input, harness: CommandCodeOrchestratorReplayHarness }),
  );
});
