import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { paint, type Stroke } from './media';

export type DrawingHandle = { flush: () => Promise<void> };
type Props = { initialStrokes: Stroke[]; storageKey: string; disabled: boolean; onSave: (strokes: Stroke[]) => Promise<unknown> };
const colors = ['#35415d', '#ed797d', '#e8ad4f', '#7aaf8d', '#699bdb', '#a18ad0'];

const DrawingBoard = forwardRef<DrawingHandle, Props>(function DrawingBoard({initialStrokes,storageKey,disabled,onSave}, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const lines = useRef<Stroke[]>(initialStrokes || []);
  const redo = useRef<Stroke[]>([]);
  const active = useRef<Stroke | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(onSave); saveRef.current = onSave;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const pending = useRef(false);
  const mounted = useRef(true);
  const saving = useRef<Promise<void> | null>(null);
  const changeVersion = useRef(0);
  const lastCheckpoint = useRef(0);
  const [tool,setTool] = useState<'pen'|'eraser'>('pen');
  const [color,setColor] = useState(colors[0]);
  const [size,setSize] = useState(6);
  const [count,setCount] = useState(lines.current.length);
  const [saveState,setSaveState] = useState('자동 저장 준비');
  const [clearOpen,setClearOpen] = useState(false);

  function draw() { if(canvas.current) paint(canvas.current,lines.current); setCount(lines.current.length); }
  function backup(isPending: boolean) {
    try {localStorage.setItem(storageKey,JSON.stringify({strokes:lines.current,pending:isPending}));}catch{if(mounted.current)setSaveState('기기 저장 공간이 부족해요 · 서버 저장은 계속돼요');}
  }
  async function flush():Promise<void> {
    if(timer.current)clearTimeout(timer.current);
    if(saving.current){await saving.current; if(pending.current)return flush(); return;}
    if(!pending.current || disabledRef.current)return;
    const version=changeVersion.current, snapshot=structuredClone(lines.current);
    const operation=(async()=>{
      try {
        await saveRef.current(snapshot);
        if(version===changeVersion.current){pending.current=false;backup(false);}
        if(mounted.current)setSaveState('서버에 저장했어요 ✓');
      } catch(error) {if(mounted.current)setSaveState('기기에 보관 중 · 연결되면 다시 저장해요'); throw error;}
    })();
    saving.current=operation;
    try{await operation;}finally{saving.current=null;}
  }
  useImperativeHandle(ref,()=>({flush}));
  useEffect(()=>{
    mounted.current=true;
    try{const local=JSON.parse(localStorage.getItem(storageKey)||'null');if(local?.pending&&Array.isArray(local.strokes)){lines.current=local.strokes;pending.current=true;}}catch{}
    draw();
    const retry=setInterval(()=>{if(pending.current&&!active.current&&!disabledRef.current)flush().catch(()=>{});},2000);
    return()=>{mounted.current=false;clearInterval(retry);if(timer.current)clearTimeout(timer.current);if(pending.current)backup(true);};
  },[storageKey]);
  function changed(){pending.current=true;changeVersion.current++;backup(true);setSaveState('저장하는 중…');if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>flush().catch(()=>{}),160);draw();}
  function point(e:PointerEvent<HTMLCanvasElement>):[number,number]{const r=e.currentTarget.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
  function start(e:PointerEvent<HTMLCanvasElement>){
    if(disabled||e.button>0||active.current)return;
    if(lines.current.length>=400){setSaveState('선이 많이 쌓였어요. 실행 취소로 일부를 정리해 주세요.');return;}
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
    active.current={tool,color,size,points:[point(e)]};lines.current.push(active.current);redo.current=[];lastCheckpoint.current=Date.now();changed();
  }
  function move(e:PointerEvent<HTMLCanvasElement>){if(!active.current)return;const p=point(e),last=active.current.points.at(-1)!;if(Math.hypot(p[0]-last[0],p[1]-last[1])<.0015)return;if(active.current.points.length<1000)active.current.points.push(p);if(canvas.current)paint(canvas.current,lines.current);if(Date.now()-lastCheckpoint.current>350){lastCheckpoint.current=Date.now();changed();}}
  function finish(){if(!active.current)return;active.current=null;changed();}
  useEffect(()=>{if(disabled)finish();},[disabled]);
  return <section className="canvas-card card">
    <div className="canvas-header"><strong>✏️ 나만의 스케치북</strong><span>공개 전까지 나만 볼 수 있어요</span></div>
    <div className="canvas-wrap"><canvas ref={canvas} width={1000} height={650} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} aria-label="손가락이나 마우스로 그리는 개인 그림판" aria-disabled={disabled} style={{cursor:disabled?'not-allowed':tool==='eraser'?'cell':'crosshair',touchAction:'none'}} />{count===0&&<div className="canvas-placeholder"><span>🎨</span><strong>설명을 듣고, 상상을 그려요</strong><small>잘 그리는 것보다 잘 듣는 게 중요해요!</small></div>}{disabled&&<span className="canvas-lock">⏸ 잠깐, 선생님의 안내를 들어요</span>}</div>
    <div className="toolbar" role="toolbar" aria-label="그림 도구">
      <div className="tool-group"><button className={`tool-button ${tool==='pen'?'active':''}`} onClick={()=>setTool('pen')} aria-label="펜" aria-pressed={tool==='pen'} disabled={disabled}>✎</button><button className={`tool-button ${tool==='eraser'?'active':''}`} onClick={()=>setTool('eraser')} aria-label="지우개" aria-pressed={tool==='eraser'} disabled={disabled}>▱</button></div>
      <div className="tool-group color-tools">{colors.map((c,i)=><button key={c} className={`color-swatch ${color===c&&tool==='pen'?'active':''}`} style={{backgroundColor:c}} onClick={()=>{setColor(c);setTool('pen');}} aria-label={`${['남색','분홍','노랑','초록','파랑','보라'][i]} 펜`} aria-pressed={color===c&&tool==='pen'} disabled={disabled}/>)}</div>
      <select className="size-select" value={size} onChange={e=>setSize(Number(e.target.value))} aria-label="펜 굵기" disabled={disabled}><option value={3}>가는 선</option><option value={6}>보통 선</option><option value={12}>굵은 선</option></select>
      <div className="tool-group history-tools"><button className="tool-button" onClick={()=>{if(lines.current.length){redo.current.push(lines.current.pop()!);changed();}}} disabled={disabled||count===0} aria-label="실행 취소">↶</button><button className="tool-button" onClick={()=>{if(redo.current.length){lines.current.push(redo.current.pop()!);changed();}}} disabled={disabled||redo.current.length===0} aria-label="다시 실행">↷</button><button className="tool-button" onClick={()=>setClearOpen(true)} disabled={disabled||count===0} aria-label="전체 지우기">⌫</button></div>
    </div>
    {clearOpen&&<div className="clear-confirm" role="alert"><span>그림을 모두 지울까요?</span><button className="danger small" onClick={()=>{lines.current=[];redo.current=[];setClearOpen(false);changed();}}>모두 지우기</button><button className="ghost small" onClick={()=>setClearOpen(false)}>취소</button></div>}
    <div className="canvas-status" role="status"><span>손가락으로 그려보세요</span><span>{saveState}</span></div>
  </section>;
});
export default DrawingBoard;
