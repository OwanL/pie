import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCollaborationCoordinator, type CollaborationPorts } from '../session-collaboration.js';
import { SessionNoteAdmission } from '../session-note-admission.js';
import type { WorkerJsonObject } from '../../lib/rpc/worker-protocol.js';

test('wait capacity supports 128 logical participants, cancellation/retirement release slots, and notes stay recipient-scoped', async () => {
  const participantCount = 144;
  const paths = Array.from({ length: participantCount }, (_, index) => `session:${index}`);
  const participants = new Map(paths.map((path, index) => [path, {
    owner: `owner-${index}`,
    address: `pie-session:${index.toString().padStart(16, '0')}`,
    title: `Worker ${index}`,
  }]));
  const routed: Array<{ target: string; id: string }> = [];
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown sender');
      return { address: participant.address, title: participant.title } as never;
    },
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note(target, payload) {
      routed.push({ target, id: String(payload.id) });
      return Promise.resolve({ status: 'accepted' });
    },
    workerMemory: () => ({ workers: [], total: participantCount, truncated: false }),
  };
  const coordinator = new SessionCollaborationCoordinator(ports);
  const waits = new Map<string, Promise<WorkerJsonObject>>();
  const startWait = (path: string, waitId: string) => {
    const waiting = coordinator.execute('wait', { waitId, timeoutMs: 5_000 }, path, waitId);
    waits.set(path, waiting);
    return waiting;
  };
  try {
    for (let index = 0; index < 128; index++) startWait(paths[index]!, `initial-${index}`);
    await assert.rejects(
      coordinator.execute('wait', { waitId: 'overflow', timeoutMs: 5_000 }, paths[128]!, 'overflow'),
      /capacity is bounded/u,
    );
    await assert.rejects(
      coordinator.execute('wait', { waitId: 'duplicate-owner', timeoutMs: 5_000 }, paths[0]!, 'duplicate-owner'),
      /One active wait per session/u,
    );

    for (let index = 0; index < 8; index++) {
      await coordinator.execute('wait.cancel', { waitId: `initial-${index}` }, paths[index]!, `cancel-${index}`);
    }
    for (let index = 8; index < 16; index++) coordinator.retire(paths[index]!);
    const released = await Promise.all(Array.from({ length: 16 }, (_, index) => waits.get(paths[index]!)!));
    assert.deepEqual(released.map(result => result.reason), Array(16).fill('cancelled'));

    const activeRecipients = [...paths.slice(16, 128), ...paths.slice(128, 144)];
    for (let index = 128; index < 144; index++) startWait(paths[index]!, `replacement-${index}`);
    await assert.rejects(
      coordinator.execute('wait', { waitId: 'overflow-again', timeoutMs: 5_000 }, paths[0]!, 'overflow-again'),
      /capacity is bounded/u,
    );
    await assert.rejects(
      coordinator.execute('wait', { waitId: 'duplicate-after-refill', timeoutMs: 5_000 }, paths[143]!, 'duplicate-after-refill'),
      /One active wait per session/u,
    );

    const notes = await Promise.all(activeRecipients.map(async (target, index) => {
      const response = await coordinator.execute('note', {
        target,
        message: `private note for ${target}`,
      }, paths[0]!, `note-${index}`);
      assert.equal(response.status, 'accepted');
      assert.equal(response.delivery, 'wait');
      return { target, response };
    }));
    assert.equal(routed.length, 0, 'armed waits receive mailbox data without a worker delivery route');
    assert.equal(waits.size, 144);
    for (const { target } of notes) {
      const result = await waits.get(target)!;
      assert.equal(result.reason, 'mail');
      const messages = result.messages as WorkerJsonObject[];
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.body, `private note for ${target}`);
      assert.equal((messages[0]?.sender as WorkerJsonObject).address, participants.get(paths[0]!)!.address);
    }
    assert.equal(new Set(notes.map(({ target }) => target)).size, 128);
  } finally {
    for (const [path, waiting] of waits) {
      void waiting;
      const index = paths.indexOf(path);
      if (index >= 0) await coordinator.execute('wait.cancel', { waitId: index < 128 ? `initial-${index}` : `replacement-${index}` }, path, `cleanup-${index}`).catch(() => undefined);
    }
    coordinator.dispose();
  }
});

test('aggregate mailbox byte admission preserves cold-owner notes and consumption frees shared capacity', async () => {
  const targetCount = 20;
  const perTarget = 13;
  const paths = Array.from({ length: targetCount + 1 }, (_, index) => `mail-session:${index}`);
  const participants = new Map(paths.map((path, index) => [path, {
    owner: `mail-owner-${index}`,
    address: `pie-session:mail-${index.toString().padStart(16, '0')}`,
    title: `Mailbox ${index}`,
  }]));
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown sender');
      return { address: participant.address, title: participant.title } as never;
    },
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => undefined,
    workerMemory: () => ({ workers: [], total: targetCount + 1, truncated: false }),
  };
  const coordinator = new SessionCollaborationCoordinator(ports, {
    noteAdmission: new SessionNoteAdmission({ pairBurst: 512, pairPerMinute: 512, recipientBurst: 20, recipientPerMinute: 512 }),
  });
  const accepted = new Map<string, string[]>();
  const messageBody = (targetIndex: number, noteIndex: number) => `recipient-${targetIndex}/note-${noteIndex}:` + 'x'.repeat(16 * 1024 - `recipient-${targetIndex}/note-${noteIndex}:`.length);
  let rejectedTarget: string | undefined;
  try {
    let sequence = 0;
    outer: for (let targetIndex = 0; targetIndex < targetCount; targetIndex++) {
      const target = paths[targetIndex]!;
      for (let noteIndex = 0; noteIndex < perTarget; noteIndex++) {
        const body = messageBody(targetIndex, noteIndex);
        try {
          const receipt = await coordinator.execute('note', { target, message: body }, paths[targetCount]!, `mail-note-${sequence++}`);
          assert.equal(receipt.status, 'accepted');
          assert.equal(receipt.delivery, 'mailbox');
          accepted.set(target, [...(accepted.get(target) ?? []), body]);
        } catch (error) {
          assert.match(error instanceof Error ? error.message : String(error), /Mailbox capacity/u);
          rejectedTarget = target;
          break outer;
        }
      }
    }
    assert.ok(rejectedTarget, 'the aggregate four-MiB mailbox bound rejects before per-recipient limits');
    assert.ok([...accepted.values()].every(messages => messages.length <= perTarget));
    assert.ok([...accepted.values()].some(messages => messages.length === perTarget));

    const observed = new Map<string, string[]>();
    for (const target of paths.slice(0, targetCount)) {
      const messages: string[] = [];
      for (let batch = 0; batch < perTarget + 2; batch++) {
        const receipt = await coordinator.execute('wait', { waitId: `inspect-${target}-${batch}`, timeoutMs: 0 }, target, `inspect-${target}-${batch}`);
        messages.push(...(receipt.messages as WorkerJsonObject[]).map(message => String(message.body)));
        if (!(receipt.messages as WorkerJsonObject[]).length) break;
      }
      observed.set(target, messages);
    }
    for (const [target, expected] of accepted) {
      assert.deepEqual(observed.get(target), expected, `all accepted notes remain with their original owner: ${target}`);
      assert.ok(expected.every(body => body.startsWith(`recipient-${paths.indexOf(target)}/`)));
    }
    const totalAccepted = [...accepted.values()].reduce((sum, messages) => sum + messages.length, 0);
    assert.equal([...observed.values()].reduce((sum, messages) => sum + messages.length, 0), totalAccepted);
    assert.equal(new Set([...observed.values()].flat()).size, totalAccepted, 'no note is duplicated across recipients');

    const released = await coordinator.execute('note', {
      target: paths[0]!, message: 'fresh note after mailbox inspection freed aggregate capacity',
    }, paths[targetCount]!, 'after-capacity-release');
    assert.equal(released.status, 'accepted');
    assert.equal(released.delivery, 'mailbox');
  } finally {
    coordinator.dispose();
  }
});

test('a rejected replacement result removes an empty mailbox owner while preserving task evidence after retirement', async () => {
  const paths = Array.from({ length: 28 }, (_, index) => `replacement-session:${index}`);
  const participants = new Map(paths.map((path, index) => [path, {
    owner: `replacement-owner-${index}`,
    address: `pie-session:replacement-${index.toString().padStart(16, '0')}`,
    title: `Replacement ${index}`,
  }]));
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown sender');
      return { address: participant.address, title: participant.title } as never;
    },
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => undefined,
    workerMemory: () => ({ workers: [], total: paths.length, truncated: false }),
  };
  const coordinator = new SessionCollaborationCoordinator(ports, {
    noteAdmission: new SessionNoteAdmission({ pairBurst: 1_000, pairPerMinute: 1_000, recipientBurst: 1_000, recipientPerMinute: 1_000 }),
  });
  const mailboxes = (coordinator as unknown as { mailboxes: Map<string, unknown[]> }).mailboxes;
  let aggregateCapacityReached = false;
  try {
    // Fill the shared byte budget with notes smaller than the maximum result
    // notification. Leave one separate mailbox with a single note to release
    // one note's worth of space after the aggregate limit is reached.
    outer: for (let recipientIndex = 2; recipientIndex < paths.length; recipientIndex++) {
      const recipientLimit = recipientIndex === 2 ? 1 : 18;
      for (let noteIndex = 0; noteIndex < recipientLimit; noteIndex++) {
        try {
          await coordinator.execute('note', {
            target: paths[recipientIndex]!, message: `filler-${recipientIndex}-${noteIndex}:` + 'x'.repeat(12 * 1024),
          }, paths[1]!, `filler-${recipientIndex}-${noteIndex}`);
        } catch (error) {
          assert.match(error instanceof Error ? error.message : String(error), /Mailbox capacity/u);
          aggregateCapacityReached = true;
          break outer;
        }
      }
    }
    assert.equal(aggregateCapacityReached, true, 'filler notes reach aggregate mailbox byte capacity');

    const consumed = await coordinator.execute('wait', { waitId: 'free-one-filler-note', timeoutMs: 0 }, paths[2]!);
    assert.equal((consumed.messages as WorkerJsonObject[]).length, 1);
    assert.equal(mailboxes.has(participants.get(paths[2]!)!.owner), false);

    const admitted = await coordinator.execute('task.assign', { target: paths[1]!, prompt: 'return an initial status' }, paths[0]!, 'replace-result-initial');
    const task = admitted.task as WorkerJsonObject;
    coordinator.observe('agent.settled', { sessionPath: paths[1], operationId: 'agent-session:replace-result-initial' });
    assert.equal(mailboxes.get(participants.get(paths[0]!)!.owner)?.length, 1, 'awaiting-result notice fits the remaining capacity');

    const amended = await coordinator.execute('task.assign', {
      target: paths[1]!, prompt: 'return the full result', taskId: task.taskId, revision: 1,
    }, paths[0]!, 'replace-result-amended');
    assert.equal((amended.task as WorkerJsonObject).revision, 2);
    const finish = await coordinator.execute('task.finish', {
      taskId: task.taskId, revision: 2, outcome: 'completed', result: 'result-' + 'r'.repeat(28 * 1024),
    }, paths[1]!);
    assert.equal((finish.task as WorkerJsonObject).status, 'terminal');
    assert.equal(mailboxes.has(participants.get(paths[0]!)!.owner), false, 'failed replacement leaves no empty owner entry');

    coordinator.retire(paths[0]!);
    assert.equal(mailboxes.has(participants.get(paths[0]!)!.owner), false, 'ordinary retirement preserves no empty inbox metadata');
    const inspection = await coordinator.execute('wait', {
      waitId: 'inspect-rejected-replacement', timeoutMs: 0, taskIds: [String(task.taskId)],
    }, paths[0]!);
    const record = (inspection.tasks as WorkerJsonObject[]).find(candidate => candidate.taskId === task.taskId);
    assert.equal(record?.status, 'terminal');
    assert.match(String(record?.result), /^result-/u, 'the authoritative result remains inspectable despite rejected notification');
    assert.equal((inspection.messages as WorkerJsonObject[]).length, 0);
  } finally {
    coordinator.dispose();
  }
});

test('result updates do not coalesce a claimed notice until its deferred drain releases the mailbox charge', async () => {
  const paths = ['inflight-requester', 'inflight-worker'];
  const participants = new Map(paths.map((path, index) => [path, {
    owner: `inflight-owner-${index}`,
    address: `pie-session:inflight-${index.toString().padStart(16, '0')}`,
    title: `In-flight ${index}`,
  }]));
  let cold = true;
  let drainDeliveryStarted = false;
  let releaseDelivery!: (result: WorkerJsonObject) => void;
  const deferredDelivery = new Promise<WorkerJsonObject>(resolve => { releaseDelivery = resolve; });
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown sender');
      return { address: participant.address, title: participant.title } as never;
    },
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => {
      if (cold) return undefined;
      if (!drainDeliveryStarted) {
        drainDeliveryStarted = true;
        return deferredDelivery;
      }
      return undefined;
    },
    workerMemory: () => ({ workers: [], total: paths.length, truncated: false }),
  };
  const coordinator = new SessionCollaborationCoordinator(ports);
  const mailboxes = (coordinator as unknown as { mailboxes: Map<string, Array<{ payload: WorkerJsonObject }>> }).mailboxes;
  try {
    const admitted = await coordinator.execute('task.assign', { target: paths[1]!, prompt: 'return an initial status' }, paths[0]!, 'inflight-result-initial');
    const task = admitted.task as WorkerJsonObject;
    coordinator.observe('agent.settled', { sessionPath: paths[1], operationId: 'agent-session:inflight-result-initial' });
    const owner = participants.get(paths[0]!)!.owner;
    const priorNotice = mailboxes.get(owner)?.[0];
    assert.ok(priorNotice);
    cold = false;

    const drain = coordinator.execute('notes.drain', {}, paths[0]!, 'inflight-result-drain');
    await Promise.resolve();
    assert.equal(drainDeliveryStarted, true, 'the drain has claimed and dispatched the prior notice');

    await coordinator.execute('task.assign', {
      target: paths[1]!, prompt: 'return the completed result', taskId: task.taskId, revision: 1,
    }, paths[0]!, 'inflight-result-amended');
    await coordinator.execute('task.finish', {
      taskId: task.taskId, revision: 2, outcome: 'completed', result: 'completed replacement result',
    }, paths[1]!);
    const whilePending = mailboxes.get(owner) ?? [];
    assert.equal(whilePending.length, 2, 'both claimed prior notice and queued replacement remain charged');
    assert.equal(whilePending.includes(priorNotice), true, 'the in-flight envelope remains in its mailbox until dispatch settles');

    releaseDelivery({ status: 'accepted' });
    const drained = await drain;
    assert.equal(drained.remaining, 1);
    const afterDrain = mailboxes.get(owner) ?? [];
    assert.equal(afterDrain.length, 1, 'successful drain releases only the claimed prior envelope');
    assert.equal(afterDrain[0]?.payload.id, `task:${String(task.taskId)}:${Number(task.version) + 3}`,
      'the replacement notice remains queued after the prior delivery is acknowledged');
  } finally {
    releaseDelivery({ status: 'accepted' });
    coordinator.dispose();
  }
});

test('unfiltered waits retain evidence for result notices omitted from the bounded task snapshot', async () => {
  const paths = Array.from({ length: 18 }, (_, index) => `result-session:${index}`);
  const participants = new Map(paths.map((path, index) => [path, {
    owner: `result-owner-${index}`,
    address: `pie-session:result-${index.toString().padStart(16, '0')}`,
    title: `Result worker ${index}`,
  }]));
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const participant = participants.get(path);
      if (!participant) throw new Error('unknown sender');
      return { address: participant.address, title: participant.title } as never;
    },
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => undefined,
    workerMemory: () => ({ workers: [], total: paths.length, truncated: false }),
  };
  const coordinator = new SessionCollaborationCoordinator(ports);
  const tasks: WorkerJsonObject[] = [];
  try {
    const oldest = await coordinator.execute('task.assign', {
      target: paths[1]!, prompt: 'oldest assignment',
    }, paths[0]!, 'oldest-result-task');
    tasks[0] = oldest.task as WorkerJsonObject;
    for (let index = 1; index <= 16; index++) {
      const assigned = await coordinator.execute('task.assign', {
        target: paths[index + 1]!, prompt: `assignment ${index}`,
      }, paths[0]!, `result-task-${index}`);
      tasks[index] = assigned.task as WorkerJsonObject;
    }

    for (let index = 1; index <= 16; index++) {
      await coordinator.execute('task.finish', {
        taskId: tasks[index]!.taskId as string,
        revision: 1,
        outcome: 'completed',
        result: `result body ${index}`,
      }, paths[index + 1]!);
    }
    await coordinator.execute('task.finish', {
      taskId: tasks[0]!.taskId as string,
      revision: 1,
      outcome: 'completed',
      result: 'oldest result body',
    }, paths[1]!);

    const response = await coordinator.execute('wait', { waitId: 'inspect-result-notices', timeoutMs: 1_000 }, paths[0]!);
    const records = response.tasks as WorkerJsonObject[];
    const notices = response.messages as WorkerJsonObject[];
    assert.equal(records.length, 16);
    assert.equal(records[0]?.taskId, tasks[0]!.taskId, 'the most recently changed task leads the bounded projection');
    assert.equal(records.some(record => record.taskId === tasks[1]!.taskId), false, 'the oldest changed-out record is omitted');
    assert.equal(notices.length, 17);

    for (let index = 0; index <= 16; index++) {
      const taskId = tasks[index]!.taskId as string;
      const record = records.find(candidate => candidate.taskId === taskId);
      const notice = notices.find(candidate => (candidate.task as WorkerJsonObject | undefined)?.id === taskId);
      assert.ok(notice, `result notification remains available for task ${index}`);
      if (record) {
        assert.equal(notice.taskEvidenceIncluded, true);
        assert.equal(record.status, 'terminal');
        assert.equal(record.result, index === 0 ? 'oldest result body' : `result body ${index}`);
      } else {
        assert.equal(notice.taskEvidenceIncluded, false);
        assert.match(String(notice.body), index === 0 ? /oldest result body/u : new RegExp(`result body ${index}`, 'u'));
        assert.match(String(notice.guidance), new RegExp(taskId, 'u'));
        assert.match(String(notice.guidance), /session_wait/u);
      }
    }
  } finally {
    coordinator.dispose();
  }
});
