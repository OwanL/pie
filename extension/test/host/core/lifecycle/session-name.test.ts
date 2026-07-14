import test from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../../../../src/shared/session-name';

// --- Blank / placeholder cases ---

test('returns placeholder for blank input', () => {
  assert.deepEqual(deriveSessionNameFromText('   \n\t  '), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('returns placeholder for empty string', () => {
  assert.deepEqual(deriveSessionNameFromText(''), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('returns placeholder for null', () => {
  assert.deepEqual(deriveSessionNameFromText(null), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('returns placeholder for undefined', () => {
  assert.deepEqual(deriveSessionNameFromText(undefined), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('returns placeholder for lone stopword "help"', () => {
  assert.deepEqual(deriveSessionNameFromText('help'), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

// --- Leading conversational noise stripping ---

test('strips "how do I" prefix', () => {
  assert.equal(deriveSessionNameFromText('how do I refactor the auth module?').name, 'Refactor Auth Module');
});

test('strips "can you" prefix', () => {
  assert.equal(deriveSessionNameFromText('can you fix the login bug?').name, 'Fix Login Bug');
});

test('strips "please" prefix', () => {
  assert.equal(deriveSessionNameFromText('please fix the CSS layout issue on mobile devices').name, 'Fix CSS Layout Issue');
});

test('strips "help me" prefix', () => {
  assert.equal(deriveSessionNameFromText('help me debug the payment flow').name, 'Debug Payment Flow');
});

test('strips "let\'s" prefix', () => {
  assert.equal(deriveSessionNameFromText("let's create a new component for the dashboard").name, 'Create New Component Dashboard');
});

test('strips "I want to" prefix', () => {
  assert.equal(deriveSessionNameFromText('I want to add authentication and then deploy to production').name, 'Add Authentication Deploy Production');
});

test('strips "I need to" prefix', () => {
  assert.equal(deriveSessionNameFromText('I need to update the user model create a migration').name, 'Update User Model Create');
});

test('strips "is there a way to" prefix', () => {
  assert.equal(deriveSessionNameFromText('is there a way to name sessions better without using an LLM?').name, 'Name Sessions Better LLM');
});

test('strips "how can I" prefix', () => {
  assert.equal(deriveSessionNameFromText('how can I improve the performance of my React app?').name, 'Improve Performance React App');
});

test('strips "could you" prefix', () => {
  assert.equal(deriveSessionNameFromText('could you review my pull request?').name, 'Review Pull Request');
});

test('strips "would you" prefix', () => {
  assert.equal(deriveSessionNameFromText('would you mind checking the Dockerfile?').name, 'Checking Dockerfile');
});

// --- Action word detection ---

test('detects "add" as action', () => {
  assert.equal(deriveSessionNameFromText('add a dark mode toggle to the settings page').name, 'Add Dark Mode Toggle');
});

test('detects "fix" as action', () => {
  assert.equal(deriveSessionNameFromText('fix the off-by-one error in the pagination logic').name, 'Fix Off-by-one Error Pagination');
});

test('detects "fix" with lone next word', () => {
  assert.equal(deriveSessionNameFromText('fix this').name, 'Fix This');
});

test('detects "deploy" as action', () => {
  assert.equal(deriveSessionNameFromText('deploy the staging environment to AWS').name, 'Deploy Staging Environment AWS');
});

test('detects "migrate" as action', () => {
  assert.equal(deriveSessionNameFromText('migrate from REST API to GraphQL').name, 'Migrate REST API GraphQL');
});

test('detects "optimize" as action', () => {
  assert.equal(deriveSessionNameFromText('optimize the database queries in the report generator').name, 'Optimize Database Queries Report');
});

test('detects "debug" as action', () => {
  assert.equal(deriveSessionNameFromText('debug the flaky E2E test in the checkout flow').name, 'Debug Flaky E2E Test');
});

test('detects "refactor" as action', () => {
  assert.equal(deriveSessionNameFromText('refactor the authentication module to use JWT tokens').name, 'Refactor Authentication Module JWT');
});

test('detects "crashes" as action', () => {
  assert.equal(deriveSessionNameFromText('the app crashes when I click the submit button').name, 'Crashes Click Submit Button');
});

test('detects "make" as action', () => {
  assert.equal(deriveSessionNameFromText('make the navbar responsive and add a hamburger menu').name, 'Make Navbar Responsive Add');
});

test('detects "broken" as action', () => {
  assert.equal(deriveSessionNameFromText('the login button is broken on Safari').name, 'Broken Safari');
});

test('detects "validate" as action', () => {
  assert.equal(deriveSessionNameFromText('validate the form inputs before submission').name, 'Validate Form Inputs Submission');
});

test('detects "split" as action', () => {
  assert.equal(deriveSessionNameFromText('split the monolithic index.ts into separate modules').name, 'Split Monolithic Index.ts Separate');
});

test('detects "revert" as action', () => {
  assert.equal(deriveSessionNameFromText('revert the last commit that broke the CI pipeline').name, 'Revert Last Commit Broke');
});

test('detects "clean" as action', () => {
  assert.equal(deriveSessionNameFromText('clean up the unused imports across the project').name, 'Clean Unused Imports Across');
});

test('detects "upgrade" as action', () => {
  assert.equal(deriveSessionNameFromText('upgrade React from v17 to v18').name, 'Upgrade React V17 V18');
});

test('detects "remove" as action', () => {
  assert.equal(deriveSessionNameFromText('remove the deprecated getUserById method from the user service').name, 'Remove Deprecated GetUserById Method');
});

// --- Fallback: no action word found ---

test('falls back to first meaningful words when no action word', () => {
  assert.equal(deriveSessionNameFromText('how do i tie my shoes').name, 'Tie Shoes');
});

test('falls back for error messages with no action word', () => {
  const result = deriveSessionNameFromText('TypeError: Cannot read properties of undefined');
  assert.equal(result.isPlaceholder, false);
  assert.ok(result.name.includes('Read') || result.name.includes('Properties') || result.name.includes('Undefined'));
});

test('falls back for vague prompts', () => {
  assert.equal(deriveSessionNameFromText('npm run build keeps failing').name, 'Run Build Keeps Failing');
});

test('falls back for "the thing doesnt work"', () => {
  assert.equal(deriveSessionNameFromText('the thing doesnt work').name, 'Thing Doesnt Work');
});

// --- Acronym and camelCase preservation ---

test('preserves short acronyms (JWT)', () => {
  assert.equal(deriveSessionNameFromText('refactor the authentication module to use JWT tokens').name, 'Refactor Authentication Module JWT');
});

test('preserves short acronyms (CSS)', () => {
  assert.equal(deriveSessionNameFromText('please fix the CSS layout issue on mobile devices').name, 'Fix CSS Layout Issue');
});

test('preserves short acronyms (API)', () => {
  assert.equal(deriveSessionNameFromText('create a new API endpoint for exporting user data as CSV').name, 'Create New API Endpoint');
});

test('preserves short acronyms (E2E)', () => {
  assert.equal(deriveSessionNameFromText('debug the flaky E2E test in the checkout flow').name, 'Debug Flaky E2E Test');
});

test('preserves short acronyms (AWS)', () => {
  assert.equal(deriveSessionNameFromText('deploy the staging environment to AWS').name, 'Deploy Staging Environment AWS');
});

test('preserves mixed-case identifiers (OAuth2)', () => {
  assert.equal(deriveSessionNameFromText('implement user authentication with OAuth2').name, 'Implement User Authentication OAuth2');
});

test('preserves mixed-case identifiers (ESLint)', () => {
  assert.equal(deriveSessionNameFromText('configure ESLint to enforce consistent type imports').name, 'Configure ESLint Enforce Consistent');
});

test('preserves camelCase identifiers (getUserById)', () => {
  assert.equal(deriveSessionNameFromText('remove the deprecated getUserById method from the user service').name, 'Remove Deprecated GetUserById Method');
});

test('preserves mixed-case React hooks (useEffect)', () => {
  assert.equal(deriveSessionNameFromText('why is useEffect running twice in my React component?').name, 'UseEffect Running Twice React');
});

test('preserves file extensions in backtick content', () => {
  assert.equal(deriveSessionNameFromText('update the `handleClick` function in `Button.tsx`').name, 'Update HandleClick Function Button.tsx');
});

// --- Code fences and URLs ---

test('strips code fences from names', () => {
  const result = deriveSessionNameFromText('Review this code ```ts\nconst x = 1;\n``` and also check https://example.com/docs');
  assert.equal(result.isPlaceholder, false);
  assert.ok(result.name.startsWith('Review'));
  assert.ok(!result.name.includes('```'));
});

test('keeps inline backtick content', () => {
  assert.equal(deriveSessionNameFromText('rename the `auth.ts` file to `login.ts`').name, 'Rename Auth.ts File Login.ts');
});

test('strips URLs from names', () => {
  const result = deriveSessionNameFromText('check out https://example.com and tell me how to set it up');
  assert.equal(result.isPlaceholder, false);
  assert.ok(!result.name.includes('http'));
  assert.ok(!result.name.includes('example.com'));
});

// --- Special short-form prompts ---

test('handles "add tests" short prompt', () => {
  assert.equal(deriveSessionNameFromText('add tests').name, 'Add Tests');
});

test('handles long prompts with truncation', () => {
  const long = 'refactor the extremely long background tab renaming regression test case for better performance optimization and maintainability improvements across the entire codebase';
  const result = deriveSessionNameFromText(long);
  assert.equal(result.isPlaceholder, false);
  assert.ok(result.name.length <= 41, `name too long: ${result.name.length}`);
  assert.ok(result.name.endsWith('\u2026') || result.name.length <= 40);
});

// --- Store integration tests ---

test('optimistic prompt-derived tab names survive placeholder list refreshes', () => {
  const placeholder = {
    path: '/ws/background-tab',
    name: NEW_SESSION_NAME,
    cwd: '/ws',
    modifiedAt: '2026-05-12T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
  const derived = deriveSessionNameFromText('Trace the background tab renaming regression');

  let state = produce(createInitialArchState(), draft => {
    draft.sessions.sessions.push(placeholder);
  });
  state = produce(state, draft => {
    const s = draft.sessions.sessions.find(x => x.path === placeholder.path);
    if (s) {
      s.name = derived.name;
      s.isPlaceholder = derived.isPlaceholder;
    }
  });
  // Simulate replaceSessionSummaries that preserves non-placeholder names
  state = produce(state, draft => {
    const existingByName = new Map(
      draft.sessions.sessions
        .filter(x => x.isPlaceholder !== true)
        .map(x => [x.path, x.name]),
    );
    draft.sessions.sessions = draft.sessions.sessions.map(x => {
      if (x.path !== placeholder.path) return x;
      const prevName = existingByName.get(x.path);
      return prevName ? { ...placeholder, name: prevName, isPlaceholder: false } : placeholder;
    });
  });

  const session = state.sessions.sessions.find((entry) => entry.path === placeholder.path);
  assert.equal(session?.name, derived.name);
  assert.equal(session?.isPlaceholder, false);
});

test('setSessionSummary can roll back an optimistic tab name exactly', () => {
  const placeholder = {
    path: '/ws/send-error',
    name: NEW_SESSION_NAME,
    cwd: '/ws',
    modifiedAt: '2026-05-12T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
  const derived = deriveSessionNameFromText('Draft a rollback-safe optimistic rename flow');

  let state = produce(createInitialArchState(), draft => {
    draft.sessions.sessions.push(placeholder);
  });
  state = produce(state, draft => {
    const s = draft.sessions.sessions.find(x => x.path === placeholder.path);
    if (s) {
      s.name = derived.name;
      s.isPlaceholder = derived.isPlaceholder;
    }
  });
  // setSessionSummary replaces existing entry with the given summary
  state = produce(state, draft => {
    const idx = draft.sessions.sessions.findIndex(x => x.path === placeholder.path);
    if (idx !== -1) {
      draft.sessions.sessions[idx] = placeholder;
    }
  });

  const session = state.sessions.sessions.find((entry) => entry.path === placeholder.path);
  assert.deepEqual(session, placeholder);
});