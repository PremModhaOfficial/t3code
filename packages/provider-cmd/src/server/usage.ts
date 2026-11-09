import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import type { CommandCodeSettings } from "../settings.ts";

/** One assistant message in a Command Code transcript, as far as usage accounting reads it. */
const CommandCodeUsageLine = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(Schema.Unknown),
      outputTokens: Schema.optional(Schema.Unknown),
      cacheReadTokens: Schema.optional(Schema.Unknown),
      cacheWriteTokens: Schema.optional(Schema.Unknown),
      costUsd: Schema.optional(Schema.Unknown),
    }),
  ),
});

const decodeUsageLine = Schema.decodeUnknownOption(Schema.fromJsonString(CommandCodeUsageLine));

/**
 * Command Code writes the session id once, on the file's `session` header, and leaves it off every
 * message line. The format therefore carries state from the header to the messages that follow it.
 */
export interface CommandCodeUsageState {
  sessionId: string | null;
}

export const CommandCodeUsageState = Schema.Struct({
  sessionId: Schema.NullOr(Schema.String),
});

/**
 * Command Code reports `inputTokens` inclusive of both cache counters, the same shape Codex and
 * Grok report, so the uncached remainder is what the totals call for.
 */
export function commandCodeTotalsFromUsage(usage: {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
}): UsageTokenTotals {
  const cachedInputTokens = tokenCount(usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  return {
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage.inputTokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Command Code does not split reasoning tokens out of transcript usage.
    reasoningTokens: 0,
  };
}

function reportedCostUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseUsageRecord(line: string, state: CommandCodeUsageState): readonly UsageRecord[] {
  const decoded = decodeUsageLine(line);
  if (decoded._tag === "None") return [];
  const record = decoded.value;

  const sessionId = state.sessionId;
  if (sessionId === null) return [];

  if (record.usage === undefined) return [];
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return [];

  const totals = commandCodeTotalsFromUsage(record.usage);
  if (totalTokens(totals) === 0) return [];

  const model = record.model?.trim();
  if (!model) return [];

  const messageId = record.id?.trim();
  return [
    {
      provider: "commandCode",
      timestampMs,
      model,
      sessionId,
      totals,
      reportedCostUsd: reportedCostUsd(record.usage.costUsd),
      speed: "standard",
      dedupeKey: messageId ? `${sessionId}:${messageId}` : null,
    },
  ];
}

const SessionHeaderLine = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const decodeSessionHeaderLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(SessionHeaderLine),
);

function sessionIdFromHeaderLine(line: string): string | undefined {
  const decoded = decodeSessionHeaderLine(line);
  if (decoded._tag === "None") return undefined;
  if (decoded.value.type !== "session") return undefined;
  const id = decoded.value.id?.trim();
  return id ? id : undefined;
}

export const commandCodeUsageFormat: TranscriptUsageFormat<CommandCodeUsageState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    usage: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      costUsd: true,
    },
  },
  // The header line carries the session id, so it has to survive the marker filter too.
  usageMarkers: ['"usage"', '"type":"session"'],
  parseLine: (line, state) => {
    const headerSessionId = sessionIdFromHeaderLine(line);
    if (headerSessionId !== undefined) {
      state.sessionId = headerSessionId;
      return [];
    }
    return parseUsageRecord(line, state);
  },
  parseProjected: (projected, state) => parseUsageRecord(JSON.stringify(projected), state),
  state: {
    initial: () => ({ sessionId: null }),
    schema: CommandCodeUsageState,
  },
};

export const commandCodeUsageReader: ProviderUsageReader<CommandCodeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "commandCode",
  format: commandCodeUsageFormat,
  directories: Effect.fn("commandCodeUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const home = environment.COMMANDCODE_HOME?.trim() || path.join(homeDirectory, ".commandcode");
    // Every session file carries usage lines; the `*.checkpoints.jsonl` sidecars carry none.
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
