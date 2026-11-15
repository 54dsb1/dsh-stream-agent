# Single-Stream Protocol Design Notes

The protocol uses one ordered stream in each direction, carrying typed frames for
prompts, tool calls, tool results, and final answers. Ordering is guaranteed by the
transport, so the protocol itself does not need sequence numbers for correctness;
timestamps are recorded only for diagnostics.

Two tools are central to the design:

- `tf-write` appends a payload to the workspace under the current run directory.
  The write is atomic per frame, and the tool returns the resolved path so the
  caller can verify what was created.
- `tf-peek` returns a bounded window of an existing file without mutating it. It
  is used to confirm that a previous `tf-write` landed and to inspect context
  before a follow-up edit.

Tool calls are synchronous from the agent's point of view: the stream pauses until
`tf-write` or `tf-peek` returns exactly one result frame. Errors are represented as
result frames with a non-zero status rather than as stream resets, which keeps the
protocol simple and lets the agent recover without reconnecting. Backpressure is
handled by the transport; the protocol never buffers an unbounded number of
frames, and a slow consumer simply slows the producer.
