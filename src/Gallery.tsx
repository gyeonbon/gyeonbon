import { useEffect, useRef, useState, type FormEvent } from 'react';
import { exportDrawing, exportGallery, paint } from './media';

type GalleryProps = {
  groups: any[];
  history: any[];
  attempt: number;
  isTeacher: boolean;
  students: any[];
  me: any;
  onAction: (type: string, data?: any) => Promise<any>;
  presentation: boolean;
};

const PROMPTS = [
  '같은 설명을 들었는데 왜 서로 다른 그림이 나왔을까요?',
  '상대방이 이해하기 어려웠던 설명은 무엇이었나요?',
  '어떻게 설명했다면 더 정확하게 전달할 수 있었을까요?',
];

const PRINCIPLES = [
  { icon: '🔎', title: '구체적으로 설명하기', copy: '“예쁘게 생겼어”보다 모양, 위치, 크기를 알려주세요.', example: '“큰 원 위에 작은 삼각형 두 개가 있어.”' },
  { icon: '🪜', title: '쉬운 내용부터 순서대로', copy: '큰 모양부터 시작하고, 작은 특징을 하나씩 더해요.', example: '“먼저 몸통을 그리고, 그다음 바퀴를 그려봐.”' },
  { icon: '💬', title: '질문으로 이해 확인하기', copy: '상대방이 어떻게 이해했는지 물어보고 설명을 조정해요.', example: '“어떤 모양으로 이해했어? 위치를 다시 볼까?”' },
];

function ArtCanvas({ drawing, label }: { drawing: any; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = drawing.strokes || drawing.drawing || [];
  useEffect(() => paint(ref.current, strokes), [strokes]);
  return <canvas ref={ref} width={1000} height={650} role="img" aria-label={label} />;
}

function normalizeGroups(entry: any): any[] {
  return (entry?.groups || []).map((group: any, index: number) => ({
    id: group.id || group.groupId || String(index + 1),
    name: group.name || group.groupName || `${index + 1}모둠`,
    results: group.results || group,
  }));
}

function reflectionAnswers(reflection: any): string[] {
  return Array.isArray(reflection?.answers) ? reflection.answers : ['', '', ''];
}

export function Gallery({ groups, history = [], attempt, isTeacher, students: _students, me, onAction, presentation }: GalleryProps) {
  const [filter, setFilter] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [answers, setAnswers] = useState<string[]>(reflectionAnswers(me?.reflection));
  const [strategy, setStrategy] = useState(me?.reflection?.strategy || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const reflectionVersion = JSON.stringify(me?.reflection || null);

  useEffect(() => {
    setAnswers(reflectionAnswers(me?.reflection));
    setStrategy(me?.reflection?.strategy || '');
    setSaved(Boolean(me?.reflection));
    setSaveError('');
  }, [attempt, me?.id, reflectionVersion]);

  useEffect(() => setFilter('all'), [attempt]);

  const revealed = groups.filter((group) => group.results && group.phase === 'reveal');
  const visible = revealed.filter((group) => filter === 'all' || group.id === filter);
  const reflections = visible.flatMap((group) => (group.results.reflections || []).map((reflection: any) => ({ ...reflection, groupName: group.name })));
  const ownResult = revealed.flatMap((group) => group.results.drawings || []).find((drawing) => drawing.studentId === me?.id);
  const attempts = history.map((entry) => ({ ...entry, groups: normalizeGroups(entry) })).sort((a, b) => a.attempt - b.attempt);
  const canCompare = attempts.some((entry) => entry.attempt === 1) && (attempt >= 2 || attempts.some((entry) => entry.attempt === 2));

  async function saveReflection(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setSaveError('');
    try {
      await onAction('reflection', { answers: answers.map((value) => value.trim()), strategy: strategy.trim() });
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '소감을 저장하지 못했어요. 다시 시도해 주세요.');
    } finally { setSaving(false); }
  }

  async function saveGallery() {
    setExporting(true); setExportError('');
    try { await exportGallery(visible, `블라인드 티칭 챌린지 · ${attempt}차 도전`); }
    catch (error) { setExportError(error instanceof Error ? error.message : '결과 이미지를 저장하지 못했어요.'); }
    finally { setExporting(false); }
  }

  if (!revealed.length) return <section className="card gallery-empty"><span aria-hidden="true">🖼️</span><h2>우리의 그림이 모일 자리를 준비했어요.</h2><p className="muted">결과가 공개되면 같은 설명으로 그린 서로 다른 그림을 함께 볼 수 있어요.</p></section>;

  return <div className={presentation ? 'gallery-content presentation' : 'gallery-content'}>
    <section className="gallery-section" aria-labelledby="gallery-title">
      <div className="gallery-header">
        <div><span className="eyebrow">같은 설명, 서로 다른 그림</span><h2 id="gallery-title">같은 설명을 들었는데,<br />그림은 왜 다를까요?</h2><p className="muted">잘 그렸는지보다, 어떻게 서로 이해했는지 살펴봐요.</p></div>
        <div className="gallery-tools">
          {isTeacher && <label className="gallery-filter"><span className="sr-only">결과를 볼 모둠</span><select className="field" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">모든 모둠 함께 보기</option>{revealed.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
          <button className="secondary export-button" type="button" onClick={saveGallery} disabled={exporting || !visible.length}>{exporting ? '이미지 만드는 중…' : '↓ 결과 이미지 저장'}</button>
        </div>
      </div>
      {exportError && <p className="error export-error" role="alert">{exportError}</p>}
      {visible.map((group) => <article className="gallery-group card" key={group.id}>
        <div className="answer-reveal"><div><span className="attempt-tag">{attempt}차 도전 · {group.name}</span><h3>제시어는 <strong>{group.results.word}</strong><span aria-hidden="true"> ✨</span></h3><p>설명자 <strong>{group.results.explainerName || '친구'}</strong></p></div><span className="gallery-group-icon" aria-hidden="true">🎨</span></div>
        <div className="gallery-grid">
          {(group.results.drawings || []).map((drawing: any) => <article className="art-card" key={drawing.studentId}>
            <div className="art-canvas"><ArtCanvas drawing={drawing} label={`${drawing.name} 님이 설명을 듣고 그린 그림`} /></div>
            <div className="art-caption"><div className="art-name"><span aria-hidden="true">{drawing.correct ? '🌟' : '🌱'}</span> {drawing.name}{drawing.studentId === me?.id && <span className="pill small">나</span>}</div><p className={`art-guess ${drawing.correct ? 'correct' : 'incorrect'}`}><span>{drawing.correct ? '✓ 정답' : '다르게 생각했어요'}</span><strong>{drawing.guess || '정답 미제출'}</strong></p>{drawing.studentId === me?.id && <button className="ghost small" type="button" onClick={() => exportDrawing(drawing, group.results.word).catch((error) => setExportError(error.message))}>내 그림 저장 ↗</button>}</div>
          </article>)}
        </div>
      </article>)}
    </section>

    <section className="feedback-section" aria-labelledby="feedback-title">
      <div className="section-heading"><div><span className="eyebrow">교육 전문가의 시선으로</span><h2 id="feedback-title">교수법 돌아보기</h2><p className="muted">내가 아는 것과, 다른 사람을 이해시키는 것은 달라요.</p></div><span className="pill">교육 전문가의 피드백 · 함께 생각해봐요</span></div>
      <div className="reflection-grid">{PROMPTS.map((prompt, index) => <article className="reflection-card" key={prompt}><span className="principle-number">0{index + 1}</span><h3>{prompt}</h3><p>{['사람마다 떠올린 경험과 익숙한 모양이 다를 수 있어요.', '“그쪽”, “적당히”처럼 기준이 없던 말은 없었나요?', '순서와 구체적인 기준을 더해 다시 설명해 보세요.'][index]}</p></article>)}</div>

      {!isTeacher && <form className="reflection-form card" onSubmit={saveReflection}>
        <div className="reflection-heading"><h3>내가 느낀 점을 남겨볼까요?</h3><p className="muted">한 문장씩만 적어도 괜찮아요. 실명이나 연락처는 적지 마세요.</p></div>
        {PROMPTS.map((prompt, index) => <label className="input-group" key={prompt}><span>{index + 1}. {prompt}</span><textarea className="field" rows={2} maxLength={300} value={answers[index] || ''} onChange={(event) => { setAnswers((previous) => previous.map((value, i) => i === index ? event.target.value : value)); setSaved(false); }} placeholder={['내가 떠올린 것과 친구가 떠올린 것은…', '이 설명을 들었을 때 헷갈렸어요…', '다시 설명한다면 이렇게 말할래요…'][index]} /></label>)}
        <label className="input-group"><span>{attempt === 1 ? '다음 도전에 써보고 싶은 설명 전략' : '이번에 바꿔본 설명 방식과 느낀 점'} <small className="muted">선택</small></span><textarea className="field" rows={2} maxLength={300} value={strategy} onChange={(event) => { setStrategy(event.target.value); setSaved(false); }} placeholder="예: 큰 모양부터 설명하고, 위치가 맞는지 질문할래요." /></label>
        {saveError && <p className="error" role="alert">{saveError}</p>}
        <div className="control-row"><button className="primary" type="submit" disabled={saving}>{saving ? '저장 중…' : saved ? '✓ 소감 저장됨 · 수정 내용 저장' : '내 소감 저장하기'}</button>{saved && <span className="muted" role="status">선생님과 모둠의 돌아보기에 함께 남겼어요.</span>}</div>
      </form>}

      {isTeacher && <section className="card reflection-summary"><div className="card-header"><h3>학생들의 목소리</h3><span className="pill">{reflections.length}명 소감</span></div>{reflections.length ? <div className="reflection-grid">{reflections.map((reflection: any) => <article className="reflection-card" key={`${reflection.groupName}-${reflection.studentId}`}><h4>{reflection.groupName} · {reflection.name}</h4>{reflectionAnswers(reflection).map((answer, index) => answer && <p className="reflection-answer" key={index}><strong>{index + 1}번 생각</strong><span>{answer}</span></p>)}{reflection.strategy && <p className="reflection-answer"><strong>설명 전략</strong><span>{reflection.strategy}</span></p>}</article>)}</div> : <p className="muted">학생들이 소감을 남기면 여기에 모입니다. 지금은 위 질문으로 함께 이야기해 보세요.</p>}</section>}

      <section className="good-principles"><div className="section-heading"><div><span className="eyebrow">좋은 설명을 위한 작은 안내서</span><h2>좋은 설명을 위한 3가지 원칙</h2></div></div><div className="principle-grid">{PRINCIPLES.map((principle, index) => <article className="principle-card" key={principle.title}><span className="principle-icon" aria-hidden="true">{principle.icon}</span><span className="principle-number">0{index + 1}</span><h3>{principle.title}</h3><p>{principle.copy}</p><blockquote>{principle.example}</blockquote></article>)}</div></section>
      <p className="feedback-note">이 피드백은 함께 생각해 볼 수 있도록 준비한 교수·학습 안내입니다. 그림 실력이나 개인의 능력을 평가하지 않아요.</p>
    </section>

    {canCompare && <section className="comparison-section" aria-labelledby="comparison-title"><div className="section-heading"><div><span className="eyebrow">도전하고, 돌아보고, 다시 도전하기</span><h2 id="comparison-title">1차와 2차, 설명은 어떻게 달라졌나요?</h2><p className="muted">정답 개수보다 설명 방식의 변화와 느낀 점에 주목해요.</p></div></div><div className="comparison-grid">{[1, 2].map((number) => {
      const entry = attempts.find((item) => item.attempt === number);
      const entries = entry?.groups || (number === attempt ? revealed : []);
      const forViewer = entries.filter((group: any) => isTeacher || group.results?.explainerId === me?.id || (group.results?.drawings || []).some((drawing: any) => drawing.studentId === me?.id));
      return <article className="comparison-card card" key={number}><span className="attempt-tag">{number}차 도전</span><h3>{number === 1 ? '전략을 배우기 전' : '좋은 설명 전략을 배운 후'}</h3>{forViewer.length ? forViewer.map((group: any) => <div className="comparison-notes" key={group.id}><p className="comparison-word"><strong>{group.name}</strong><span>제시어 {group.results.word}</span></p><div className="comparison-drawings">{(group.results.drawings || []).slice(0, 4).map((drawing: any) => <div className="art-canvas" key={drawing.studentId}><ArtCanvas drawing={drawing} label={`${number}차 ${drawing.name} 님의 그림`} /></div>)}</div>{(group.results.reflections || []).filter((reflection: any) => isTeacher || reflection.studentId === me?.id).map((reflection: any) => <p className="reflection-answer" key={reflection.studentId}><strong>{reflection.name}의 전략</strong><span>{reflection.strategy || reflectionAnswers(reflection)[2] || '아직 소감을 남기지 않았어요.'}</span></p>)}</div>) : <p className="muted">{number === 2 ? '2차 도전 결과가 공개되면 함께 비교해요.' : '아직 공개된 결과가 없어요.'}</p>}</article>;
    })}</div><p className="feedback-note">두 도전의 제시어와 난이도가 다를 수 있어요. 정답률 변화만으로 교수법의 효과를 판정하지 않고, 설명의 순서·구체성·질문 방식과 학생들의 소감을 함께 살펴봐요.</p></section>}

    {!presentation && <section className="bridge-card card"><span aria-hidden="true">🛠️</span><div><span className="eyebrow">다음 활동: 나만의 학습 도구 만들기</span><h2>다음 미션: AI와 학습 도구 만들기</h2><p>지금 친구가 어려워했던 부분을 도와줄 도구를 상상해 보세요.</p><div className="control-row"><span className="pill">💡 모양을 순서대로 알려주는 힌트 도구</span><span className="pill">🧩 이해 정도를 확인하는 퀴즈</span><span className="pill">📚 쉬운 말로 풀어주는 단어장</span></div><p className="muted">누가 사용할지, 무엇이 어려운지, 어떤 도움을 줄지 정한 뒤 AI와 함께 만들어봐요.</p></div></section>}
      {ownResult && <p className="sr-only">내가 제출한 정답: {ownResult.guess || '미제출'}</p>}
  </div>;
}

export default Gallery;
