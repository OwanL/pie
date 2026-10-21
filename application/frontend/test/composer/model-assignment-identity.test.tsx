/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from '../helpers/dom';
installDom();
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ModelAssignmentRow } from '../../settings/model-assignment-row';

test('settings assignment retains the full provider-qualified model identity and wraps it', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(<div class="toolbar-settings-menu">
      <ModelAssignmentRow
        label="Summary model"
        entries={[]}
        current={{ provider: 'a-provider-with-a-long-name', model: 'model-with-a-version-suffix-2026-10' }}
        onChange={() => undefined}
        emptyLabel="Default model"
      />
    </div>, container));

    const trigger = container.querySelector<HTMLButtonElement>('.model-picker-trigger')!;
    const identity = 'a-provider-with-a-long-name/model-with-a-version-suffix-2026-10';
    assert.equal(trigger.querySelector('.model-picker-trigger-label')?.textContent, identity);
    await act(async () => {
      trigger.focus();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const tooltipId = trigger.getAttribute('aria-describedby');
    assert.ok(tooltipId);
    assert.equal(document.getElementById(tooltipId)?.textContent, `Select summary model · ${identity}`);

    const css = readFileSync(new URL('../../styles/model-picker.css', import.meta.url), 'utf8');
    const labelRule = css.match(/\.toolbar-settings-menu \.model-picker-trigger-label \{([^}]*)\}/)?.[1] ?? '';
    assert.match(labelRule, /white-space:\s*normal;/);
    assert.match(labelRule, /overflow-wrap:\s*anywhere;/);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
