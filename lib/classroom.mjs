import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const DEFAULT_SETTINGS = { difficulty: 'easy', questionLimit: 3, explanationSeconds: 60, mode: 'text', assignment: 'student' };
const PHASE_MS = { choosing: 30_000, questioning: 20_000, grace: 10_000, guessing: 20_000, reveal: 15_000 };
const WORDS = {
  easy: ['자전거', '우산', '로봇', '등대', '피자', '눈사람', '고양이', '나비', '기차', '사과', '안경', '풍선', '선인장', '해바라기', '아이스크림', '거북이', '왕관', '도넛', '축구공', '수박', '촛불', '버섯', '하트', '연', '가방', '컵', '의자', '나무', '집', '자동차'],
  normal: ['열기구', '잠수함', '우주선', '풍차', '모래시계', '햄버거', '바이올린', '회전목마', '낙하산', '벚꽃', '인어', '문어', '펭귄', '고래', '기린', '공룡', '캠핑장', '분수', '피라미드', '무지개', '해적선', '보물상자', '딸기 케이크', '팝콘', '망원경', '헬리콥터', '교실', '성', '꽃다발', '피아노'],
  hard: ['롤러코스터', '전자레인지', '아코디언', '스노보드', '나무 위의 집', '도르래', '현미경', '천문대', '수력발전소', '기중기', '오르골', '수족관', '우주정거장', '지구본', '태양계', '화산', '수중도시', '비행기 조종석', '회전문', '오토바이', '사막의 오아시스', '스케이트보드', '물레방아', '관람차', '도개교', '종이접기 학', '사다리차', '계단식 논', '풍력발전기', '범선']
};
const clone = value => structuredClone(value);
const normalize = value => String(value).normalize('NFKC').replace(/\s/g, '').toLocaleLowerCase();
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const identifier = () => randomBytes(12).toString('hex');
const token = () => randomBytes(32).toString('hex');
const phaseIsActive = phase => ['choosing', 'describing', 'questioning', 'guessing'].includes(phase);
export class ClassroomError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ClassroomError'; this.status = status; }
}
function fail(message, status = 400) { throw new ClassroomError(message, status); }
function validateSettings(input = {}, base = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('수업 설정을 확인해 주세요.');
  const result = { ...base };
  for (const key of ['difficulty', 'mode', 'assignment']) if (input[key] !== undefined) result[key] = input[key];
  if (!['easy', 'normal', 'hard'].includes(result.difficulty)) fail('제시어 난이도를 확인해 주세요.');
  if (!['text', 'classroom'].includes(result.mode)) fail('설명 방식을 확인해 주세요.');
  if (!['student', 'teacher'].includes(result.assignment)) fail('모둠 편성 방식을 확인해 주세요.');
  for (const [key, low, high] of [['questionLimit', 0, 8], ['explanationSeconds', 20, 180]]) {
    if (input[key] !== undefined) result[key] = input[key];
    if (!Number.isInteger(result[key]) || result[key] < low || result[key] > high) fail(key === 'questionLimit' ? '질문 횟수는 0~8회로 설정해 주세요.' : '설명 시간은 20~180초로 설정해 주세요.');
  }
  return result;
}
function validateDrawing(strokes) {
  if (!Array.isArray(strokes) || strokes.length > 600) fail('그림은 600개의 선까지 저장할 수 있어요.');
  let count = 0;
  return strokes.map(stroke => {
    if (!stroke || !/^#[0-9a-f]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.size) || stroke.size < 1 || stroke.size > 40 || !['pen', 'eraser'].includes(stroke.tool) || !Array.isArray(stroke.points) || stroke.points.length > 3000) fail('그림 데이터를 확인해 주세요.');
    count += stroke.points.length;
    if (count > 40_000) fail('그림이 너무 복잡해요. 일부 선을 지운 뒤 다시 시도해 주세요.');
    const points = stroke.points.map(point => {
      if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isFinite(n) || n < 0 || n > 1)) fail('그림 좌표를 확인해 주세요.');
      return [...point];
    });
    return { tool: stroke.tool, color: stroke.color, size: stroke.size, points };
  });
}
function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

export class ClassroomStore {
  constructor({ phaseMs = {}, onUpdate = () => {} } = {}) {
    this.sessions = new Map();
    this.phaseMs = { ...PHASE_MS, ...phaseMs };
    this.testDescribingMs = phaseMs.describing;
    this.onUpdate = onUpdate;
    this.cleanup = setInterval(() => {
      for (const session of this.sessions.values()) if (Date.now() - session.updatedAt > 6 * 60 * 60 * 1000) {
        for (const group of session.groups) clearTimeout(group.timer);
        this.sessions.delete(session.code);
      }
    }, 60_000);
    this.cleanup.unref();
  }

  close() {
    clearInterval(this.cleanup);
    for (const session of this.sessions.values()) for (const group of session.groups) clearTimeout(group.timer);
  }

  create(input = {}) {
    if (this.sessions.size >= 100) fail('진행 중인 수업이 많아요. 잠시 후 다시 시도해 주세요.', 429);
    let code;
    do { code = String(randomInt(100000, 1_000_000)); } while (this.sessions.has(code));
    const teacher = { id: 'teacher', role: 'teacher', name: '선생님', token: token(), connected: false };
    const session = {
      code, title: text(input.title, 40) || '교육학과 진로체험', revision: 0,
      status: 'lobby', attempt: 1, settings: validateSettings(input.settings), paused: false,
      teacher, students: [], history: [], customWords: [], createdAt: Date.now(), updatedAt: Date.now(),
      groups: Array.from({ length: 4 }, (_, i) => ({
        id: String(i + 1), name: `${i + 1}모둠`, phase: 'lobby', explainerId: null, preferredExplainerId: null,
        deadline: null, remainingMs: 0, timerKind: null, timer: null, questionCount: 0,
        questionerId: null, answering: false, questionStage: null, messages: [], choices: [],
        word: null, results: null, revealedAt: null, minimumRevealDone: false
      }))
    };
    this.sessions.set(code, session); this.update(session);
    return { code, token: teacher.token, role: 'teacher', participantId: teacher.id };
  }

  get(code) {
    const session = this.sessions.get(String(code));
    if (!session) fail('수업을 찾을 수 없어요. 6자리 입장코드를 확인해 주세요.', 404);
    return session;
  }

  auth(session, value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('입장 정보가 없어요. 다시 입장해 주세요.', 401);
    const supplied = Buffer.from(value);
    for (const actor of [session.teacher, ...session.students]) if (timingSafeEqual(Buffer.from(actor.token), supplied)) return actor;
    fail('입장 정보가 만료되었어요. 다시 입장해 주세요.', 401);
  }

  join(code, input = {}) {
    const session = this.get(code);
    if (session.status !== 'lobby') fail(session.status === 'ended' ? '종료된 수업이에요. 선생님께 새 코드를 받아 주세요.' : '도전이 진행 중이에요. 선생님께 다음 도전 입장을 요청해 주세요.', 409);
    if (session.students.length >= 20) fail('수업 인원이 가득 찼어요. 최대 20명까지 참여할 수 있어요.', 409);
    const name = text(input.name, 16);
    if (!name) fail('실명 대신 사용할 별명을 입력해 주세요.');
    if (session.students.some(student => student.name === name)) fail('이미 사용 중인 별명이에요. 다른 별명을 정해 주세요.', 409);
    let groupId = null;
    if (session.settings.assignment === 'student' && input.groupId !== undefined && input.groupId !== null && input.groupId !== '') {
      const group = this.group(session, input.groupId);
      if (this.members(session, group).length >= 5) fail('이 모둠은 가득 찼어요. 다른 모둠을 골라 주세요.', 409);
      groupId = group.id;
    }
    const student = { id: identifier(), role: 'student', token: token(), name, groupId, connected: false, drawing: [], guess: null, reflection: null };
    session.students.push(student); this.update(session);
    return { code: session.code, token: student.token, role: student.role, participantId: student.id };
  }

  connected(session, actor) { actor.connected = true; this.update(session); }
  disconnected(session, actor) { actor.connected = false; if (this.sessions.has(session.code)) this.update(session); }
  update(session, metadata) { session.revision++; session.updatedAt = Date.now(); this.onUpdate(session, metadata); }
  group(session, id) { const group = session.groups.find(g => g.id === String(id)); if (!group) fail('모둠을 확인해 주세요.'); return group; }
  members(session, group) { return session.students.filter(student => student.groupId === group.id); }
  message(group, actor, value, kind = 'chat') {
    group.messages.push({ id: identifier(), actorId: actor?.id || null, playerId: actor?.id || null, name: actor?.name || '수업 안내', text: value, kind, time: Date.now() });
    group.messages = group.messages.slice(-100);
  }

  state(session, actor) {
    const isTeacher = actor.role === 'teacher';
    const ownGroup = session.groups.find(group => group.id === actor.groupId);
    const now = Date.now();
    const me = { id: actor.id, role: actor.role, name: actor.name, groupId: actor.groupId || null, isExplainer: ownGroup?.explainerId === actor.id, drawing: isTeacher ? [] : clone(actor.drawing), guess: isTeacher ? null : actor.guess, reflection: isTeacher ? null : clone(actor.reflection) };
    return {
      code: session.code, title: session.title, revision: session.revision, serverNow: now,
      status: session.status, attempt: session.attempt, settings: { ...session.settings }, paused: session.paused,
      students: session.students.map(student => ({ id: student.id, name: student.name, groupId: student.groupId, connected: student.connected })),
      teacherConnected: session.teacher.connected,
      groups: session.groups.map(group => {
        const own = group.id === actor.groupId;
        const detailed = isTeacher || own;
        const revealed = group.phase === 'reveal';
        const result = {
          id: group.id, name: group.name, phase: group.phase, explainerId: group.explainerId,
          preferredExplainerId: group.preferredExplainerId,
          deadline: group.deadline, remainingMs: group.deadline ? Math.max(0, group.deadline - now) : group.remainingMs,
          questionCount: group.questionCount, questionerId: group.questionerId, answering: group.answering,
          questionStage: group.questionStage, minimumRevealDone: group.minimumRevealDone,
          messages: detailed ? clone(group.messages) : [],
          ...(own && group.explainerId === actor.id && group.phase === 'choosing' ? { choices: [...group.choices] } : {}),
          ...((own && group.explainerId === actor.id || detailed && revealed) && group.word ? { word: group.word } : {}),
          ...(detailed && revealed && group.results ? { results: clone(group.results) } : {})
        };
        return result;
      }),
      history: session.history.map(item => ({ attempt: item.attempt, groups: clone(item.groups.filter(result => isTeacher || result.groupId === actor.groupId)) })),
      ...(isTeacher ? { customWords: [...session.customWords] } : {}),
      me
    };
  }

  schedule(session, group, kind, milliseconds) {
    clearTimeout(group.timer); group.timer = null; group.timerKind = kind;
    const ms = Math.max(0, milliseconds);
    group.remainingMs = ms;
    group.deadline = session.paused ? null : Date.now() + ms;
    if (!session.paused) {
      group.timer = setTimeout(() => {
        if (!this.sessions.has(session.code) || session.paused) return;
        group.timer = null; group.remainingMs = 0; group.deadline = null; group.timerKind = null;
        this.onTimeout(session, group, kind); this.update(session);
      }, Math.max(1, ms));
      group.timer.unref();
    }
  }

  onTimeout(session, group, kind) {
    if (kind === 'choose') this.choose(session, group, group.choices[0]);
    else if (kind === 'describe') this.nextQuestion(session, group);
    else if (kind === 'ask' || kind === 'answer') this.grace(session, group, '질문 시간이 끝났어요. 들은 내용을 그림에 반영해 보세요.');
    else if (kind === 'grace') this.nextQuestion(session, group);
    else if (kind === 'guess') this.reveal(session, group);
    else if (kind === 'reveal') { group.minimumRevealDone = true; this.message(group, null, '그림을 충분히 비교하고 교수법을 돌아보세요. 선생님이 다음 활동을 시작할 때까지 이 화면을 유지해요.', 'system'); }
  }

  startGroup(session, group) {
    const members = this.members(session, group);
    const previous = session.history.find(item => item.attempt === 1)?.groups.find(item => item.groupId === group.id)?.explainerId;
    let eligible = members.filter(student => student.id !== previous);
    if (!eligible.length) eligible = members;
    group.explainerId = members.some(student => student.id === group.preferredExplainerId) ? group.preferredExplainerId : eligible[randomInt(eligible.length)].id;
    const pool = [...new Set([...WORDS[session.settings.difficulty], ...session.customWords])];
    group.choices = shuffle(pool).slice(0, 5); group.word = null; group.results = null;
    group.phase = 'choosing'; group.messages = []; group.questionCount = 0; group.questionerId = null;
    group.answering = false; group.questionStage = null; group.minimumRevealDone = false; group.revealedAt = null;
    for (const student of members) { student.drawing = []; student.guess = null; student.reflection = null; }
    this.message(group, null, `${session.attempt}차 도전! 설명자는 제시어를 하나 골라 주세요.`, 'system');
    this.schedule(session, group, 'choose', this.phaseMs.choosing);
  }

  choose(session, group, word) {
    group.word = word; group.phase = 'describing';
    this.message(group, null, session.settings.mode === 'classroom' ? '설명자는 교실에서 말로 설명해 주세요. 들은 학생은 바로 그림을 그려요.' : '설명자는 정답 대신 모양과 위치를 구체적으로 설명해 주세요. 다른 학생은 채팅을 읽으며 그림을 그려요.', 'system');
    this.schedule(session, group, 'describe', this.testDescribingMs ?? session.settings.explanationSeconds * 1000);
  }

  nextQuestion(session, group) {
    if (group.questionCount >= session.settings.questionLimit) return this.guessing(session, group);
    const drawers = this.members(session, group).filter(student => student.id !== group.explainerId);
    if (!drawers.length) return this.guessing(session, group);
    const student = drawers[group.questionCount % drawers.length];
    group.questionCount++; group.phase = 'questioning'; group.questionerId = student.id;
    group.questionStage = 'ask'; group.answering = false;
    this.message(group, null, `${student.name} 님의 질문 차례예요. (${group.questionCount}/${session.settings.questionLimit})`, 'system');
    this.schedule(session, group, 'ask', this.phaseMs.ask ?? this.phaseMs.questioning);
  }

  grace(session, group, message) {
    group.questionerId = null; group.questionStage = 'grace'; group.answering = false;
    this.message(group, null, message || '답변을 들었나요? 10초 동안 그림을 보완해 보세요.', 'system');
    this.schedule(session, group, 'grace', this.phaseMs.grace);
  }

  guessing(session, group) {
    group.phase = 'guessing'; group.questionerId = null; group.questionStage = null; group.answering = false;
    this.message(group, null, '무엇을 그렸나요? 정답은 한 번만 제출할 수 있어요. 띄어쓰기는 달라도 괜찮아요.', 'system');
    this.schedule(session, group, 'guess', this.phaseMs.guessing);
  }

  reveal(session, group) {
    if (group.phase === 'reveal') return;
    if (!group.word) group.word = group.choices[0] || '미선택';
    const members = this.members(session, group);
    group.phase = 'reveal'; group.questionerId = null; group.questionStage = null; group.answering = false;
    group.revealedAt = Date.now(); group.minimumRevealDone = false;
    group.results = {
      groupId: group.id, groupName: group.name, attempt: session.attempt, word: group.word,
      explainerId: group.explainerId, explainerName: members.find(student => student.id === group.explainerId)?.name || '설명자',
      drawings: members.filter(student => student.id !== group.explainerId).map(student => ({ studentId: student.id, name: student.name, strokes: clone(student.drawing), guess: student.guess || '', correct: student.guess !== null && normalize(student.guess) === normalize(group.word) })),
      reflections: []
    };
    let attempt = session.history.find(item => item.attempt === session.attempt);
    if (!attempt) { attempt = { attempt: session.attempt, groups: [] }; session.history.push(attempt); }
    attempt.groups.push(clone(group.results));
    this.message(group, null, `정답은 ‘${group.word}’! 같은 설명이 어떻게 서로 다른 그림이 되었는지 비교해 보세요.`, 'system');
    this.schedule(session, group, 'reveal', this.phaseMs.reveal);
    if (session.groups.every(item => item.phase === 'reveal')) session.status = 'review';
  }

  explanation(group, value) {
    const result = text(value);
    if (!result) fail('설명이나 답변을 입력해 주세요.');
    const word = normalize(group.word || '');
    const normalizedText = normalize(result);
    if (word && normalizedText.includes(word)) fail('정답을 직접 말할 수 없어요. 모양과 특징으로 설명해 주세요.');
    // Single-letter clues and spelling out all syllables circumvent a word-only filter.
    const characters = [...word];
    if (word && (characters.includes(normalizedText) || characters.length > 1 && characters.join('') === normalize(result.replace(/[^\p{L}\p{N}]/gu, '')))) fail('정답 글자 대신 생김새와 특징을 설명해 주세요.');
    if (/(첫|끝|마지막|가운데)\s*(글자|음절)|초성\s*(은|이|:)|정답\s*(글자|철자)/u.test(result)) fail('정답의 글자나 초성 힌트 대신 모양과 특징을 설명해 주세요.');
    return result;
  }

  action(session, actor, action = {}) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') fail('요청을 확인해 주세요.');
    const teacher = () => { if (actor.role !== 'teacher') fail('선생님만 사용할 수 있는 기능이에요.', 403); };
    const student = () => { if (actor.role !== 'student') fail('학생만 사용할 수 있는 기능이에요.', 403); };
    const lobby = () => { if (session.status !== 'lobby') fail('대기실에서만 변경할 수 있어요.', 409); };
    const own = () => { student(); if (!actor.groupId) fail('먼저 모둠을 선택해 주세요.', 409); return this.group(session, actor.groupId); };
    const phase = (group, ...allowed) => { if (!allowed.includes(group.phase)) fail('지금은 할 수 없는 행동이에요.', 409); };
    const explainer = group => { if (group.explainerId !== actor.id) fail('설명자만 할 수 있어요.', 403); };
    if (session.status === 'ended' && !['reflection'].includes(action.type)) fail('종료된 수업이에요. 결과 화면은 계속 볼 수 있어요.', 409);
    if (session.paused && actor.role === 'student' && !['drawing', 'chat', 'reflection', 'switchGroup'].includes(action.type)) fail('선생님이 타이머를 멈췄어요. 재개할 때까지 기다려 주세요.', 409);
    switch (action.type) {
      case 'settings': teacher(); lobby(); session.settings = validateSettings(action.settings || action, session.settings); break;
      case 'customWords': {
        teacher(); lobby(); if (!Array.isArray(action.words) || action.words.length > 100) fail('추가 제시어는 100개까지 등록할 수 있어요.');
        const words = [...new Set(action.words.map(word => text(word, 30)).filter(Boolean))];
        if (words.some(word => word.length < 2)) fail('제시어는 두 글자 이상으로 적어 주세요.');
        session.customWords = words; break;
      }
      case 'assign': {
        teacher(); lobby(); const target = session.students.find(student => student.id === action.studentId); if (!target) fail('학생을 찾을 수 없어요.');
        this.assign(session, target, action.groupId); break;
      }
      case 'switchGroup': student(); lobby(); if (session.settings.assignment !== 'student') fail('선생님이 모둠을 배정하고 있어요.', 403); this.assign(session, actor, action.groupId); break;
      case 'autoAssign': {
        teacher(); lobby(); const students = shuffle(session.students);
        for (const group of session.groups) group.preferredExplainerId = null;
        students.forEach((student, i) => { student.groupId = String(i % 4 + 1); }); break;
      }
      case 'assignExplainer': {
        teacher(); lobby(); const group = this.group(session, action.groupId);
        if (action.studentId !== null && !this.members(session, group).some(student => student.id === action.studentId)) fail('해당 모둠의 학생을 선택해 주세요.');
        group.preferredExplainerId = action.studentId; break;
      }
      case 'start': {
        teacher(); lobby();
        if (session.students.some(student => !student.groupId)) fail('아직 모둠을 정하지 않은 학생이 있어요. 자동 편성이나 모둠 배정을 먼저 해주세요.', 409);
        if (session.groups.some(group => this.members(session, group).length < 3)) fail('모든 모둠에 3명 이상 모이면 동시에 시작할 수 있어요.', 409);
        session.status = 'playing'; session.paused = false;
        for (const group of session.groups) this.startGroup(session, group); break;
      }
      case 'pause': {
        teacher(); if (!['playing', 'review'].includes(session.status) || session.paused) fail('지금은 타이머를 일시정지할 수 없어요.', 409);
        session.paused = true;
        for (const group of session.groups) if (group.deadline !== null) { group.remainingMs = Math.max(0, group.deadline - Date.now()); group.deadline = null; clearTimeout(group.timer); group.timer = null; }
        break;
      }
      case 'resume': {
        teacher(); if (!session.paused) fail('이미 진행 중이에요.', 409); session.paused = false;
        for (const group of session.groups) if (group.timerKind) this.schedule(session, group, group.timerKind, group.remainingMs); break;
      }
      case 'reveal': {
        teacher(); if (!['playing', 'review'].includes(session.status)) fail('도전을 시작한 뒤 결과를 공개할 수 있어요.', 409);
        const selected = action.groupId ? [this.group(session, action.groupId)] : session.groups;
        for (const group of selected) this.reveal(session, group); break;
      }
      case 'extend': {
        teacher(); const seconds = action.seconds ?? 30;
        if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) fail('연장 시간은 5~300초로 정해 주세요.');
        const selected = (action.groupId ? [this.group(session, action.groupId)] : session.groups).filter(group => group.phase === 'reveal');
        if (!selected.length) fail('결과 공개 중에 시간을 연장할 수 있어요.', 409);
        for (const group of selected) { group.minimumRevealDone = false; this.schedule(session, group, 'reveal', (group.deadline ? Math.max(0, group.deadline - Date.now()) : group.remainingMs) + seconds * 1000); }
        break;
      }
      case 'hold': teacher(); if (!session.groups.some(group => group.phase === 'reveal')) fail('아직 공개된 결과가 없어요.', 409); break;
      case 'advance': {
        teacher(); const group = this.group(session, action.groupId);
        if (session.paused) fail('타이머를 재개한 뒤 다음 단계로 이동해 주세요.', 409);
        if (group.phase === 'choosing') this.choose(session, group, group.choices[0]);
        else if (group.phase === 'describing') this.nextQuestion(session, group);
        else if (group.phase === 'questioning' && group.questionStage === 'grace') this.nextQuestion(session, group);
        else if (group.phase === 'questioning') this.grace(session, group);
        else if (group.phase === 'guessing') this.reveal(session, group);
        else fail('이 단계에서는 이동할 수 없어요.', 409);
        break;
      }
      case 'nextAttempt': {
        teacher(); if (session.attempt !== 1 || session.status !== 'review' || !session.groups.every(group => group.phase === 'reveal' && group.minimumRevealDone)) fail('모든 모둠의 결과를 최소 15초 이상 살펴본 뒤 2차 도전을 시작해 주세요.', 409);
        session.attempt = 2; session.status = 'lobby'; session.paused = false;
        for (const group of session.groups) {
          clearTimeout(group.timer); group.timer = null; group.timerKind = null; group.deadline = null; group.remainingMs = 0;
          group.phase = 'lobby'; group.word = null; group.choices = []; group.results = null; group.messages = [];
          group.explainerId = null; group.preferredExplainerId = null; group.questionCount = 0; group.questionerId = null; group.answering = false; group.questionStage = null;
        }
        for (const student of session.students) { student.drawing = []; student.guess = null; student.reflection = null; }
        break;
      }
      case 'end': {
        teacher(); if (session.status === 'playing' || session.status === 'review') for (const group of session.groups) if (phaseIsActive(group.phase)) this.reveal(session, group);
        session.status = 'ended'; session.paused = false;
        for (const group of session.groups) { clearTimeout(group.timer); group.timer = null; group.timerKind = null; group.deadline = null; group.remainingMs = 0; }
        break;
      }
      case 'choose': { const group = own(); phase(group, 'choosing'); explainer(group); if (!group.choices.includes(action.word)) fail('다섯 개의 제시어 중 하나를 골라 주세요.'); this.choose(session, group, action.word); break; }
      case 'explain': { const group = own(); phase(group, 'describing', 'questioning'); explainer(group); this.message(group, actor, this.explanation(group, action.text), 'explain'); break; }
      case 'ready': { const group = own(); phase(group, 'describing'); explainer(group); this.nextQuestion(session, group); break; }
      case 'question': {
        const group = own(); phase(group, 'questioning');
        if (group.questionerId !== actor.id || group.questionStage !== 'ask') fail('지금은 내 질문 차례가 아니에요.', 409);
        const question = text(action.text); if (!question) fail('궁금한 점을 질문해 주세요.');
        this.message(group, actor, question, 'question'); group.answering = true; group.questionStage = 'answer';
        this.schedule(session, group, 'answer', this.phaseMs.answer ?? this.phaseMs.questioning); break;
      }
      case 'answer': case 'spoken-answer': {
        const group = own(); phase(group, 'questioning'); explainer(group);
        if (group.questionStage !== 'answer' && !(action.type === 'spoken-answer' && session.settings.mode === 'classroom' && group.questionStage === 'ask')) fail('먼저 학생의 질문을 기다려 주세요.', 409);
        if (action.type === 'spoken-answer' && session.settings.mode !== 'classroom') fail('교실에서 말로 설명 모드에서만 사용할 수 있어요.');
        const answer = action.type === 'spoken-answer' ? '교실에서 질문을 듣고 말로 답변했어요.' : this.explanation(group, action.text);
        this.message(group, actor, answer, 'answer'); this.grace(session, group); break;
      }
      case 'drawing': {
        const group = own(); phase(group, 'describing', 'questioning', 'guessing');
        if (group.explainerId === actor.id) fail('설명자는 그림 대신 설명에 집중해 주세요.', 403);
        actor.drawing = validateDrawing(action.strokes); break;
      }
      case 'guess': {
        const group = own(); phase(group, 'guessing'); if (group.explainerId === actor.id) fail('설명자는 정답을 제출하지 않아요.', 403);
        if (actor.guess !== null) fail('정답은 한 번만 제출할 수 있어요. 공개 시간을 기다려 주세요.', 409);
        const guess = text(action.text, 40); if (!guess) fail('정답을 적어 주세요.'); actor.guess = guess;
        if (this.members(session, group).filter(student => student.id !== group.explainerId).every(student => student.guess !== null)) this.reveal(session, group);
        break;
      }
      case 'chat': {
        const group = own(); phase(group, 'lobby', 'choosing', 'describing', 'questioning', 'reveal');
        let message = text(action.text); if (!message) fail('메시지를 입력해 주세요.');
        if (group.explainerId === actor.id && group.word && group.phase !== 'reveal') message = this.explanation(group, message);
        this.message(group, actor, message); break;
      }
      case 'reflection': {
        const group = own(); phase(group, 'reveal');
        if (!Array.isArray(action.answers) || action.answers.length !== 3 || action.answers.some(answer => typeof answer !== 'string')) fail('세 가지 돌아보기 질문에 답을 적어 주세요.');
        const answers = action.answers.map(answer => text(answer, 400));
        if (!answers.some(Boolean)) fail('하나 이상의 소감을 적어 주세요.');
        actor.reflection = { studentId: actor.id, name: actor.name, answers, strategy: text(action.strategy, 300), attempt: session.attempt };
        const reflections = group.results.reflections.filter(item => item.studentId !== actor.id); reflections.push(clone(actor.reflection)); group.results.reflections = reflections;
        const historyGroup = session.history.find(item => item.attempt === session.attempt)?.groups.find(item => item.groupId === group.id);
        if (historyGroup) historyGroup.reflections = clone(reflections);
        break;
      }
      default: fail('알 수 없는 요청이에요.');
    }
    this.update(session, action.type === 'drawing' ? { type: 'drawing', privateActorId: actor.id } : undefined);
  }

  assign(session, student, groupId) {
    const group = groupId === null || groupId === '' ? null : this.group(session, groupId);
    if (group && student.groupId !== group.id && this.members(session, group).length >= 5) fail('모둠당 최대 5명까지 참여할 수 있어요.', 409);
    const previous = session.groups.find(item => item.id === student.groupId);
    if (previous?.preferredExplainerId === student.id && previous.id !== group?.id) previous.preferredExplainerId = null;
    student.groupId = group?.id || null;
  }

  serialize() {
    const now = Date.now();
    const sessions = [...this.sessions.values()].map(session => {
      const snapshot = { ...session, teacher: { ...session.teacher, connected: false }, students: session.students.map(student => ({ ...student, connected: false })) };
      snapshot.groups = session.groups.map(group => ({ ...group, timer: undefined, remainingMs: group.deadline ? Math.max(0, group.deadline - now) : group.remainingMs, deadline: null }));
      return snapshot;
    });
    return JSON.stringify({ version: 1, savedAt: now, sessions });
  }

  restore(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) fail('저장된 수업 파일 형식을 확인해 주세요.');
    for (const existing of this.sessions.values()) for (const group of existing.groups) clearTimeout(group.timer);
    this.sessions.clear();
    for (const session of parsed.sessions) {
      if (!/^\d{6}$/.test(session.code) || !Array.isArray(session.groups) || session.groups.length !== 4 || !Array.isArray(session.students) || session.students.length > 20) fail('저장된 수업 데이터가 올바르지 않아요.');
      if (Date.now() - session.updatedAt > 6 * 60 * 60 * 1000) continue;
      session.settings = validateSettings(session.settings); session.teacher.connected = false;
      for (const student of session.students) student.connected = false;
      session.paused = ['playing', 'review'].includes(session.status);
      for (const group of session.groups) { group.timer = null; group.deadline = null; }
      session.revision++; this.sessions.set(session.code, session);
    }
    return this.sessions.size;
  }
}
