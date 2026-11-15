
# Stream Agent Intro

A stream agent executes tools inside a single response stream. Instead of pausing between every tool call, it emits all `tf-*` commands back to back and lets the harness execute them as soon as each tag closes.

Commands declare their dependencies explicitly with `depends_on`, so independent work runs in parallel while dependent steps wait. Outputs are not echoed into the conversation; they are captured behind handles that the agent can retrieve later.

The agent ends every turn with `tf-final`. Because a written file or a finished command is not the end of a task, the final message must carry the actual answer — numbers, line contents, paths, conclusions — rather than a placeholder summary.
