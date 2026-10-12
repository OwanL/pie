import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentCostFits } from '../../../transcript/use-subagent-cost-fit';

test('optional subagent cost requires breathing room beyond all header content', () => {
  assert.equal(subagentCostFits(400, 350), true);
  assert.equal(subagentCostFits(362, 350), true);
  assert.equal(subagentCostFits(361, 350), false);
  assert.equal(subagentCostFits(350, 350), false);
  assert.equal(subagentCostFits(300, 350), false);
});

test('long metadata and nested narrow headers suppress only optional cost', () => {
  assert.equal(subagentCostFits(600, 700), false);
  assert.equal(subagentCostFits(260, 280), false);
  assert.equal(subagentCostFits(600, 280), true);
  assert.equal(subagentCostFits(0, 0), false);
});
