
# Evaluation Plan Summary

The evaluation section must define METRICS up front: correctness, dependency ordering, id uniqueness, and the number of peeks required to reach the final answer. Each metric is scored per run and aggregated across the suite.

Every scenario is compared against a baseline that uses conventional turn-by-turn tool calls. The baseline establishes the reference cost for token usage, latency, and turn count.

Results are reported as deltas against that baseline so that gains from parallelism and handle-based output management remain visible, along with any regressions in protocol discipline.
