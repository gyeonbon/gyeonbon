import http from 'node:http';
import { mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { ClassroomStore, ClassroomError } from './lib/classroom.mjs';

const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const BODY_LIMIT = 2_000_000;

/** A single classroom server. DATA_DIR holds private, atomic recovery snapshots. */
export function createClassroomServer(options = {}) {
  const streams = new Map();
  const limits = new Map();
  const dataDir = options.dataDir === false ? null : resolve(options.dataDir || process.env.DATA_DIR || '.data');
  const snapshotPath = dataDir && resolve(dataDir, 'sessions.json');
  const publicDir = resolve(options.publicDir || DIST);
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin.replace(/\/$/, '')) throw new Error('PUBLIC_ORIGIN must be an origin such as https://example.com');
  let restoring = true, saveTimer, writeChain = Promise.resolve(), activeMutation;

  const streamKey = (session, actor) => `${session.code}:${actor.id}`;
  function broadcast(session, metadata = {}) {
    const privateActorId = metadata.privateActorId || (activeMutation?.session === session && activeMutation.type === 'drawing' ? activeMutation.actorId : null);
    const actors = privateActorId ? [session.teacher, ...session.students].filter(actor => actor.id === privateActorId) : [session.teacher, ...session.students];
    for (const actor of actors) {
      const connections = streams.get(streamKey(session, actor));
      if (!connections?.size) continue;
      const value = `event: state\ndata: ${JSON.stringify(store.state(session, actor))}\n\n`;
      for (const response of connections) if (!response.destroyed && !response.writableEnded) {
        if (response.writableLength > 2_000_000) response.end();
        else response.write(value);
      }
    }
  }
  function queuePersistence() {
    if (!snapshotPath || restoring || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, 250);
    saveTimer.unref();
  }
  function persist() {
    if (!snapshotPath) return Promise.resolve();
    clearTimeout(saveTimer); saveTimer = null;
    const snapshot = store.serialize();
    writeChain = writeChain.catch(() => {}).then(async () => {
      const temporary = `${snapshotPath}.tmp`;
      await writeFile(temporary, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, snapshotPath);
      server.storageError = null;
    }).catch(error => {
      // Do not log snapshot contents, tokens, or the request URL.
      server.storageError = '세션 복구 파일을 저장하지 못했습니다.';
      console.error(`복구 파일 저장 실패: ${error.code || 'UNKNOWN'}`);
    });
    return writeChain;
  }
  const store = new ClassroomStore({ ...options, onUpdate(session, metadata) { broadcast(session, metadata); queuePersistence(); } });
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700);
    if (existsSync(snapshotPath)) {
      try { store.restore(readFileSync(snapshotPath, 'utf8')); }
      catch (error) { store.close(); throw new Error(`세션 복구 파일을 읽지 못했습니다. 원본 파일을 보존하고 확인해 주세요. (${error.code || error.name})`); }
    }
  }
  restoring = false;
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const body = request => new Promise((resolveBody, reject) => {
    let size = 0, exceeded = false; const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ClassroomError('요청 데이터가 너무 큽니다. 그림의 일부 선을 지워 주세요.', 413)); }
        return;
      }
      if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        resolveBody(value);
      } catch { reject(new ClassroomError('올바르지 않은 요청입니다.', 400)); }
    });
    request.on('error', reject);
  });
  function rateLimit(key, maximum) {
    const now = Date.now(); let entry = limits.get(key);
    if (!entry || now - entry.start >= 60_000) { entry = { start: now, count: 0 }; limits.set(key, entry); }
    if (++entry.count > maximum) throw new ClassroomError('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health' && request.method === 'GET') return json(response, 200, { ok: true, recovery: server.storageError ? 'error' : dataDir ? 'enabled' : 'disabled' });
      if (url.pathname.startsWith('/api/')) {
        // School Wi-Fi often puts all twenty devices behind one IP address.
        rateLimit(`ip:${request.socket.remoteAddress}`, 60_000);
        if (request.method === 'POST' && request.headers.origin) {
          let origin;
          try { origin = new URL(request.headers.origin); } catch { throw new ClassroomError('허용되지 않은 요청 출처입니다.', 403); }
          const allowed = publicOrigin ? origin.origin === new URL(publicOrigin).origin : origin.host === request.headers.host;
          if (!allowed) throw new ClassroomError('허용되지 않은 요청 출처입니다.', 403);
        }
        if (url.pathname === '/api/sessions' && request.method === 'POST') {
          rateLimit(`create:${request.socket.remoteAddress}`, 60);
          return json(response, 201, store.create(await body(request)));
        }
        const match = url.pathname.match(/^\/api\/sessions\/(\d{6})\/(join|state|events|actions)$/);
        if (!match) throw new ClassroomError('요청한 API를 찾을 수 없습니다.', 404);
        const [, code, route] = match;
        if (route === 'join' && request.method === 'POST') return json(response, 200, store.join(code, await body(request)));
        const session = store.get(code);
        const token = route === 'events' ? url.searchParams.get('token') : request.headers.authorization?.replace(/^Bearer /, '');
        const actor = store.auth(session, token);
        rateLimit(`actor:${code}:${actor.id}`, 1200);
        if (route === 'events' && request.method === 'GET') {
          const key = streamKey(session, actor);
          if (!streams.has(key)) streams.set(key, new Set());
          const connections = streams.get(key);
          if (connections.size >= 5) throw new ClassroomError('동일한 참가자의 열린 화면이 너무 많습니다. 다른 탭을 닫아 주세요.', 429);
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          connections.add(response); store.connected(session, actor);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000); heartbeat.unref();
          request.on('close', () => {
            clearInterval(heartbeat); connections.delete(response);
            if (!connections.size) {
              streams.delete(key);
              try { if (store.get(code) === session) store.disconnected(session, actor); } catch {}
            }
          });
          return;
        }
        if (route === 'state' && request.method === 'GET') return json(response, 200, store.state(session, actor));
        if (route === 'actions' && request.method === 'POST') {
          const action = await body(request);
          activeMutation = { session, actorId: actor.id, type: action.type };
          try { store.action(session, actor, action); } finally { activeMutation = null; }
          return json(response, 200, { state: store.state(session, actor) });
        }
        throw new ClassroomError('지원하지 않는 요청 방식입니다.', 405);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ClassroomError('지원하지 않는 요청 방식입니다.', 405);
      const relative = decodeURIComponent(url.pathname);
      let filename = resolve(publicDir, `.${relative}`);
      if (!filename.startsWith(publicDir + sep) && filename !== publicDir) throw new ClassroomError('접근할 수 없습니다.', 403);
      if (!extname(relative) || relative === '/') filename = resolve(publicDir, 'index.html');
      let content;
      try { content = await readFile(filename); }
      catch { throw new ClassroomError(filename.endsWith('index.html') ? '화면을 아직 빌드하지 않았습니다. npm run build를 실행해 주세요.' : '파일을 찾을 수 없습니다.', 404); }
      response.writeHead(200, { 'Content-Type': MIME[extname(filename)] || 'application/octet-stream', 'Cache-Control': filename.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof ClassroomError ? error.status : 500, { error: error instanceof ClassroomError ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      else response.end();
    }
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of limits) if (now - entry.start >= 60_000) limits.delete(key);
    // The engine expires idle sessions before this timer; also purge the disk snapshot.
    if (snapshotPath) void persist();
  }, 60_000); cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup); clearTimeout(saveTimer);
    for (const connections of streams.values()) for (const connection of connections) connection.end();
    store.close(); void persist();
  });
  server.classroomStore = store;
  server.flushPersistence = persist;
  server.storageError = null;
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

export const createGameServer = createClassroomServer;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createClassroomServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`블라인드 티칭 챌린지 서버가 ${port} 포트에서 실행 중입니다.`));
  const shutdown = async () => { await server.flushPersistence(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
