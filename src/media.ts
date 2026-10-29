export type Stroke = {
  color: string;
  size: number;
  tool: 'pen' | 'eraser';
  points: number[][];
};

const PAPER = '#fffdf7';
const INK = '#25304b';
const FONT = "'Pretendard', 'Noto Sans KR', system-ui, sans-serif";

/** Points are normalized so the same drawing keeps its shape on every screen. */
export function paint(canvas: HTMLCanvasElement | null, strokes: Stroke[] = []) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const stroke of strokes) {
    const points = stroke.points?.filter((point) => point.length === 2 && point.every(Number.isFinite));
    if (!points?.length) continue;
    const size = Math.max(1, stroke.size || 4) * (stroke.tool === 'eraser' ? 4 : 1) * canvas.width / 1000;
    context.strokeStyle = stroke.tool === 'eraser' ? PAPER : stroke.color;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.arc(points[0][0] * canvas.width, points[0][1] * canvas.height, size / 2, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(points[0][0] * canvas.width, points[0][1] * canvas.height);
    for (const point of points.slice(1)) context.lineTo(point[0] * canvas.width, point[1] * canvas.height);
    context.stroke();
  }
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const character of String(text)) {
    if (character === '\n' || (line && context.measureText(line + character).width > maxWidth)) {
      lines.push(line);
      line = character === '\n' ? '' : character;
    } else line += character;
  }
  if (line) lines.push(line);
  return lines;
}

function text(context: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, lineHeight: number, maxLines = 2) {
  const lines = wrapText(context, value, width);
  lines.slice(0, maxLines).forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
}

async function saveCanvas(canvas: HTMLCanvasElement, filename: string) {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('이미지를 만들지 못했어요. 다시 시도해 주세요.')), 'image/png'));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Export only the already-revealed results passed by the caller. No screenshots or third-party service. */
export async function exportGallery(groups: any[], title = '블라인드 티칭 챌린지') {
  const revealed = groups.filter((group) => group.results?.drawings?.length);
  if (!revealed.length) throw new Error('아직 저장할 그림이 없어요. 결과 공개 후 다시 눌러주세요.');
  await document.fonts.ready;
  const width = 1400;
  const margin = 48;
  const gap = 24;
  const cardWidth = (width - margin * 2 - gap) / 2;
  const pictureHeight = cardWidth * 650 / 1000;
  const cardHeight = pictureHeight + 98;
  const heights = revealed.map((group) => 122 + Math.ceil(group.results.drawings.length / 2) * (cardHeight + gap) + 24);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.ceil(200 + heights.reduce((sum, h) => sum + h, 0) + 76);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이 브라우저에서는 그림 저장을 사용할 수 없어요.');
  context.fillStyle = '#f5f2ff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = INK;
  context.font = `800 38px ${FONT}`;
  text(context, title, margin, 73, width - margin * 2, 46);
  context.font = `500 22px ${FONT}`;
  context.fillStyle = '#6a6980';
  context.fillText('아는 것과 가르치는 것은 다르다! · 같은 설명, 서로 다른 그림', margin, 157);

  let top = 200;
  for (let groupIndex = 0; groupIndex < revealed.length; groupIndex++) {
    const group = revealed[groupIndex];
    const result = group.results;
    context.fillStyle = INK;
    context.font = `800 31px ${FONT}`;
    text(context, `${group.name || result.groupName || '우리 모둠'} · 제시어 ${result.word}`, margin, top + 37, width - margin * 2, 38, 1);
    context.font = `500 22px ${FONT}`;
    context.fillStyle = '#747087';
    context.fillText(`설명자 ${result.explainerName || '친구'}`, margin, top + 78);

    for (let i = 0; i < result.drawings.length; i++) {
      const drawing = result.drawings[i];
      const x = margin + (i % 2) * (cardWidth + gap);
      const y = top + 108 + Math.floor(i / 2) * (cardHeight + gap);
      const picture = document.createElement('canvas');
      picture.width = 1000;
      picture.height = 650;
      paint(picture, drawing.strokes || drawing.drawing || []);
      context.fillStyle = '#ffffff';
      context.fillRect(x, y, cardWidth, cardHeight);
      context.drawImage(picture, x, y, cardWidth, pictureHeight);
      context.strokeStyle = '#ddd8ec';
      context.lineWidth = 1;
      context.strokeRect(x, y, cardWidth, cardHeight);
      context.fillStyle = INK;
      context.font = `700 24px ${FONT}`;
      text(context, drawing.name || '친구', x + 20, y + pictureHeight + 35, cardWidth - 40, 28, 1);
      context.fillStyle = drawing.correct ? '#227b69' : '#8d6c5b';
      context.font = `500 21px ${FONT}`;
      text(context, `${drawing.correct ? '✓ 정답' : '다르게 생각했어요'} · ${drawing.guess || '정답 미제출'}`, x + 20, y + pictureHeight + 71, cardWidth - 40, 26, 1);
    }
    top += heights[groupIndex];
  }
  context.fillStyle = '#79738e';
  context.font = `500 19px ${FONT}`;
  text(context, '정답률만으로 설명의 효과를 판단하지 않아요. 설명 방식과 서로의 생각을 함께 살펴보세요.', margin, canvas.height - 40, width - margin * 2, 25);
  await saveCanvas(canvas, '블라인드-티칭-챌린지-결과.png');
}

export async function exportDrawing(drawing: any, word: string) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 750;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이 브라우저에서는 그림 저장을 사용할 수 없어요.');
  const picture = document.createElement('canvas');
  picture.width = 1000;
  picture.height = 650;
  paint(picture, drawing.strokes || drawing.drawing || []);
  context.fillStyle = PAPER;
  context.fillRect(0, 0, 1000, 750);
  context.drawImage(picture, 0, 0);
  context.fillStyle = INK;
  context.font = `700 25px ${FONT}`;
  text(context, `${drawing.name || '나'}의 그림 · 제시어 ${word}`, 30, 706, 940, 30, 1);
  await saveCanvas(canvas, '블라인드-티칭-나의-그림.png');
}
