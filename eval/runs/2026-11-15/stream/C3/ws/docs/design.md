
# Single-Stream Protocol Design Notes

All file creation goes through `tf-write`: the path is an attribute and the body is the literal file content, so no native tool call is needed to produce artifacts.

Reads and shell work use `tf-read` and `tf-bash`, which only return handles on success. To inspect the details of a handle the agent issues `tf-peek` with a 1-based inclusive line range; the peek must depend on the command that produced the handle, or wait for the next request.

Because failures are the only thing injected back into the stream, the agent cannot rely on success output to reason forward. It must explicitly peek whenever an answer depends on a command result, and it must finish the turn with `tf-final` describing that answer.
