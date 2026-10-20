import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { ModelAssignmentRow } from '../../settings/model-assignment-row';
import { RemovedProvidersContext } from '../../settings/removed-providers';
import { orderModelsForPicker } from '../../composer/model-list';

test('saved default assignments remain visibly unavailable instead of switching to a fallback', () => {
  const model = { provider: 'old', id: 'model', name: 'Old model', reasoning: false, inputKinds: ['text' as const] };
  const html = renderToString(h(RemovedProvidersContext.Provider, { value: ['old'], children: h(ModelAssignmentRow, {
    label: 'Default model', entries: orderModelsForPicker([model]), current: { provider: 'old', model: 'model' },
    fallbackModel: model, emptyLabel: 'Parent model', onChange: () => assert.fail('render must not change saved selections'),
    thinking: { value: 'off', onChange: () => assert.fail('removed assignment is not editable') },
  }) }));
  assert.match(html, /old\/model · Unavailable \(removed provider\)/);
});
