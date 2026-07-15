import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { capBashTimeout, classifyToolCall, findUnrelatedChanges } from "../lib/policy.mjs";
const cwd=resolve("task-workspace");
test("policy caps every target bash call",()=>{const implicit={toolName:"bash",input:{command:"npm test"}},explicit={toolName:"bash",input:{command:"x",timeout:600}};capBashTimeout(implicit,60);capBashTimeout(explicit,60);assert.equal(implicit.input.timeout,60);assert.equal(explicit.input.timeout,60);});
test("policy blocks network-oriented commands",()=>{assert.equal(classifyToolCall({toolName:"bash",input:{command:"npm install left-pad"}},cwd)?.type,"network_command");assert.equal(classifyToolCall({toolName:"bash",input:{command:"node test.mjs"}},cwd),undefined);});
test("changed-file policy rejects generated and benchmark edits",()=>{assert.deepEqual(findUnrelatedChanges(["src/solver.mjs","generated/out.json","benchmark.mjs"],["src/solver.mjs"]),["generated/out.json","benchmark.mjs"]);});
test("policy blocks tool paths outside workspace",()=>{assert.equal(classifyToolCall({toolName:"read",input:{path:"../auth.json"}},cwd)?.type,"path_boundary");assert.equal(classifyToolCall({toolName:"edit",input:{path:"src/file.ts"}},cwd),undefined);});
