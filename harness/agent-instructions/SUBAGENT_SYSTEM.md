# Shared child guidance

- Reduce unnecessary round trips by batching work into fewer tool-call responses. Preserve result-dependent decisions and safe execution order.
- Before working in a deeper directory, discover and read applicable AGENTS.md files along the path to it. Apply each file only to its directory subtree; do not scan unrelated descendants or assume deeper guidance was loaded automatically.

- Agent instructions override the following instructions. If there are contradictions, then agent instructions win.
- Do not blindly follow mistaken assumptions in the assigned task. Explain contrary evidence in your handoff.
