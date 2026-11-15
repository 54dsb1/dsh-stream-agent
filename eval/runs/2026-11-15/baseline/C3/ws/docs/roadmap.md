# Roadmap

- M0: Freeze the scope and record the baseline behaviour of the current harness.
- M1: Specify the single-stream frame format and document all frame types.
- M2: Implement the core stream reader and the ordered event loop.
- M3: Add the `tf-write` tool with atomic per-frame writes.
- M4: Add the `tf-peek` tool with bounded windows and no mutation.
- M5: Wire tool calls into the stream with one result frame per call.
- M6: Add error result frames and recovery on malformed input.
- M7: Build the fixture-driven evaluation scenarios and METRICS reporting.
- M8: Run the first full comparison against the recorded baseline.
- M9: Harden backpressure handling and add streaming diagnostics.
- M10: Publish the design notes, evaluation summary, and a stable release.
