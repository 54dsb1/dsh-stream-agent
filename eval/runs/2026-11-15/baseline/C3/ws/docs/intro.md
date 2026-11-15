# Stream Agent Introduction

The stream agent is a lightweight runtime that consumes a single ordered stream of
events and turns them into agent actions. It reads the stream incrementally, so it
can react to new input as soon as it arrives rather than waiting for a complete
payload. This makes it suitable for interactive sessions where latency matters.

The agent keeps a small amount of state between events and exposes that state to
the tool layer. Tools such as file writers and readers are invoked from within the
stream, which means the agent can inspect and modify the workspace in the middle of
a conversation without any out-of-band coordination. All I/O is funneled through a
single protocol so behaviour stays predictable and auditable.

Because the design avoids branching streams, it is straightforward to reason about
ordering and failure recovery. If an event is malformed the agent surfaces a clear
error and continues with the next event, and any partial work is reported to the
caller. The result is a small, dependable building block that can be embedded in
larger harnesses without hidden coupling.
