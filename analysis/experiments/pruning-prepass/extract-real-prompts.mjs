#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const sessionsRoot = path.resolve(process.argv[2] ?? 'sessions');
const limit = Number(process.argv[3] ?? 120);

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(target));
    else if (entry.name.endsWith('.jsonl')) result.push(target);
  }
  return result;
}

function textContent(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
}

function toolNames(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((item) => item.type === 'toolCall' || item.type === 'tool_use')
    .map((item) => item.name ?? item.toolName)
    .filter(Boolean);
}

const files = await collect(sessionsRoot);
const records = [];
for (const file of files) {
  const info = await stat(file);
  // Ignore synthetic empty-system-prompt fixtures and tiny smoke sessions.
  if (file.includes('pie-empty-system-prompt') || info.size < 2_000) continue;
  let current = null;
  const history = [];
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'message') continue;
    const message = event.message;
    if (message?.role === 'user') {
      if (current) records.push(current);
      const prompt = textContent(message);
      current = prompt ? { file, timestamp: event.timestamp, prompt, tools: new Set(), recent: history.slice(-4) } : null;
      if (prompt) history.push({ role: 'user', text: prompt.slice(0, 800) });
    } else if (current && message?.role === 'assistant') {
      for (const name of toolNames(message)) current.tools.add(name);
      const text = textContent(message);
      if (text) history.push({ role: 'assistant', text: text.slice(0, 800) });
    }
  }
  if (current) records.push(current);
}

const selected = records
  .filter((record) => record.prompt.length >= 12 && record.prompt.length <= 6_000)
  .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
  .slice(0, limit)
  .map((record) => ({
    timestamp: record.timestamp,
    session: path.basename(record.file, '.jsonl'),
    chars: record.prompt.length,
    tools: [...record.tools],
    recent: record.recent,
    prompt: record.prompt,
  }));

process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
