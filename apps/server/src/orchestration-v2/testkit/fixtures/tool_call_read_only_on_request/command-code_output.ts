import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoAcpClientFileOrTerminalRequests,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

const PROBE_FILE = ".codex-probe-write-action.txt";
const PROBE_CONTENT = "codex app-server approval fixture";

/**
 * Command Code completes the write with a status message instead of repeating the diff, so the
 * proposed text is asserted from the transcript rather than the card's `diffStr`.
 */
export function assertToolCallReadOnlyOnRequestCommandCodeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);
  assertNoAcpClientFileOrTerminalRequests(transcript);

  assert.lengthOf(projection.runtimeRequests, 1, "the write must ask for permission exactly once");
  const request = projection.runtimeRequests[0];
  assert.equal(request?.status, "resolved");
  assert.equal(request?.decision, "accept");
  assert.equal(request?.kind, "file-change");

  const approvals = projection.turnItems.flatMap((item) =>
    item.type === "approval_request" ? [item] : [],
  );
  assert.deepEqual(
    approvals.map((item) => [item.requestId, item.requestKind]),
    [[request?.id, request?.kind]],
    "the approval card must show the resolved request",
  );

  const writes = projection.turnItems.filter(
    (item) => item.type === "file_change" && item.fileName.endsWith(PROBE_FILE),
  );
  assert.deepEqual(
    writes.map((item) => item.status),
    ["completed"],
    "the approved write must complete",
  );

  const permissionKinds = transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const frame = entry.frame as {
      method?: unknown;
      params?: { toolCall?: { kind?: unknown } };
    };
    return frame.method === "session/request_permission" ? [frame.params?.toolCall?.kind] : [];
  });
  assert.deepEqual(permissionKinds, ["edit"], "Command Code must ask T3 before its own write");

  const answers = transcript.entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound") return [];
    const frame = entry.frame as {
      method?: unknown;
      result?: { outcome?: { outcome?: unknown; optionId?: unknown } };
    };
    return frame.method === "session/request_permission"
      ? [[frame.result?.outcome?.outcome, frame.result?.outcome?.optionId]]
      : [];
  });
  assert.deepEqual(answers, [["selected", "allow_once"]], "T3 must answer the prompt once");

  const proposed = transcript.entries.flatMap((entry) => {
    const update =
      entry.type === "emit_inbound"
        ? (entry.frame as { params?: { update?: Record<string, unknown> } }).params?.update
        : undefined;
    const content = update?.content;
    if (update?.sessionUpdate !== "tool_call" || !Array.isArray(content)) return [];
    return content.flatMap((block) => {
      const diff = block as { type?: unknown; path?: unknown; newText?: unknown };
      return diff.type === "diff" && typeof diff.path === "string" && diff.path.endsWith(PROBE_FILE)
        ? [diff.newText]
        : [];
    });
  });
  assert.deepEqual(proposed, [PROBE_CONTENT], "the announced diff must carry the requested text");
}
