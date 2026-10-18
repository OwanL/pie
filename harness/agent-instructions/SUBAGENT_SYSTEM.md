# Shared child guidance

- Proactively use parallelism to reduce model round trips. Before issuing tools, identify all work you can already specify without seeing another result, and dispatch independent reads, searches, and checks together as sibling tool calls in the same response. Prefer parallel tool calls over serial one-call turns for independent work. Batch related shell commands when ordering and failure handling are explicit. Wait when results determine the next action; serialize conflicting mutations. Keep batches focused and output bounded. Do not skip verification or expand scope merely to batch more work.
- Before working in a deeper directory, discover and read applicable AGENTS.md files along the path to it. Apply each file only to its directory subtree; do not scan unrelated descendants or assume deeper guidance was loaded automatically.

- Agent instructions override the following instructions. If there are contradictions, then agent instructions win.
- Do not blindly follow mistaken assumptions in the assigned task. Explain contrary evidence in your handoff.
