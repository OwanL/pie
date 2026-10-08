/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ModelAssignmentRow } from '../../settings/model-assignment-row';
import { SessionTitlesModelAssignment } from '../../settings/settings-menu-session-titles';
import { HistoryCompactionModelAssignment } from '../../settings/settings-menu-history-compaction';
import { DEFAULT_SESSION_TITLES_SETTINGS, DEFAULT_HISTORY_COMPACTION_SETTINGS } from '../../../lib/protocol/index.js';

test('disabled title and compaction assignments link their visible enable guidance without dangling references', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const paint = (enabled: boolean) => render(<>
    <SessionTitlesModelAssignment settings={{ ...DEFAULT_SESSION_TITLES_SETTINGS, enabled }}
      modelEntries={[]} availableModels={[]} onSetSessionTitlesSettings={() => undefined} />
    <HistoryCompactionModelAssignment settings={{ ...DEFAULT_HISTORY_COMPACTION_SETTINGS, enabled,
      summaryModel: { provider: 'provider', id: 'model' } }} availableModels={[]} modelEntries={[]}
      onSetPrefs={() => undefined} />
  </>, container);
  try {
    act(() => paint(false));
    const controls = [...container.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')];
    assert.equal(controls.length, 5);
    for (const control of controls) {
      assert.equal(control.disabled, true);
      const id = control.getAttribute('aria-describedby');
      assert.ok(id);
      assert.match(document.getElementById(id)?.textContent ?? '', /Enable (session titles in Chat|history compaction in Context)/);
    }
    assert.equal(new Set(controls.map((control) => control.getAttribute('aria-describedby'))).size, 2);
    act(() => paint(true));
    for (const control of controls) {
      assert.equal(control.disabled, false);
      assert.equal(control.getAttribute('aria-describedby'), null);
    }
    assert.doesNotMatch(container.textContent ?? '', /Enable session titles|Enable history compaction/);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

function assignmentRow(props: {
  disabled?: boolean;
  ariaDescribedBy?: string;
  onChange?: (value: { provider: string; model: string } | null) => void;
}) {
  return (
    <ModelAssignmentRow
      label="Session titles"
      entries={[]}
      current={{ provider: 'provider', model: 'model' }}
      onChange={props.onChange ?? (() => undefined)}
      emptyLabel="Default model"
      clearable
      disabled={props.disabled}
      ariaDescribedBy={props.ariaDescribedBy}
      thinking={{ value: '', onChange: () => undefined }}
    />
  );
}

test('assignment description is referenced by disabled model, clear, and thinking controls and can be removed', () => {
  const container = document.createElement('div');
  const hint = document.createElement('span');
  hint.id = 'disabled-reason';
  document.body.append(container, hint);
  try {
    act(() => render(assignmentRow({ disabled: true, ariaDescribedBy: hint.id }), container));
    const model = container.querySelector<HTMLButtonElement>('.model-picker-trigger')!;
    const clear = container.querySelector<HTMLButtonElement>('.toolbar-settings-stepper-btn')!;
    const thinking = container.querySelector<HTMLSelectElement>('select')!;
    assert.deepEqual([model, clear, thinking].map((control) => control.getAttribute('aria-describedby')), [hint.id, hint.id, hint.id]);
    assert.ok(model.disabled && clear.disabled && thinking.disabled);

    act(() => render(assignmentRow({ disabled: false }), container));
    assert.deepEqual([model, clear, thinking].map((control) => control.getAttribute('aria-describedby')), [null, null, null]);
    assert.ok(!model.disabled && !clear.disabled && !thinking.disabled);
  } finally {
    act(() => render(null, container));
    container.remove();
    hint.remove();
  }
});

test('assignment description remains alongside the model trigger tooltip without changing state on focus', async () => {
  const container = document.createElement('div');
  const hint = document.createElement('span');
  hint.id = 'available-reason';
  document.body.append(container, hint);
  const changes: unknown[] = [];
  try {
    act(() => render(assignmentRow({ ariaDescribedBy: hint.id, onChange: (value) => changes.push(value) }), container));
    const trigger = container.querySelector<HTMLButtonElement>('.model-picker-trigger')!;
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await act(async () => {
      trigger.focus();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const descriptions = trigger.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    assert.ok(descriptions.includes(hint.id));
    assert.ok(descriptions.some((id) => id !== hint.id), 'visible tooltip adds its own description ID');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(changes, []);
  } finally {
    act(() => render(null, container));
    container.remove();
    hint.remove();
  }
});

test('assignment description remains optional for existing callers', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(assignmentRow({}), container));
    assert.equal(container.querySelector('.model-picker-trigger')?.getAttribute('aria-describedby'), null);
    assert.equal(container.querySelector('.toolbar-settings-stepper-btn')?.getAttribute('aria-describedby'), null);
    assert.equal(container.querySelector('select')?.getAttribute('aria-describedby'), null);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
