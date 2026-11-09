import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import type { CommandCodeSettings } from "../settings.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { makeCommandCodeAcpRuntime } from "./acpSupport.ts";
import { resolveCommandCodeAcpModelId } from "./models.ts";

const COMMAND_CODE_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Commit messages, PR copy and thread titles run over `cmd acp` instead of `cmd -p`, so the same
 * session setup, auth handling and cancellation the turns use also cover these one-shot prompts.
 */
export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  commandCodeSettings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const random = yield* SecureRandom.SecureRandom;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCommandCodeJson: TextGenerationOperations.Runner = Effect.fn(
    "CommandCodeTextGeneration.runCommandCodeJson",
  )(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;

      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCommandCodeAcpRuntime({
        commandCodeSettings,
        environment,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        const requestedModelId = resolveCommandCodeAcpModelId(modelSelection.model);
        if (requestedModelId !== undefined) {
          yield* runtime.setSessionModel(requestedModelId);
        }
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(COMMAND_CODE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Command Code ACP request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Command Code ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Command Code ACP request was cancelled."
              : "Command Code returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Command Code", trimmed);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Command Code ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "CommandCodeTextGeneration",
    TextGenerationOperations.withoutInvestigation("Command Code", runCommandCodeJson),
  );
});
