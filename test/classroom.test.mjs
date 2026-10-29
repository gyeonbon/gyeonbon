import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassroomServer } from '../server.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, attempts = 150) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
async function fixture(t, options = {}) {
  const server = createClassroomServer({ dataDir: false, phaseMs: { choosing: 60_000, describing: 60_000, questioning: 60_000, grace: 15, guessing: 60_000, reveal: 20, ...options.phaseMs }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  t.after(async () => {
    controllers.forEach(controller => controller.abort());
    if (server.listening) { await server.flushPersistence(); server.close(); server.closeAllConnections(); await once(server, 'close'); await server.flushPersistence(); }
  });
  async function request(path, body, token, headers = {}) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const create = async (more = {}) => (await request('/api/sessions', { title: '교육학과 진로체험', ...more })).data;
  const enter = async (session, name, groupId) => (await request(`/api/sessions/${session.code}/join`, { name, groupId })).data;
  const state = async actor => (await request(`/api/sessions/${actor.code}/state`, undefined, actor.token)).data;
  const action = async (actor, type, more = {}) => request(`/api/sessions/${actor.code}/actions`, { type, ...more }, actor.token);
  async function stream(actor) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/api/sessions/${actor.code}/events?token=${actor.token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    return { response, reader, initial, controller };
  }
  async function classroom(count = 19, settings = {}) {
    const teacher = await create({ settings: { assignment: 'teacher', questionLimit: 1, ...settings } });
    const students = await Promise.all(Array.from({ length: count }, (_, index) => enter(teacher, `학습자${index + 1}`)));
    assert.equal((await action(teacher, 'autoAssign')).status, 200);
    return { teacher, students };
  }
  return { server, base, request, create, enter, state, action, stream, classroom };
}

test('nineteen students join concurrently, balance across four groups, and cannot use teacher powers', async t => {
  const f = await fixture(t);
  const { teacher, students } = await f.classroom();
  assert.match(teacher.code, /^\d{6}$/); assert.equal(teacher.role, 'teacher'); assert.equal(students.length, 19);
  const roster = await f.state(teacher);
  assert.deepEqual(roster.groups.map(group => roster.students.filter(student => student.groupId === group.id).length).sort(), [4, 5, 5, 5]);
  const connections = await Promise.all([teacher, ...students].map(actor => f.stream(actor)));
  assert.equal(connections.length, 20);
  for (const connection of connections) {
    assert.match(connection.initial, /event: state/);
    assert.equal(connection.initial.includes('"token"'), false);
    assert.equal(connection.response.headers.get('x-accel-buffering'), 'no');
  }
  for (const type of ['start', 'pause', 'reveal', 'assign', 'end', 'nextAttempt']) assert.equal((await f.action(students[0], type, { studentId: students[1].participantId, groupId: '1' })).status, 403);
  assert.equal((await f.request(`/api/sessions/${teacher.code}/state`)).status, 401);
  assert.equal((await f.action(teacher, 'start')).status, 200);
  const begun = await f.state(teacher);
  assert.equal(begun.status, 'playing');
  assert.equal(begun.groups.every(group => group.phase === 'choosing'), true);
  assert.ok(Math.max(...begun.groups.map(group => group.deadline)) - Math.min(...begun.groups.map(group => group.deadline)) < 100);
});

test('secret words, other drawings and guesses stay hidden until each group reveals', async t => {
  const f = await fixture(t);
  const { teacher, students } = await f.classroom(19, { questionLimit: 0 });
  await f.action(teacher, 'start');
  const all = await f.state(teacher);
  for (const group of all.groups) {
    const explainer = students.find(student => student.participantId === group.explainerId);
    const choices = (await f.state(explainer)).groups.find(item => item.id === group.id).choices;
    assert.equal(choices.length, 5);
    assert.equal(all.groups.find(item => item.id === group.id).choices, undefined);
    assert.equal((await f.action(explainer, 'choose', { word: choices[0] })).status, 200);
  }
  const groups = (await f.state(teacher)).groups;
  const group = groups[0];
  const explainer = students.find(student => student.participantId === group.explainerId);
  const explainerState = await f.state(explainer);
  const word = explainerState.groups[0].word;
  const members = (await f.state(teacher)).students.filter(student => student.groupId === group.id);
  const drawers = members.filter(student => student.id !== group.explainerId).map(student => students.find(item => item.participantId === student.id));
  const drawing = [{ color: '#7060cf', size: 6, tool: 'pen', points: [[0.1, 0.2], [0.6, 0.8]] }];
  assert.equal((await f.action(drawers[0], 'drawing', { strokes: drawing })).status, 200);
  assert.deepEqual((await f.state(drawers[0])).me.drawing, drawing);
  for (const observer of [teacher, drawers[1], ...students.filter(student => !members.some(member => member.id === student.participantId)).slice(0, 1)]) {
    const hidden = await f.state(observer);
    assert.equal(hidden.groups[0].word, undefined);
    assert.equal(hidden.groups[0].choices, undefined);
    assert.equal(hidden.groups[0].results, undefined);
    assert.equal(JSON.stringify(hidden).includes('"points"'), false);
  }
  assert.equal((await f.action(drawers[0], 'choose', { word })).status, 409);
  assert.equal((await f.action(explainer, 'explain', { text: `정답은 ${word}입니다` })).status, 400);
  assert.equal((await f.action(explainer, 'explain', { text: '큰 동그라미 아래에 작은 네모가 있어요.' })).status, 200);
  await f.action(explainer, 'ready');
  assert.equal((await f.state(drawers[0])).groups[0].phase, 'guessing');
  assert.equal((await f.action(drawers[0], 'guess', { text: word.split('').join(' ') })).status, 200);
  assert.equal((await f.action(drawers[0], 'guess', { text: '수정하려는답' })).status, 409);
  assert.equal((await f.state(drawers[1])).groups[0].results, undefined);
  for (const drawer of drawers.slice(1)) await f.action(drawer, 'guess', { text: '다른무언가' });
  const result = (await f.state(teacher)).groups[0].results;
  assert.equal(result.word, word); assert.equal(result.explainerName, members.find(member => member.id === group.explainerId).name);
  assert.equal(result.drawings.length, drawers.length); assert.deepEqual(result.drawings[0].strokes, drawing);
  assert.equal(result.drawings[0].correct, true); assert.equal(result.drawings[1].correct, false);
  const outside = students.find(student => !members.some(member => member.id === student.participantId));
  assert.equal((await f.state(outside)).groups[0].results, undefined);
});

test('questions allow drawing during answer and grace; pause/resume preserves server timers', async t => {
  const f = await fixture(t, { phaseMs: { choosing: 100, describing: 60_000, questioning: 60_000, grace: 25, guessing: 60_000, reveal: 20 } });
  const { teacher, students } = await f.classroom(12);
  await f.action(teacher, 'start'); await f.action(teacher, 'pause');
  const paused = await f.state(teacher);
  assert.equal(paused.paused, true); assert.equal(paused.groups.every(group => group.deadline === null), true);
  await delay(150); assert.equal((await f.state(teacher)).groups[0].phase, 'choosing');
  await f.action(teacher, 'resume');
  const described = await until(() => f.state(teacher), state => state.groups.every(group => group.phase === 'describing'), 'resume auto choose');
  const group = described.groups[0];
  const explainer = students.find(student => student.participantId === group.explainerId);
  await f.action(explainer, 'ready');
  const ask = (await f.state(teacher)).groups[0];
  const questioner = students.find(student => student.participantId === ask.questionerId);
  assert.equal(ask.questionStage, 'ask');
  assert.equal((await f.action(questioner, 'question', { text: '오른쪽에는 무엇이 있나요?' })).status, 200);
  assert.equal((await f.state(teacher)).groups[0].questionStage, 'answer');
  const stroke = [{ color: '#112233', size: 3, tool: 'pen', points: [[0.5, 0.5]] }];
  assert.equal((await f.action(questioner, 'drawing', { strokes: stroke })).status, 200);
  assert.equal((await f.action(explainer, 'answer', { text: '작은 세모가 있어요.' })).status, 200);
  assert.equal((await f.state(teacher)).groups[0].questionStage, 'grace');
  assert.equal((await f.action(questioner, 'drawing', { strokes: [] })).status, 200);
  await until(() => f.state(teacher), state => state.groups[0].phase === 'guessing', 'grace to guessing');
});

test('teacher controls reveal hold, reflections and two attempts without treating accuracy as teaching effect', async t => {
  const f = await fixture(t);
  const { teacher, students } = await f.classroom(19);
  assert.equal((await f.action(teacher, 'settings', { settings: { difficulty: 'normal', questionLimit: 3, mode: 'classroom' } })).status, 200);
  const before = await f.state(teacher);
  const firstMember = before.students.find(student => student.groupId === '1');
  await f.action(teacher, 'assignExplainer', { groupId: '1', studentId: firstMember.id });
  await f.action(teacher, 'start');
  assert.equal((await f.state(teacher)).groups[0].explainerId, firstMember.id);
  assert.equal((await f.action(teacher, 'reveal')).status, 200);
  const revealed = await f.state(teacher);
  assert.equal(revealed.status, 'review'); assert.equal(revealed.history[0].groups.length, 4);
  assert.equal((await f.action(teacher, 'nextAttempt')).status, 409);
  await until(() => f.state(teacher), state => state.groups.every(group => group.minimumRevealDone), 'minimum reveal time');
  await f.action(teacher, 'hold');
  const student = students[0];
  assert.equal((await f.action(student, 'reflection', { answers: ['모양을 다르게 상상했어요.', '크기 설명이 모호했어요.', '위치부터 설명하면 좋겠어요.'], strategy: '큰 모양부터 차례대로 설명하기' })).status, 200);
  assert.equal((await f.state(teacher)).history[0].groups.flatMap(group => group.reflections).length, 1);
  assert.equal((await f.action(teacher, 'extend', { groupId: '1', seconds: 5 })).status, 200);
  assert.equal((await f.action(teacher, 'nextAttempt')).status, 409);
  await until(() => f.state(teacher), state => state.groups.every(group => group.minimumRevealDone), 'extended reveal time', 650);
  await f.action(teacher, 'nextAttempt');
  const second = await f.state(teacher);
  assert.equal(second.attempt, 2); assert.equal(second.status, 'lobby'); assert.equal(second.history.length, 1);
  assert.equal(second.history[0].groups[0].word, revealed.history[0].groups[0].word);
  await f.action(teacher, 'start'); await f.action(teacher, 'reveal');
  const comparison = await f.state(teacher);
  assert.deepEqual(comparison.history.map(item => item.attempt), [1, 2]);
  await f.action(teacher, 'end'); assert.equal((await f.state(teacher)).status, 'ended');
  assert.equal((await f.action(student, 'chat', { text: '계속할 수 있나요?' })).status, 409);
});

test('persistent snapshots restore active sessions paused with private drawings and the same auth tokens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'blind-teaching-test-'));
  const first = await fixture(t, { dataDir: directory });
  const { teacher, students } = await first.classroom(12, { questionLimit: 0 });
  await first.action(teacher, 'start');
  await first.action(teacher, 'advance', { groupId: '1' });
  const initial = await first.state(teacher);
  const member = initial.students.find(student => student.groupId === '1' && student.id !== initial.groups[0].explainerId);
  const drawer = students.find(student => student.participantId === member.id);
  const strokes = [{ color: '#334455', size: 6, tool: 'pen', points: [[0.2, 0.3], [0.4, 0.6]] }];
  await first.action(drawer, 'drawing', { strokes });
  await first.server.flushPersistence();
  assert.equal((await stat(join(directory, 'sessions.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const file = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  assert.equal(file.version, 1);
  first.server.close(); first.server.closeAllConnections(); await once(first.server, 'close'); await first.server.flushPersistence();
  const restored = await fixture(t, { dataDir: directory });
  const resumed = await restored.state(drawer);
  assert.equal(resumed.paused, true); assert.equal(resumed.status, 'playing'); assert.deepEqual(resumed.me.drawing, strokes);
  assert.equal(resumed.groups[0].word, undefined);
  assert.equal((await restored.action(teacher, 'resume')).status, 200);
  assert.equal((await restored.state(teacher)).paused, false);
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('student limits, malformed drawing, cross-origin requests and API health behave predictably', async t => {
  const f = await fixture(t, { publicOrigin: 'https://class.example.com' });
  const health = await f.request('/api/health'); assert.equal(health.data.ok, true);
  assert.equal((await f.request('/api/sessions', { title: '외부 요청' }, undefined, { Origin: 'https://other.example.com' })).status, 403);
  const teacher = await f.create();
  const students = await Promise.all(Array.from({ length: 30 }, (_, i) => f.enter(teacher, `친구${i}`)));
  assert.equal((await f.request(`/api/sessions/${teacher.code}/join`, { name: '서른한번째' })).status, 409);
  assert.equal((await f.request(`/api/sessions/${teacher.code}/join`, { name: students[0].name || '친구0' })).status, 409);
  await f.action(teacher, 'autoAssign'); await f.action(teacher, 'start');
  const roster = await f.state(teacher), group = roster.groups[0];
  await f.action(teacher, 'advance', { groupId: group.id });
  const member = roster.students.find(student => student.groupId === group.id && student.id !== group.explainerId);
  const drawer = students.find(student => student.participantId === member.id);
  assert.equal((await f.action(drawer, 'drawing', { strokes: [{ color: 'bad', size: 4, tool: 'pen', points: [[-1, 0]] }] })).status, 400);
  assert.equal((await f.request('/api/not-found')).status, 404);
  assert.equal((await f.request('/api/sessions', { title: 'x'.repeat(2_100_000) })).status, 413);
});
