/**
 * Rendering-contract tests for RunOutcomeDialog (extension/src/webview/panel/
 * run-outcome-dialog.tsx).
 *
 * The dialog is the modal that records a run's resolution + 1–5 satisfaction
 * rating. Contracts covered:
 *  - SSR structure: backdrop, role=dialog/aria-modal/aria-labelledby, title,
 *    rating radiogroup (5 radios, aria-checked, hints), resolution radiogroup
 *    (3 radios, labels + descriptions), Save disabled until a rating is picked.
 *  - Interactive: picking a rating enables Save and submits the right payload;
 *    picking a resolution changes the submitted payload; Escape and backdrop
 *    click cancel; Enter submits once a rating is chosen.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';

import { installDom } from '../../_helpers/dom';
installDom();

import { act } from 'preact/test-utils';
import { RunOutcomeDialog } from '../../../src/webview/panel/run-outcome-dialog';
import type { RunOutcome } from '../../../src/shared/protocol';

const noop = () => undefined;

// ── SSR structure contracts ────────────────────────────────────────────────

test('RunOutcomeDialog SSR: backdrop + dialog a11y shell', () => {
  const html = renderToString(h(RunOutcomeDialog, { sessionLabel: 'Fix bug', onCancel: noop, onSubmit: noop }));
  // Backdrop wraps the dialog; clicking only the backdrop (target===currentTarget) cancels.
  assert.match(html, /<div class="run-outcome-backdrop"/);
  // Dialog is a labelled modal dialog.
  assert.match(html, /<div[^>]*class="run-outcome-dialog"[^>]*role="dialog" aria-modal="true" aria-labelledby="run-outcome-title"/);
  assert.match(html, /tabindex="-1"/);
});

test('RunOutcomeDialog SSR: title interpolates the session label and carries the eyebrow', () => {
  const html = renderToString(h(RunOutcomeDialog, { sessionLabel: 'Refactor tests', onCancel: noop, onSubmit: noop }));
  assert.match(html, /<div class="run-outcome-eyebrow">Run analytics<\/div>/);
  // Preact renders the embedded quotes as HTML entities.
  assert.match(html, /<h2 id="run-outcome-title" class="run-outcome-title">Mark &quot;Refactor tests&quot; done<\/h2>/);
});

test('RunOutcomeDialog SSR: rating grid renders 5 radios with hints; none selected by default', () => {
  const html = renderToString(h(RunOutcomeDialog, { sessionLabel: 'S', onCancel: noop, onSubmit: noop }));
  assert.match(html, /<div class="run-outcome-rating-grid" role="radiogroup" aria-label="Run rating"/);
  // Five rating buttons, each a radio.
  const ratingButtons = html.match(/<button[^>]*class="run-outcome-rating r\d[^"]*"[^>]*role="radio"/g) ?? [];
  assert.equal(ratingButtons.length, 5);
  // Hints are rendered (1=Set back … 5=Exceptional).
  assert.match(html, /<span class="run-outcome-rating-hint">Set back<\/span>/);
  assert.match(html, /<span class="run-outcome-rating-hint">Poor<\/span>/);
  assert.match(html, /<span class="run-outcome-rating-hint">Average<\/span>/);
  assert.match(html, /<span class="run-outcome-rating-hint">Good<\/span>/);
  assert.match(html, /<span class="run-outcome-rating-hint">Exceptional<\/span>/);
  // Value + /5 scale rendered for each.
  assert.match(html, /<span class="run-outcome-rating-value">3<span class="run-outcome-rating-scale">\/5<\/span><\/span>/);
  // Default state: no rating selected → no rating button is checked or selected.
  // (Scope to the rating grid so the resolution list's default selection isn't a false positive.)
  const ratingGrid = html.match(/<div class="run-outcome-rating-grid"[\s\S]*?<\/div><\/div>/)![0];
  assert.doesNotMatch(ratingGrid, /aria-checked="true"/);
  assert.doesNotMatch(ratingGrid, /run-outcome-rating r\d selected/);
});

test('RunOutcomeDialog SSR: resolution list renders 3 options; resolved selected by default', () => {
  const html = renderToString(h(RunOutcomeDialog, { sessionLabel: 'S', onCancel: noop, onSubmit: noop }));
  assert.match(html, /<div class="run-outcome-resolution-list" role="radiogroup" aria-label="Run resolution"/);
  const resButtons = html.match(/<button[^>]*class="run-outcome-resolution[^"]*"[^>]*role="radio"/g) ?? [];
  assert.equal(resButtons.length, 3);
  // Labels + descriptions for each option.
  assert.match(html, /<span class="run-outcome-resolution-label">Resolved<\/span>/);
  assert.match(html, /<span class="run-outcome-resolution-description">Completed successfully\.<\/span>/);
  assert.match(html, /<span class="run-outcome-resolution-label">Partially resolved<\/span>/);
  assert.match(html, /<span class="run-outcome-resolution-description">Progress made, follow-up still needed\.<\/span>/);
  assert.match(html, /<span class="run-outcome-resolution-label">Unresolved<\/span>/);
  assert.match(html, /<span class="run-outcome-resolution-description">Did not land in a usable state\.<\/span>/);
  // Default resolution is 'resolved' → exactly one selected radio.
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.match(html, /class="run-outcome-resolution selected"[^>]*aria-checked="true"/);
});

test('RunOutcomeDialog SSR: Save is disabled until a rating is chosen; Cancel is the secondary action', () => {
  const html = renderToString(h(RunOutcomeDialog, { sessionLabel: 'S', onCancel: noop, onSubmit: noop }));
  assert.match(html, /<button class="action-btn secondary"[^>]*data-cancel-button[^>]*>Cancel<\/button>/);
  assert.match(html, /<button class="action-btn primary"[^>]*disabled[^>]*>Save outcome<\/button>/);
});

// ── Interactive contracts ───────────────────────────────────────────────────

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function renderDialog(props: { onCancel?: () => void; onSubmit?: (o: RunOutcome) => void } = {}) {
  const onCancel = props.onCancel ?? noop;
  const onSubmit = props.onSubmit ?? noop;
  act(() => {
    render(h(RunOutcomeDialog, { sessionLabel: 'Session A', onCancel, onSubmit }), container);
  });
}

test('RunOutcomeDialog: selecting a rating enables Save and submits the chosen satisfaction', () => {
  const submitted: RunOutcome[] = [];
  renderDialog({ onSubmit: (o) => submitted.push(o) });

  // Initially disabled.
  const saveBefore = container.querySelector('button.action-btn.primary') as HTMLButtonElement;
  assert.ok(saveBefore.disabled, 'Save disabled before a rating is picked');

  // Click rating 4.
  act(() => {
    (container.querySelector('button.run-outcome-rating.r4') as HTMLButtonElement).click();
  });

  // r4 is now selected (aria-checked) and Save is enabled.
  const r4 = container.querySelector('button.run-outcome-rating.r4') as HTMLButtonElement;
  assert.equal(r4.getAttribute('aria-checked'), 'true');
  assert.equal((container.querySelectorAll('button.run-outcome-rating[aria-checked="true"]') ?? []).length, 1);
  const saveAfter = container.querySelector('button.action-btn.primary') as HTMLButtonElement;
  assert.ok(!saveAfter.disabled, 'Save enabled after picking a rating');

  act(() => { saveAfter.click(); });
  assert.deepEqual(submitted, [{ resolution: 'resolved', satisfaction: 4 }]);
});

test('RunOutcomeDialog: selecting a resolution changes the submitted payload', () => {
  const submitted: RunOutcome[] = [];
  renderDialog({ onSubmit: (o) => submitted.push(o) });

  act(() => {
    (container.querySelector('button.run-outcome-rating.r2') as HTMLButtonElement).click();
  });
  // Click the Unresolved resolution option (third button in the resolution list).
  const resButtons = container.querySelectorAll('button.run-outcome-resolution');
  assert.equal(resButtons.length, 3);
  act(() => { (resButtons[2] as HTMLButtonElement).click(); });
  assert.equal(resButtons[2].getAttribute('aria-checked'), 'true');

  act(() => {
    (container.querySelector('button.action-btn.primary') as HTMLButtonElement).click();
  });
  assert.deepEqual(submitted, [{ resolution: 'unresolved', satisfaction: 2 }]);
});

test('RunOutcomeDialog: Escape cancels the dialog', () => {
  let cancelled = false;
  renderDialog({ onCancel: () => { cancelled = true; } });
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  assert.equal(cancelled, true);
});

test('RunOutcomeDialog: backdrop click cancels, but a click inside the dialog does not', () => {
  let cancelled = 0;
  renderDialog({ onCancel: () => { cancelled++; } });

  // Clicking the dialog body (not the backdrop) must not cancel.
  act(() => {
    const dialog = container.querySelector('.run-outcome-dialog') as HTMLElement;
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  assert.equal(cancelled, 0, 'click inside dialog does not cancel');

  // Clicking the backdrop itself (target === currentTarget) cancels.
  act(() => {
    const backdrop = container.querySelector('.run-outcome-backdrop') as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  assert.equal(cancelled, 1, 'backdrop click cancels');
});

test('RunOutcomeDialog: Enter submits once a rating is chosen, but not when focus is on Cancel', () => {
  const submitted: RunOutcome[] = [];
  renderDialog({ onSubmit: (o) => submitted.push(o) });

  // No rating yet → Enter does nothing.
  act(() => {
    const dialog = container.querySelector('.run-outcome-dialog') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.deepEqual(submitted, []);

  act(() => {
    (container.querySelector('button.run-outcome-rating.r5') as HTMLButtonElement).click();
  });

  // Enter with focus away from Cancel submits the chosen rating. Dispatch on a
  // real element inside the dialog so it bubbles to the document listener and
  // the handler's `target.closest(...)` guard has an HTMLElement to query.
  act(() => {
    const dialog = container.querySelector('.run-outcome-dialog') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.deepEqual(submitted, [{ resolution: 'resolved', satisfaction: 5 }]);

  // The Cancel-button guard: an Enter originating on the Cancel button must not
  // submit (the document handler returns early so the button's native click
  // activation handles the cancel instead of double-firing submit).
  act(() => {
    const cancelBtn = container.querySelector('[data-cancel-button]') as HTMLButtonElement;
    cancelBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.equal(submitted.length, 1, 'Enter on Cancel does not submit');
});
