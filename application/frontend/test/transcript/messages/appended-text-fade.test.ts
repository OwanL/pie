import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { annotateAppendedText } from '../../../transcript/appended-text-fade';

const document = new JSDOM('').window.document;
const annotate = (old: string, next: string) => annotateAppendedText(old, next, document);
function inspect(html: string) {
  const body = document.createElement('div');
  body.innerHTML = html;
  return { text: body.textContent, faded: [...body.querySelectorAll('[data-stream-text-fade]')].map(node => node.textContent) };
}

test('only appended visible text fades, including a suffix inside an existing text node', () => {
  const first = annotate('<p>Hello</p>', '<p>Hello world <strong>today</strong></p>');
  assert.deepEqual(inspect(first), { text: 'Hello world today', faded: [' world ', 'today'] });
  const second = annotate(first, '<p>Hello world <strong>today!</strong></p>');
  assert.deepEqual(inspect(second), { text: 'Hello world today!', faded: ['!'] });
});

test('markdown block-ending whitespace does not prevent live paragraph and list suffix fades', () => {
  assert.deepEqual(inspect(annotate('<p>Hello</p>\n', '<p>Hello world</p>\n')), {
    text: 'Hello world\n', faded: [' world'],
  });
  assert.deepEqual(inspect(annotate('<ul>\n<li>First</li>\n</ul>\n', '<ul>\n<li>First item</li>\n</ul>\n')), {
    text: '\nFirst item\n\n', faded: [' item'],
  });
});

test('initial, identical, replaced, shrinking, and structurally reinterpreted markdown skip motion', () => {
  for (const [old, next] of [
    ['', '<p>history</p>'],
    ['<p>same</p>', '<p>same</p>'],
    ['<p>old</p>', '<p>new</p>'],
    ['<p>long</p>', '<p>lo</p>'],
    ['<p>hello</p>', '<p><strong>hello</strong> world</p>'],
    ['<p><a href="old">hello</a></p>', '<p><a href="new">hello</a> world</p>'],
  ]) assert.equal(annotate(old, next), next);
});

test('large suffix is immediately present and markup/escaped text remain intact', () => {
  const suffix = 'x'.repeat(100_000);
  const next = `<p>start &lt;safe&gt;${suffix}</p>`;
  const result = inspect(annotate('<p>start</p>', next));
  assert.equal(result.text, `start <safe>${suffix}`);
  assert.deepEqual(result.faded, [` <safe>${suffix}`]);
});
