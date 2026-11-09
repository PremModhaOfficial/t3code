# Command Code

T3 Code runs the [Command Code CLI](https://commandcode.ai/) (`cmd`) as an agent, using your own
Command Code account, models, skills, and MCP configuration. It talks to the CLI through the
[Agent Client Protocol](https://agentclientprotocol.com) over `cmd acp`.

## Set Up Command Code

1. Install the Command Code CLI on the machine running the T3 Code server: `npm install -g
   command-code`. See the [Command Code docs](https://commandcode.ai/docs) for other options.
2. Run `cmd login` once in a terminal. The CLI keeps the account session; ACP reuses it.
3. Open **Settings → Providers**, enable Command Code, and refresh it.

If `cmd` is not on the server's `PATH`, set its **Binary path**. Version managers that keep global
npm binaries outside `PATH` are the usual cause.

## Models

The model picker lists the ids `cmd --list-models` reports for your account, including
`vendor/model` ids such as `deepseek/deepseek-v4.1-flash`. New threads start on
**Command Code default**, which keeps whatever model the CLI opens the session with instead of
sending a model id. Changing the model in the picker switches the running session.

Reasoning effort is not listed in `cmd --list-models`, so the picker shows no **Reasoning**
setting. `cmd` advertises its `effort` option when a session opens, and a thread that has run once
can be asked to change it there. A model your account cannot use stops the turn with an error
instead of falling back.

## Permission Modes

Command Code enforces all four modes natively, so T3 Code offers each one and switches the CLI's
own session mode to match:

- **Supervised** asks before anything that changes files or runs commands.
- **Auto-accept edits** applies file edits without asking and still asks for riskier actions.
- **Auto** runs without prompting but keeps Command Code's other safety checks.
- **Full access** bypasses every permission check.

Plan mode is Command Code's own Plan mode. Approvals offer only the choices Command Code sends;
its always-allow choice saves a project grant.

## Steering, Forks and Compaction

- A message you send while Command Code is working is queued. Command Code has no in-place
  steering, so T3 Code interrupts and restarts the turn to deliver it.
- Forking a thread from a message is not available, because Command Code exposes no native fork.
  Forks fall back to T3 Code's portable context handoff.
- `/compact` uses Command Code's own compaction.

## Usage

Command Code writes every session to `~/.commandcode/projects/<project>/<session>.jsonl`. T3 Code
reads those transcripts to fill the usage panel, including the per-message cost Command Code
records. Set `COMMANDCODE_HOME` to move that directory.
