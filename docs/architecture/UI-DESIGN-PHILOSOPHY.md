# Pie UI design philosophy

The VS Code sidebar is Pie's primary design surface. The browser uses the same UI.

- **Transparent:** show tool calls with expandable inputs and results, not paraphrases. Keep the active model and reasoning level visible.
- **Responsive:** avoid unnecessary rendering and animations that delay interaction. Preserve the user's scroll position; follow new output when already at the bottom.
- **Low noise:** show what matters for the current task. Prefer unobtrusive status indicators; reserve banners for genuine errors. Avoid confirmation dialogs for low-risk actions when undo is practical.
- **Clear controls:** distinguish primary actions from secondary controls and passive content. Give ambiguous or icon-only controls tooltips, but never hide essential information behind hover. Use plain, direct wording.
- **Keyboard-friendly:** support natural Tab navigation, Enter to send, and Shift+Enter for a newline. Make focus and interactive states visible.
- **Native to VS Code:** use its theme colours, typography, and interaction conventions, with compact, consistent spacing. Support light and dark themes in both renderers.

For the build/watch/reload workflow, see [GUI development](../operations/GUI-DEVELOPMENT.md).
