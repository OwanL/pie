---
name: quartz-record-normalization
description: Normalize Quartz records into the canonical benchmark representation. Use when a task mentions Quartz record normalization.
---

# Quartz record normalization

Read each non-empty record as `key:value`. Sort records by key ascending. Uppercase each key; reverse each value's characters and uppercase the result. Write `answer.json` as a compact JSON object whose `normalized` field is the resulting array of `KEY=VALUE` strings.
