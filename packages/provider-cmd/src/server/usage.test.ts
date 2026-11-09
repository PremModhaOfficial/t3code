import { describe, expect, it } from "@effect/vitest";

import { commandCodeTotalsFromUsage, commandCodeUsageFormat } from "./usage.ts";

describe("commandCodeTotalsFromUsage", () => {
  it("treats inputTokens as inclusive of both cache counters", () => {
    expect(
      commandCodeTotalsFromUsage({
        inputTokens: 25_136,
        outputTokens: 177,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 1_000,
      }),
    ).toEqual({
      uncachedInputTokens: 4_136,
      cachedInputTokens: 20_000,
      cacheCreationTokens: 1_000,
      outputTokens: 177,
      reasoningTokens: 0,
    });
  });

  it("never reports a negative uncached remainder", () => {
    const totals = commandCodeTotalsFromUsage({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });

    expect(totals.uncachedInputTokens).toBe(0);
  });

  it("ignores missing counters", () => {
    expect(commandCodeTotalsFromUsage({ outputTokens: 5 })).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    });
  });
});

describe("commandCodeUsageFormat", () => {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "053d225d-3081-4722-86ac-8a3700309d0b",
    timestamp: "2026-09-02T09:27:51.054Z",
    cwd: "/home/prm/dotfiles",
  });

  const message = (overrides?: { id?: string; usage?: Record<string, unknown> }) =>
    JSON.stringify({
      type: "message",
      id: overrides?.id ?? "50b43202",
      timestamp: "2026-09-02T09:28:13.370Z",
      message: { role: "assistant", content: [] },
      usage: overrides?.usage ?? {
        inputTokens: 25_136,
        outputTokens: 177,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0038,
      },
      model: "z-ai/glm-5.3-flash",
    });

  function read(lines: ReadonlyArray<string>) {
    const state = commandCodeUsageFormat.state;
    if (state === undefined) throw new Error("Command Code usage format must carry state.");
    const current = state.initial();
    return lines.flatMap((line) => commandCodeUsageFormat.parseLine(line, current));
  }

  it("takes the session id from the header line", () => {
    const records = read([header, message()]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "commandCode",
      sessionId: "053d225d-3081-4722-86ac-8a3700309d0b",
      model: "z-ai/glm-5.3-flash",
      reportedCostUsd: 0.0038,
      dedupeKey: "053d225d-3081-4722-86ac-8a3700309d0b:50b43202",
    });
    expect(records[0]?.timestampMs).toBe(Date.parse("2026-09-02T09:28:13.370Z"));
  });

  it("skips a message whose header was outside the scanned window", () => {
    expect(read([message()])).toEqual([]);
  });

  it("skips lines with no usage, such as checkpoint sidecars", () => {
    const records = read([
      header,
      JSON.stringify({ id: "4127fd50", turnNumber: 1, files: [] }),
      message(),
    ]);

    expect(records).toHaveLength(1);
  });

  it("skips a zero-token usage record", () => {
    const records = read([
      header,
      message({
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ]);

    expect(records).toEqual([]);
  });
});
