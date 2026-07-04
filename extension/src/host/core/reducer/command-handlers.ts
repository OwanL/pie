import type { ArchState } from '../arch-state.js';
import type { Command } from '../commands.js';
import type { ReducerResult } from './helpers.js';

// Per-domain command handlers. Each `case` in `handleCommand` delegates to a
// pure `(state, cmd) → ReducerResult` handler in its domain file, mirroring
// the folder's event-handler split (misc-handlers.ts, session-handlers.ts,
// set-model-handlers.ts, streaming-handlers.ts, ui-handlers.ts,
// optimistic-handlers.ts, result-handlers.ts).
import {
  handleInterrupt,
  handleSend,
  handleEdit,
  handleTruncateAfter,
  handleSetOutcomeDialog,
  handleDismissNotice,
  handleRespondExtensionUI,
  handleSetPrefs,
  handleStartNewTask,
  handleContinueTask,
  handleRecordOutcome,
  handleSetPruningSettings,
  handleSetProxySettings,
} from './command-misc-handlers.js';
import {
  handleOpenSession,
  handleCreateSession,
  handleSelectSession,
  handleCloseSession,
  handleDuplicateSession,
  handleMoveSessionTab,
} from './command-session-handlers.js';
import {
  handleCloseTab,
  handlePersistTabs,
  handleTogglePinTab,
} from './command-tab-handlers.js';
import {
  handleHydrateModel,
  handleSetModel,
} from './command-model-handlers.js';
import {
  handleLoadOlderTranscript,
  handleLoadNewerTranscript,
  handleJumpToLatestTranscript,
} from './command-transcript-handlers.js';
import {
  handleAddComposerInput,
  handleRemoveComposerInput,
  handleSetComposerDraft,
  handleSetEditingMessage,
} from './command-composer-handlers.js';
import {
  handleOpenFile,
  handleOpenFileInEditor,
  handleOpenFileDiff,
  handleRevertFile,
  handleAddFilesystemPaths,
  handleSetFileChangesExpanded,
  handleSetFileRead,
} from './command-file-handlers.js';

export function handleCommand(state: ArchState, cmd: Command): ReducerResult {
  switch (cmd.kind) {
    case 'Interrupt': {
      return handleInterrupt(state, cmd);
    }

    case 'Send': {
      return handleSend(state, cmd);
    }

    case 'Edit': {
      return handleEdit(state, cmd);
    }

    case 'TruncateAfter': {
      return handleTruncateAfter(state, cmd);
    }

    case 'OpenSession': {
      return handleOpenSession(state, cmd);
    }

    case 'CreateSession': {
      return handleCreateSession(state, cmd);
    }

    case 'HydrateModel': {
      return handleHydrateModel(state, cmd);
    }

    case 'SetModel': {
      return handleSetModel(state, cmd);
    }

    case 'SetPrefs': {
      return handleSetPrefs(state, cmd);
    }

    case 'SelectSession': {
      return handleSelectSession(state, cmd);
    }

    case 'CloseTab': {
      return handleCloseTab(state, cmd);
    }

    case 'OpenFileDiff': {
      return handleOpenFileDiff(state, cmd);
    }

    case 'RevertFile': {
      return handleRevertFile(state, cmd);
    }

    case 'SetFileChangesExpanded': {
      return handleSetFileChangesExpanded(state, cmd);
    }

    case 'SetFileRead': {
      return handleSetFileRead(state, cmd);
    }

    case 'CloseSession': {
      return handleCloseSession(state, cmd);
    }

    case 'PersistTabs': {
      return handlePersistTabs(state, cmd);
    }

    case 'AddComposerInput': {
      return handleAddComposerInput(state, cmd);
    }

    case 'RemoveComposerInput': {
      return handleRemoveComposerInput(state, cmd);
    }

    case 'SetComposerDraft': {
      return handleSetComposerDraft(state, cmd);
    }

    case 'SetEditingMessage': {
      return handleSetEditingMessage(state, cmd);
    }

    case 'SetOutcomeDialog': {
      return handleSetOutcomeDialog(state, cmd);
    }

    case 'DismissNotice': {
      return handleDismissNotice(state, cmd);
    }

    case 'RespondExtensionUI': {
      return handleRespondExtensionUI(state, cmd);
    }

    case 'AddFilesystemPaths': {
      return handleAddFilesystemPaths(state, cmd);
    }

    case 'LoadOlderTranscript': {
      return handleLoadOlderTranscript(state, cmd);
    }

    case 'LoadNewerTranscript': {
      return handleLoadNewerTranscript(state, cmd);
    }

    case 'JumpToLatestTranscript': {
      return handleJumpToLatestTranscript(state, cmd);
    }

    case 'RecordOutcome': {
      return handleRecordOutcome(state, cmd);
    }

    case 'StartNewTask': {
      return handleStartNewTask(state, cmd);
    }

    case 'ContinueTask': {
      return handleContinueTask(state, cmd);
    }

    case 'OpenFileInEditor': {
      return handleOpenFileInEditor(state, cmd);
    }

    case 'OpenFile': {
      return handleOpenFile(state, cmd);
    }

    case 'SetPruningSettings': {
      return handleSetPruningSettings(state, cmd);
    }

    case 'SetProxySettings': {
      return handleSetProxySettings(state, cmd);
    }

    case 'DuplicateSession': {
      return handleDuplicateSession(state, cmd);
    }

    case 'MoveSessionTab': {
      return handleMoveSessionTab(state, cmd);
    }

    case 'TogglePinTab': {
      return handleTogglePinTab(state, cmd);
    }

    default: {
      // Exhaustiveness: the switch is total over `Command`. The `never`
      // assignment makes an unhandled Command variant a compile-time error.
      const _exhaustive: never = cmd;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `handleCommand: unhandled command kind (type system bypassed?): ${(cmd as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}
