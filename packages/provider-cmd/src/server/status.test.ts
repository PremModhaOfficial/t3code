import { describe, expect, it } from "@effect/vitest";

import { parseCommandCodeModelsOutput, parseCommandCodeStatusOutput } from "./status.ts";

describe("parseCommandCodeModelsOutput", () => {
  it("reads one row per model and stops at the footer", () => {
    const models = parseCommandCodeModelsOutput(
      [
        "Available models  ·  3 models",
        "",
        "Open Source",
        "",
        "deepseek/deepseek-v4.1-flash   V4.1 hybrid-attention reasoning (default)",
        "deepseek/deepseek-v4-flash     fast hybrid-attention reasoning",
        "",
        'Pass the full id, or just the short name after the last "/":',
        "cmd --model moonshotai/kimi-k2.5",
        "Docs:  https://commandcode.ai/docs/reference/cli/models",
      ].join("\n"),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.name).toBe("V4.1 hybrid-attention reasoning");
    expect(models[1]?.isDefault).toBeUndefined();
  });

  it("keeps bare family ids alongside vendor-prefixed ones", () => {
    const models = parseCommandCodeModelsOutput(
      ["Anthropic", "claude-opus-5-5   most intelligent Opus", "gpt-6-astra   flagship"].join("\n"),
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
  });

  it("keeps an id that carries a tag suffix", () => {
    const models = parseCommandCodeModelsOutput("stealth/glyph-cluster:free   free tier");

    expect(models.map((model) => model.slug)).toEqual(["stealth/glyph-cluster:free"]);
  });

  it("ignores section headings and the count banner", () => {
    const models = parseCommandCodeModelsOutput(
      ["Available models  ·  1 models", "Open Source", "xai/grok-4.6   real row"].join("\n"),
    );

    expect(models.map((model) => model.slug)).toEqual(["xai/grok-4.6"]);
  });

  it("deduplicates a slug printed twice", () => {
    const models = parseCommandCodeModelsOutput(
      ["xai/grok-4.6   first", "xai/grok-4.6   second"].join("\n"),
    );

    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("first");
  });
});

describe("parseCommandCodeStatusOutput", () => {
  it("reads a verified account", () => {
    expect(
      parseCommandCodeStatusOutput(
        [
          "- Checking authentication status...",
          "✔ Authentication verified",
          "✔ Authenticated as PremModhaOfficial",
        ].join("\n"),
      ),
    ).toEqual({ authenticated: true, account: "PremModhaOfficial" });
  });

  it("reads a signed-out account", () => {
    expect(parseCommandCodeStatusOutput("You are not authenticated. Run `cmd login`.")).toEqual({
      authenticated: false,
      account: undefined,
    });
  });

  it("stays unknown rather than claiming a sign-in", () => {
    expect(parseCommandCodeStatusOutput("")).toEqual({
      authenticated: null,
      account: undefined,
    });
  });
});
