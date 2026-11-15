# Evaluation Plan Summary

The evaluation plan defines a compact set of metrics, tracked under METRICS, that
measure both task success and protocol efficiency. Each run records outcomes for
every scenario so that results can be compared across configurations without
re-deriving numbers by hand.

Primary METRICS include task completion rate, number of tool calls per task, total
tokens consumed, wall-clock latency, and recovery rate after malformed input. The
baseline is the current single-stream implementation with default settings; every
change is compared against that baseline using the same scenarios and machine.

Runs are deterministic where possible: fixtures are fixed, and any randomness is
seeded and recorded alongside the results. A change is considered an improvement
only if it improves completion rate or latency without regressing token usage
beyond the agreed tolerance. Results are archived per run so the baseline can be
recomputed whenever the harness is updated.
