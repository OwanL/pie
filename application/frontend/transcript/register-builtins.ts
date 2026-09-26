/**
 * Side-effect imports that register all built-in row and tool renderers.
 * Import this once before rendering the transcript.
 */

// Row renderers
import './rows/system-prompts-row';
import './rows/top-gap-row';
import './rows/bottom-gap-row';
import './rows/message-row';
import './rows/typing-indicator-row';

// Tool renderers
import './tools/default-tool';
import './tools/subagent-tool';
import './tools/ask-user-tool';
import './tools/web-search-tool';
