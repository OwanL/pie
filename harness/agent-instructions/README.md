# Agent instructions

The SDK loads global context from the agent directory, then ancestor context through the session's working directory. It does not automatically load descendant AGENTS.md files. Main and child guidance in [APPEND_SYSTEM.md](APPEND_SYSTEM.md) and [SUBAGENT_SYSTEM.md](SUBAGENT_SYSTEM.md) tells agents to read applicable deeper guidance before working there, scoped to that subtree.

This context-file behavior is separate from [recursive skill discovery](skill-discovery/README.md), which is unchanged.
