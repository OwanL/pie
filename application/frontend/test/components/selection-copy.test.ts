import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { captureSelectionForCopy, markdownToReadableText } from '../../lib/components/selection-copy';

test('captured selection keeps visible text and serializes selected rendered formatting only', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>whole message: <strong>selected text</strong></p>';
  document.body.appendChild(root);

  const paragraph = root.querySelector('p')!;
  const start = paragraph.firstChild!;
  const boldText = paragraph.querySelector('strong')!.firstChild!;
  const range = document.createRange();
  range.setStart(start, 'whole message: '.length);
  range.setEnd(boldText, 'selected'.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  assert.deepEqual(captureSelectionForCopy(selection), {
    text: 'selected',
    markdown: '**selected**',
  });
  selection.removeAllRanges();
  root.remove();
});

test('partial selections retain bold and link ancestors through capture', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p><strong>bold words</strong> <a href="https://example.com/path">linked label</a></p>';
  document.body.appendChild(root);

  const selection = window.getSelection()!;
  const boldText = root.querySelector('strong')!.firstChild!;
  const boldRange = document.createRange();
  boldRange.setStart(boldText, 1);
  boldRange.setEnd(boldText, 4);
  selection.removeAllRanges();
  selection.addRange(boldRange);
  assert.deepEqual(captureSelectionForCopy(selection), { text: 'old', markdown: '**old**' });

  const linkText = root.querySelector('a')!.firstChild!;
  const linkRange = document.createRange();
  linkRange.setStart(linkText, 2);
  linkRange.setEnd(linkText, 6);
  selection.removeAllRanges();
  selection.addRange(linkRange);
  assert.deepEqual(captureSelectionForCopy(selection), {
    text: 'nked',
    markdown: '[nked](https://example.com/path)',
  });

  selection.removeAllRanges();
  root.remove();
});

test('partial heading and list selections retain their block markers without surrounding text', () => {
  const root = document.createElement('div');
  root.innerHTML = '<h2>before selected after</h2><ol start="7"><li>before selected after</li></ol>';
  document.body.appendChild(root);

  const selection = window.getSelection()!;
  const headingText = root.querySelector('h2')!.firstChild!;
  const headingRange = document.createRange();
  headingRange.setStart(headingText, 'before '.length);
  headingRange.setEnd(headingText, 'before selected'.length);
  selection.removeAllRanges();
  selection.addRange(headingRange);
  assert.deepEqual(captureSelectionForCopy(selection), { text: 'selected', markdown: '## selected' });

  const itemText = root.querySelector('li')!.firstChild!;
  const itemRange = document.createRange();
  itemRange.setStart(itemText, 'before '.length);
  itemRange.setEnd(itemText, 'before selected'.length);
  selection.removeAllRanges();
  selection.addRange(itemRange);
  assert.deepEqual(captureSelectionForCopy(selection), { text: 'selected', markdown: '7. selected' });

  selection.removeAllRanges();
  root.remove();
});

test('partial blockquote and table selections retain their containers without neighboring text', () => {
  const root = document.createElement('div');
  root.innerHTML = '<blockquote><p>before selected after</p></blockquote><table><tbody><tr><td>before selected after</td><td>unselected cell</td></tr></tbody></table>';
  document.body.appendChild(root);

  const selection = window.getSelection()!;
  const quoteText = root.querySelector('blockquote p')!.firstChild!;
  const quoteRange = document.createRange();
  quoteRange.setStart(quoteText, 'before '.length);
  quoteRange.setEnd(quoteText, 'before selected'.length);
  selection.removeAllRanges();
  selection.addRange(quoteRange);
  assert.equal(captureSelectionForCopy(selection).markdown, '> selected');

  const cellText = root.querySelector('td')!.firstChild!;
  const cellRange = document.createRange();
  cellRange.setStart(cellText, 'before '.length);
  cellRange.setEnd(cellText, 'before selected'.length);
  selection.removeAllRanges();
  selection.addRange(cellRange);
  assert.equal(captureSelectionForCopy(selection).markdown, '| selected |\n| --- |');

  selection.removeAllRanges();
  root.remove();
});

test('nested lists indent once per depth and ordered lists honor their start value', () => {
  const root = document.createElement('div');
  root.innerHTML = '<ul><li>outer<ul><li>inner<ol start="4"><li>deep</li></ol></li></ul></li></ul>';
  const list = root.querySelector('ul')!;
  document.body.appendChild(root);

  const range = document.createRange();
  range.selectNode(list);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  assert.equal(captureSelectionForCopy(selection).markdown, '- outer\n  - inner\n    4. deep');

  selection.removeAllRanges();
  root.remove();
});

test('fenced code selection preserves whitespace and chooses a safe fence', () => {
  const root = document.createElement('div');
  root.innerHTML = '<pre><code class="language-ts"></code></pre>';
  const codeText = '  indented  \n\n````\nlast  ';
  const code = root.querySelector('code')!;
  code.textContent = codeText;
  document.body.appendChild(root);

  const range = document.createRange();
  const codeTextNode = code.firstChild!;
  range.setStart(codeTextNode, 0);
  range.setEnd(codeTextNode, codeText.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  assert.deepEqual(captureSelectionForCopy(selection), {
    text: codeText,
    markdown: `\`\`\`\`\`ts\n${codeText}\n\`\`\`\`\``,
  });

  selection.removeAllRanges();
  root.remove();
});

test('readable copy preserves code indentation, trailing spaces, and blank lines', () => {
  assert.equal(
    markdownToReadableText('```text\n  indented  \n\nlast  \n```'),
    '  indented  \n\nlast  ',
  );
});

test('selected tables include a Markdown header delimiter', () => {
  const root = document.createElement('div');
  root.innerHTML = '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>two</td></tr></tbody></table>';
  const table = root.querySelector('table')!;
  document.body.appendChild(root);

  const range = document.createRange();
  range.setStartBefore(table);
  range.setEndAfter(table);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  assert.equal(captureSelectionForCopy(selection).markdown, '| Name | Value |\n| --- | --- |\n| one | two |');

  selection.removeAllRanges();
  root.remove();
});

test('empty selection is represented as empty text and Markdown', () => {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  assert.deepEqual(captureSelectionForCopy(selection), { text: '', markdown: '' });
});

test('readable copy strips Markdown syntax while retaining block and list readability', () => {
  assert.equal(
    markdownToReadableText('# Heading\n\nUse **bold** and `code`.\n\n- First\n- Second'),
    'Heading\n\nUse bold and code.\n\n• First\n• Second',
  );
});
