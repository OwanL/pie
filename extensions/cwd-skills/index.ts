/**
 * Stable SDK discovery adapter for the `cwd-skills` extension (B3).
 *
 * The implementation moved to
 * `harness/agent-instructions/skill-discovery/index.ts`; this root entry keeps
 * the stable extension ID and discovery registration. It must remain a thin
 * adapter that delegates to the canonical implementation only.
 */
import discoverCwdSkills from '../../harness/agent-instructions/skill-discovery/index.js';

export default discoverCwdSkills;