/**
 * Subagent tool renderer registration.
 *
 * The heavy SubagentBlock / SubagentSingleBlock components stay in
 * tool-call-item.tsx for now (they're tightly coupled). This module
 * just registers 'subagent' so the registry dispatch finds it.
 */

import { registerToolRenderer } from '../registry';
import { SubagentToolRenderer } from '../tool-call-item';

registerToolRenderer('subagent', SubagentToolRenderer);
