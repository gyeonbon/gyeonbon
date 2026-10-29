import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createClassroomServer } from '../server.mjs';
import { ClassroomStore } from '../lib/classroom.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, predicate, label) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(5);
  }
  assert.fail(`Timed out: ${label}`);
}
async function classroom(t) {
  const server = createClassroomServer({ dataDir: false, phaseMs: { choosing: 60_000, describing: 60_000, questioning: 60_000, grace: 15, guessing: 60_000, reveal: 10 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  t.after(async () => {
    controllers.forEach(controller => controller.abort());
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  });
  async function request(path, value, actor) {
    const response = await fetch(base + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, data: await response.json() };
  }
  const create = async value => (await request('/api/sessions', value || {})).data;
  const join = async (teacher, name, groupId) => request(`/api/sessions/${teacher.code}/join`, { name, groupId });
  const action = async (actor, type, extra = {}) => request(`/api/sessions/${actor.code}/actions`, { type, ...extra }, actor);
  const state = async actor => (await request(`/api/sessions/${actor.code}/state`, undefined, actor)).data;
  async function stream(actor) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/api/sessions/${actor.code}/events?token=${actor.token}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const initial = new TextDecoder().decode((await response.body.getReader().read()).value);
    assert.match(initial, /event: state/); assert.equal(initial.includes('"token"'), false);
    return initial;
  }
  return { server, request, create, join, action, state, stream };
}

const actorFor = (store, session, credential) => store.auth(session, credential.token);
const drawing = [{ color: '#699bdb', size: 6, tool: 'pen', points: [[0.1, 0.2], [0.5, 0.7]] }];

test('two students can complete all question turns and reveal one private learner drawing', async t => {
  const f = await classroom(t), teacher = await f.create();
  assert.equal((await f.state(teacher)).groups.length, 1);
  const explainer = (await f.join(teacher, '설명친구', '1')).data;
  const learner = (await f.join(teacher, '그림친구', '1')).data;
  await f.action(teacher, 'assignExplainer', { groupId: '1', studentId: explainer.participantId });
  assert.equal((await f.action(teacher, 'start')).status, 200);
  const choices = (await f.state(explainer)).groups[0].choices;
  assert.equal(choices.length, 5);
  assert.equal((await f.state(learner)).groups[0].choices, undefined);
  const word = choices[0]; await f.action(explainer, 'choose', { word });
  assert.equal((await f.action(learner, 'drawing', { strokes: drawing })).status, 200);
  assert.equal(JSON.stringify(await f.state(teacher)).includes('"points"'), false);
  await f.action(explainer, 'ready');
  for (let i = 1; i <= 3; i++) {
    const asking = await until(() => f.state(learner), s => s.groups[0].questionStage === 'ask', 'single learner question');
    assert.equal(asking.groups[0].questionerId, learner.participantId);
    assert.equal(asking.groups[0].questionCount, i);
    await f.action(learner, 'question', { text: '가장 큰 부분은 어디인가요?' });
    assert.equal((await f.state(teacher)).groups[0].questionStage, 'answer');
    await f.action(explainer, 'answer', { text: '가운데에 큰 동그라미가 있어요.' });
  }
  await until(() => f.state(learner), s => s.groups[0].phase === 'guessing', 'single learner guess');
  assert.equal((await f.action(learner, 'guess', { text: word.split('').join(' ') })).status, 200);
  const result = await f.state(teacher);
  assert.equal(result.status, 'review'); assert.equal(result.groups[0].results.drawings.length, 1);
  assert.equal(result.groups[0].results.drawings[0].correct, true);
  assert.deepEqual(result.groups[0].results.drawings[0].strokes, drawing);
  assert.equal((await f.action(learner, 'guess', { text: '수정 불가' })).status, 409);
});

test('thirty students and teacher connect concurrently in six balanced groups, while a thirty-first student is rejected', async t => {
  const f = await classroom(t), teacher = await f.create();
  const students = await Promise.all(Array.from({ length: 30 }, (_, i) => f.join(teacher, `학습자${i + 1}`)));
  assert.equal(students.every(result => result.status === 200), true);
  const rejected = await f.join(teacher, '서른한번째');
  assert.equal(rejected.status, 409); assert.match(rejected.data.error, /30명/);
  assert.equal((await f.action(teacher, 'autoAssign')).status, 200);
  const balanced = await f.state(teacher);
  assert.equal(balanced.groups.length, 6);
  assert.deepEqual(balanced.groups.map(group => balanced.students.filter(student => student.groupId === group.id).length), [5, 5, 5, 5, 5, 5]);
  const connections = await Promise.all([teacher, ...students.map(result => result.data)].map(f.stream));
  assert.equal(connections.length, 31);
  assert.equal((await f.action(teacher, 'start')).status, 200);
  assert.equal((await f.state(teacher)).groups.every(group => group.phase === 'choosing'), true);
});

test('teacher adds and removes occupied groups without removing students, and group IDs are never reused', async t => {
  const f = await classroom(t), teacher = await f.create();
  const first = (await f.join(teacher, '첫친구', '1')).data;
  assert.equal((await f.action(teacher, 'removeGroup', { groupId: '1' })).status, 409);
  assert.equal((await f.action(first, 'addGroup')).status, 403);
  assert.equal((await f.action(teacher, 'addGroup')).status, 200);
  const second = (await f.join(teacher, '둘친구', '2')).data;
  await f.action(teacher, 'assignExplainer', { groupId: '2', studentId: second.participantId });
  assert.equal((await f.action(first, 'removeGroup', { groupId: '2' })).status, 403);
  assert.equal((await f.action(teacher, 'removeGroup', { groupId: '2' })).status, 200);
  const preserved = await f.state(second);
  assert.equal(preserved.me.id, second.participantId); assert.equal(preserved.me.groupId, null); assert.equal(preserved.students.length, 2);
  await f.action(teacher, 'addGroup');
  assert.deepEqual((await f.state(teacher)).groups.map(group => group.id), ['1', '3']);
  const before = await f.state(teacher);
  assert.equal((await f.action(teacher, 'start')).status, 409);
  assert.deepEqual((await f.state(teacher)).groups, before.groups);
  await f.action(teacher, 'autoAssign');
  assert.equal((await f.state(teacher)).groups.length, 1);
  assert.equal((await f.action(teacher, 'start')).status, 200);
  assert.equal((await f.action(teacher, 'addGroup')).status, 409);
  assert.equal((await f.action(teacher, 'removeGroup', { groupId: '1' })).status, 409);
});

test('a sixth group member is rejected without losing their ability to join another group', async t => {
  const f = await classroom(t), teacher = await f.create();
  for (let i = 0; i < 5; i++) assert.equal((await f.join(teacher, `그림${i}`, '1')).status, 200);
  assert.equal((await f.join(teacher, '여섯째', '1')).status, 409);
  assert.equal((await f.state(teacher)).students.length, 5);
  await f.action(teacher, 'addGroup');
  assert.equal((await f.join(teacher, '여섯째', '2')).status, 200);
  assert.equal((await f.action(teacher, 'start')).status, 409);
  await f.action(teacher, 'autoAssign');
  assert.deepEqual((await f.state(teacher)).groups.map(group => (f.server.classroomStore.get(teacher.code).students.filter(student => student.groupId === group.id).length)), [3, 3]);
});

test('automatic assignment creates feasible balanced groups for all participant boundary sizes and respects stable IDs', t => {
  const store = new ClassroomStore(); t.after(() => store.close());
  for (const count of [1, 2, 3, 5, 6, 7, 11, 19, 29, 30]) {
    const credential = store.create({ groupCount: count % 2 ? 15 : 1 });
    const session = store.get(credential.code), teacher = actorFor(store, session, credential);
    for (let i = 0; i < count; i++) store.join(session.code, { name: `친구${i}` });
    store.action(session, teacher, { type: 'autoAssign' });
    const sizes = session.groups.map(group => store.members(session, group).length);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), count);
    assert.ok(sizes.every(size => size >= (count === 1 ? 1 : 2) && size <= 5));
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    if (count === 1) assert.throws(() => store.action(session, teacher, { type: 'start' }), /2~30명/);
    else assert.doesNotThrow(() => store.action(session, teacher, { type: 'start' }));
  }
  const credential = store.create({ groupCount: 3 }), session = store.get(credential.code), teacher = actorFor(store, session, credential);
  store.action(session, teacher, { type: 'removeGroup', groupId: '2' });
  store.action(session, teacher, { type: 'addGroup' });
  for (let i = 0; i < 6; i++) store.join(session.code, { name: `번호친구${i}` });
  store.action(session, teacher, { type: 'autoAssign' });
  assert.deepEqual(session.groups.map(group => group.id), ['1', '3', '4']);
  assert.equal(session.students.every(student => ['1', '3', '4'].includes(student.groupId)), true);
});

test('group count limits and invalid creation fail without changing existing classes', t => {
  const store = new ClassroomStore(); t.after(() => store.close());
  for (const count of [0, 16, 1.5, '2', null]) assert.throws(() => store.create({ groupCount: count }), /모둠 수/);
  assert.equal(store.sessions.size, 0);
  const credential = store.create({ groupCount: 15 }), session = store.get(credential.code), teacher = actorFor(store, session, credential);
  assert.throws(() => store.action(session, teacher, { type: 'addGroup' }), /15개/);
  const ids = session.groups.map(group => group.id);
  assert.throws(() => store.action(session, teacher, { type: 'autoAssign' }), /학생이 입장/);
  assert.deepEqual(session.groups.map(group => group.id), ids);
});

test('legacy four-group snapshots and dynamic six/fifteen-group sessions restore with monotonic IDs', t => {
  const store = new ClassroomStore(), restored = new ClassroomStore(); t.after(() => { store.close(); restored.close(); });
  const legacy = store.create({ groupCount: 4 });
  const six = store.create({ groupCount: 6 });
  const fifteen = store.create({ groupCount: 15 });
  const session = store.get(six.code), teacher = actorFor(store, session, six);
  for (let i = 0; i < 30; i++) store.join(six.code, { name: `복원친구${i}` });
  store.action(session, teacher, { type: 'autoAssign' }); store.action(session, teacher, { type: 'start' });
  const saved = JSON.parse(store.serialize()); delete saved.sessions.find(s => s.code === legacy.code).nextGroupId;
  assert.equal(restored.restore(saved), 3);
  assert.equal(restored.get(legacy.code).groups.length, 4);
  restored.action(restored.get(legacy.code), restored.auth(restored.get(legacy.code), legacy.token), { type: 'addGroup' });
  assert.equal(restored.get(legacy.code).groups.at(-1).id, '5');
  assert.equal(restored.get(six.code).groups.length, 6); assert.equal(restored.get(six.code).students.length, 30);
  assert.equal(restored.get(six.code).paused, true); assert.equal(restored.get(six.code).groups.every(group => group.deadline === null), true);
  assert.equal(restored.get(fifteen.code).groups.length, 15);
  const malformed = JSON.parse(store.serialize()); malformed.sessions[0].groups[1].id = malformed.sessions[0].groups[0].id;
  assert.throws(() => restored.restore(malformed), /모둠 정보/);
  assert.equal(restored.get(six.code).students.length, 30, 'failed restore preserves the currently running classes');
});

test('students retain only their own historical group after regrouping or deleting their previous group', async t => {
  const store = new ClassroomStore({ phaseMs: { reveal: 5 } }); t.after(() => store.close());
  const credential = store.create({ groupCount: 2 }), session = store.get(credential.code), teacher = actorFor(store, session, credential);
  const students = Array.from({ length: 4 }, (_, i) => store.join(session.code, { name: `성찰친구${i}`, groupId: String(i % 2 + 1) }));
  store.action(session, teacher, { type: 'start' }); store.action(session, teacher, { type: 'reveal' });
  await until(() => Promise.resolve(session.groups), groups => groups.every(group => group.minimumRevealDone), 'reveal minimum');
  store.action(session, teacher, { type: 'nextAttempt' });
  const original = actorFor(store, session, students[0]);
  store.action(session, teacher, { type: 'assign', studentId: original.id, groupId: '2' });
  assert.deepEqual(store.state(session, original).history[0].groups.map(group => group.groupId), ['1']);
  store.action(session, teacher, { type: 'removeGroup', groupId: '1' });
  store.action(session, teacher, { type: 'addGroup' });
  assert.deepEqual(session.groups.map(group => group.id), ['2', '3']);
  assert.deepEqual(store.state(session, original).history[0].groups.map(group => group.groupId), ['1']);
  assert.equal(store.state(session, original).history[0].groups.some(group => group.groupId === '2'), false);
});
