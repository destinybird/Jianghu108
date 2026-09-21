// 中国象棋残局数据检查器（按用户列出的 5 条规则）
import { readFileSync } from 'node:fs';

const all = JSON.parse(readFileSync('江湖残局.json', 'utf8')).problems;
const FILES = 'ABCDEFGHI';
// 棋子用字：数据已统一为繁体（帅→帥、士→仕、象→相、炮→砲、马→馬），
// 但选项文本里仍可能是旧字形，因此各判据一律同时接受新旧两种写法。
const CHARIOT = '車车', HORSE = '馬马', CANNON = '砲炮', PAWN = '兵卒',
  KING_R = '帥帅', KING_B = '将將', ADV = '士仕', ELE = '象相';
const isChariot = (p) => CHARIOT.includes(p), isAdv = (p) => ADV.includes(p),
  isEle = (p) => ELE.includes(p), isCannon = (p) => CANNON.includes(p);
const isKing = (p) => KING_R.includes(p) || KING_B.includes(p);
const fileIdx = (c) => FILES.indexOf(c);
const inBoard = (f, r) => f >= 0 && f <= 8 && r >= 1 && r <= 10;
const inPalace = (side, f, r) => f >= 3 && f <= 5 && (side === 'Red' ? r >= 1 && r <= 3 : r >= 8 && r <= 10);
const ownHalf = (side, r) => (side === 'Red' ? r <= 5 : r >= 6);
const opp = (s) => (s === 'Red' ? 'Black' : 'Red');
// 棋子名归一化：字形变体一律视为同一子（数据用繁体、选项文本可能仍是旧字形）
const norm = (ch) => ({ 帥: '帅', 帅: '帅', 仕: '士', 士: '士', 相: '象', 象: '象',
  砲: '炮', 炮: '炮', 馬: '马', 马: '马', 車: '车', 车: '车', 將: '将', 将: '将' }[ch] || ch);

const parseSide = (str) => {
  const out = [];
  for (const tok of (str || '').trim().split(/\s+/)) {
    if (!tok) continue;
    const m = tok.match(/^([\u4e00-\u9fa5]+)([A-I])(10|[1-9])$/);
    if (!m) { out.push({ bad: tok }); continue; }
    out.push({ piece: m[1], f: fileIdx(m[2]), r: Number(m[3]), tok, file: m[2] });
  }
  return out;
};
const coord = (f, r) => FILES[f] + r;

function buildBoard(x) {
  const board = new Map(); // "F1" -> {piece, side}
  const dup = [];
  for (const [side, key] of [['Red', 'Red'], ['Black', 'Black']]) {
    for (const it of parseSide(x[key])) {
      if (it.bad) { dup.push({ type: 'pose', msg: `${side} 无法解析 "${it.bad}"` }); continue; }
      const k = coord(it.f, it.r);
      if (board.has(k)) dup.push({ type: 'pose', msg: `重复占位 ${k}：${board.get(k).piece} 与 ${it.tok}` });
      else board.set(k, { piece: it.piece, side });
    }
  }
  return { board, parseErrors: dup };
}

function genMoves(board, from) {
  const cell = board.get(from);
  if (!cell) return [];
  const { piece, side } = cell;
  const f = fileIdx(from[0]), r = Number(from.slice(1));
  const at = (ff, rr) => (inBoard(ff, rr) ? board.get(coord(ff, rr)) : null);
  const free = (ff, rr) => !at(ff, rr);
  const foe = (ff, rr) => { const c = at(ff, rr); return c && c.side !== side; };
  const out = [];
  const push = (ff, rr) => { if (inBoard(ff, rr) && !(at(ff, rr) && at(ff, rr).side === side)) out.push(coord(ff, rr)); };

  if (isChariot(piece) || isKing(piece) || isCannon(piece)) {
    for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let jumped = false;
      for (let i = 1; i <= 10; i++) {
        const ff = f + df * i, rr = r + dr * i;
        if (!inBoard(ff, rr)) break;
        if (isKing(piece) && !inPalace(side, ff, rr)) break;
        const c = at(ff, rr);
        if (isCannon(piece)) {
          if (!jumped) {
            if (!c) out.push(coord(ff, rr));
            else jumped = true;
          } else if (c) {
            if (c.side !== side) out.push(coord(ff, rr));
            break;
          }
        } else {
          if (!c) out.push(coord(ff, rr));
          else { if (c.side !== side) out.push(coord(ff, rr)); break; }
        }
      }
    }
  } else if (HORSE.includes(piece)) {
    for (const [df, dr, lf, lr] of [[1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1], [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0]]) {
      if (!free(f + lf, r + lr)) continue; // 蹩马腿
      push(f + df, r + dr);
    }
  } else if (isEle(piece)) {
    for (const [df, dr] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const ff = f + df, rr = r + dr;
      if (!inBoard(ff, rr)) continue;
      if (!ownHalf(side, rr)) continue;         // 象不过河
      if (!free(f + df / 2, r + dr / 2)) continue; // 塞象眼
      push(ff, rr);
    }
  } else if (isAdv(piece)) {
    for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ff = f + df, rr = r + dr;
      if (!inPalace(side, ff, rr)) continue;
      push(ff, rr);
    }
  } else if (PAWN.includes(piece)) {
    const fwd = side === 'Red' ? 1 : -1;
    push(f, r + fwd);
    const crossed = side === 'Red' ? r >= 6 : r <= 5;
    if (crossed) { push(f + 1, r); push(f - 1, r); }
  }
  return out.filter((t) => t !== from);
}

function findKing(board, side) {
  const want = side === 'Red' ? KING_R : KING_B;   // 用字集合，取该方将/帅
  for (const [k, v] of board) if (want.includes(v.piece) && v.side === side) return k;
  return null;
}

function kingsFacing(board) {
  const a = findKing(board, 'Red'), b = findKing(board, 'Black');
  if (!a || !b) return false;
  if (a[0] !== b[0]) return false;
  const f = fileIdx(a[0]);
  const lo = Math.min(Number(a.slice(1)), Number(b.slice(1))), hi = Math.max(Number(a.slice(1)), Number(b.slice(1)));
  for (let r = lo + 1; r < hi; r++) if (board.has(coord(f, r))) return false;
  return true;
}

function attacked(board, cell, bySide) {
  for (const [from, v] of board) {
    if (v.side !== bySide) continue;
    if (genMoves(board, from).includes(cell)) return true;
  }
  return false;
}

function sideInCheck(board, side) {
  const k = findKing(board, side);
  if (!k) return true;
  return attacked(board, k, opp(side));
}

function applyMove(board, from, to) {
  const nb = new Map(board);
  const cell = nb.get(from);
  nb.delete(from);
  nb.set(to, cell);
  return nb;
}

// 兵/卒可达集合（从开局原位出发，只往前走、过河后可横走）
function pawnReachable(side) {
  const start = side === 'Red' ? [0, 2, 4, 6, 8].map((f) => coord(f, 4)) : [0, 2, 4, 6, 8].map((f) => coord(f, 7));
  const seen = new Set(), queue = [...start];
  start.forEach((s) => seen.add(s));
  while (queue.length) {
    const cur = queue.shift();
    const f = fileIdx(cur[0]), r = Number(cur.slice(1));
    const fwd = side === 'Red' ? r + 1 : r - 1;
    const cands = [];
    if (inBoard(f, fwd)) cands.push(coord(f, fwd));
    const crossed = side === 'Red' ? r >= 6 : r <= 5;
    if (crossed) { if (inBoard(f + 1, r)) cands.push(coord(f + 1, r)); if (inBoard(f - 1, r)) cands.push(coord(f - 1, r)); }
    for (const c of cands) if (!seen.has(c)) { seen.add(c); queue.push(c); }
  }
  return seen;
}
const REACH_R = pawnReachable('Red'), REACH_B = pawnReachable('Black');
const ELE_RED = new Set(['A3', 'C1', 'C5', 'E3', 'G1', 'G5', 'I3']);
const ELE_BLACK = new Set(['A8', 'C6', 'C10', 'E8', 'G6', 'G10', 'I8']);

const WIN = '在双方最优应对下，本局红方胜';const DRAW = '在双方最优应对下，本局红方无法取胜，为和棋';

const errors = [], notes = [];
const filled = all.filter((x) => x.name);
const emptyEntries = all.filter((x) => !x.name);

// 规则5：空条目
const emptyBad = emptyEntries.filter((x) => !(x.Red === '' && x.Black === '' && x.source === '' && x.correctAnswer === '' && x.options.join('') === 'A：B：C：D：E：以上选项都不对'));
if (emptyBad.length) errors.push(`规则5 空条目：id ${emptyBad.map((x) => x.id).join(',')} 的占位字段非空`);

for (const x of filled) {
  const tag = `id${x.id}(${x.name})`;
  const E = (m) => errors.push(`${tag}: ${m}`);
  const { board, parseErrors } = buildBoard(x);
  parseErrors.forEach((p) => E(p.msg));

  // 规则5：circumstance
  if (x.circumstance !== WIN && x.circumstance !== DRAW) E(`circumstance 非两种标准写法："${x.circumstance}"`);
  // 规则5：options 结构
  if (!Array.isArray(x.options) || x.options.length !== 5) E('options 不是 5 项');
  else if (x.options.slice(0, 4).some((o, i) => o[0] !== 'ABCDE'[i])) E('选项前缀顺序不对');
  else if (x.options[4] !== 'E：以上选项都不对') E(`选项E 异常 "${x.options[4]}"`);

  // 规则5：双方必须有帅/将，且各恰好一个（字形按归一化比较）
  for (const [side, kingCh] of [['Red', '帅'], ['Black', '将']]) {
    const n = [...board.values()].filter((v) => v.side === side && norm(v.piece) === kingCh).length;
    if (n === 0) E(`${side === 'Red' ? '红方' : '黑方'}无${kingCh}`);
    else if (n > 1) E(`${side === 'Red' ? '红方' : '黑方'}有 ${n} 个${kingCh}（应恰好 1 个）`);
  }

  // 用字与归属（用户 2026-09-19 定：红 帥仕相馬炮兵車 / 黑 将士象馬砲卒車）
  // 注意：字形归一化只用于"判定同一子"，不能拿它替代本条用字归属检查——
  // id95 的黑方误写"相G10"就是被归一化掩盖、漏检的。
  {
    const RED_ONLY = '帥帅仕相炮兵', BLK_ONLY = '将將士象砲卒';
    for (const [k, v] of board) {
      if (v.side === 'Red' && BLK_ONLY.includes(v.piece)) E(`红方用了黑方的字形 "${v.piece}${k}"（红方应为 帥/仕/相/馬/炮/兵/車）`);
      if (v.side === 'Black' && RED_ONLY.includes(v.piece)) E(`黑方用了红方的字形 "${v.piece}${k}"（黑方应为 将/士/象/馬/砲/卒/車）`);
    }
  }

  // 数量上限（用户 2026-09-15 定：车马炮各≤2、士象各≤2、兵卒各≤5、帅将各=1）
  {
    const LIMIT = { 車: 2, 车: 2, 馬: 2, 马: 2, 砲: 2, 炮: 2, 兵: 5, 卒: 5, 士: 2, 仕: 2, 象: 2, 相: 2, 帥: 1, 帅: 1, 将: 1, 將: 1 };
    const cnt = { Red: {}, Black: {} };
    for (const v of board.values()) cnt[v.side][v.piece] = (cnt[v.side][v.piece] || 0) + 1;
    for (const side of ['Red', 'Black']) {
      for (const [pc, n] of Object.entries(cnt[side])) {
        const lim = LIMIT[pc];
        if (lim === undefined) E(`${side} 出现未知棋子名 "${pc}"`);
        else if (n > lim) E(`${side} 的 ${pc} 有 ${n} 个，超过上限 ${lim}`);
      }
    }
  }

  // 规则2：初始位置合法
  for (const [k, v] of board) {
    const f = fileIdx(k[0]), r = Number(k.slice(1));
    if (isKing(v.piece) && !inPalace(v.side, f, r)) E(`帅/将 ${v.piece}${k} 不在九宫内`);
    if (isAdv(v.piece) && !inPalace(v.side, f, r)) E(`士 ${v.piece}${k} 不在九宫内`);
    if (isEle(v.piece)) {
      // 象位集合（用户给定）：红 A3 C1 C5 E3 G1 G5 I3；黑 A8 C6 C10 E8 G6 G10 I8
      if (v.side === 'Red' ? !ELE_RED.has(k) : !ELE_BLACK.has(k)) E(`象/相 ${v.piece}${k} 不是合法象位`);
    }
    if (v.piece === '兵' && !REACH_R.has(k)) E(`红兵${k} 位置不可能到达（只能向前、过河后才可横走）`);
    if (v.piece === '卒' && !REACH_B.has(k)) E(`黑卒${k} 位置不可能到达（只能向前、过河后才可横走）`);
  }

  // 规则1：开局不能被将军 / 帅将不能见面
  if (kingsFacing(board)) E('开局帅将见面');
  for (const side of ['Red', 'Black']) {
    if (sideInCheck(board, side)) E(`开局 ${side === 'Red' ? '红方' : '黑方'}正被将军`);
  }

  // 规则3/4：选项走子
  const coordRe2 = /^[A-I](?:10|[1-9])$/;
  const parseOpt = (opt) => {
    const L = opt[0];
    const body = opt.slice(2);
    if (body !== body.trim()) return { L, err: `选项${L} 首尾有多余空格 "${opt}"` };
    if (!body) return { L, err: `选项${L} 内容为空` };
    if (/ \+\s*$/.test(body)) return { L, err: `选项${L} "+" 前有空格 → "${opt}"` };
    const check = body.endsWith('+');
    const core = check ? body.slice(0, -1) : body;
    const toks = core.split(' ');
    if (toks.some((t) => t === '')) return { L, err: `选项${L} 空格数量不对（中间应只有一个空格）→ "${opt}"` };
    const PIECES = ['帥', '帅', '将', '將', '車', '车', '馬', '马', '砲', '炮', '兵', '卒', '士', '仕', '象', '相'];
    const coordRe2 = /^[A-I](?:10|[1-9])$/;
    let piece = null, from = null, to = null, capture = false, i = 0;
    const isPieceCoord = (t) => {
      for (const p of PIECES) if (t.startsWith(p) && coordRe2.test(t.slice(p.length))) return p;
      return null;
    };
    // 第一段：棋子名+起点坐标（如 炮B7），或只有起点坐标（如 B7）
    const p0 = isPieceCoord(toks[0]);
    if (p0) { piece = p0; from = toks[0].slice(p0.length); i = 1; }
    else if (toks[0] && coordRe2.test(toks[0])) { from = toks[0]; i = 1; }
    else if (toks[0] && /^[\u4e00-\u9fa5]{1,2}$/.test(toks[0])) { piece = toks[0]; i = 1; }
    // 第二段（若第一段只给了棋子名或只给了起点坐标）
    if (i < toks.length && toks[i] === 'x') { capture = true; i++; }
    if (!to && i < toks.length) {
      const t = toks[i];
      const p1 = isPieceCoord(t);
      if (p1 && !piece && from === null) { piece = p1; from = t.slice(p1.length); i++; }
      else if (coordRe2.test(t)) { to = t; i++; }
      else if (p1) { to = t.slice(p1.length); i++; }
    }
    if (!capture && i < toks.length && toks[i] === 'x') { capture = true; i++; }
    if (!to && i < toks.length) { to = toks[i]; i++; }
    if (i !== toks.length) return { L, err: `选项${L} 走法形式无法识别 "${opt}"` };
    if (!to) return { L, err: `选项${L} 缺少目标坐标 "${opt}"` };
    if (!coordRe2.test(to)) return { L, err: `选项${L} 目标坐标非法 "${to}"` };
    if (from !== null && !coordRe2.test(from)) return { L, err: `选项${L} 起点坐标非法 "${from}"` };
    if (capture && !core.includes(' x ')) return { L, err: `选项${L} x 两侧空格不对 "${opt}"` };
    if (!capture && core.includes(' x ')) return { L, err: `选项${L} 有多余 x "${opt}"` };
    return { L, piece, from, to, capture, check, raw: opt };
  };

  const mover = 'Red';
  const inCheckNow = sideInCheck(board, mover);
  let legalCount = 0;
  const opts = (x.options || []).slice(0, 4).map(parseOpt);
  opts.forEach((o) => {
    if (o.err) { E(o.err); return; }
    const cands = [];
    if (o.err) return;
    if (o.piece && o.from) {
      const c = board.get(o.from);
      if (!c) E(`选项${o.L} 起点 ${o.from} 无子`);
      else if (norm(c.piece) !== norm(o.piece)) E(`选项${o.L} 起点 ${o.from} 上是 ${c.piece}，不是 ${o.piece}`);
      else if (c.side !== mover) E(`选项${o.L} 走的是对方的子 ${c.piece}${o.from}`);
      else cands.push({ from: o.from, to: o.to });
    } else if (o.from) {
      if (!board.has(o.from)) E(`选项${o.L} 起点 ${o.from} 无子`);
      else cands.push({ from: o.from, to: o.to });
    } else {
      // 只写了落点：枚举红方所有能走到该点的子
      for (const [from, v] of board) {
        if (v.side !== mover) continue;
        if (genMoves(board, from).includes(o.to)) cands.push({ from, to: o.to });
      }
    }
    // 校验每个候选
    const survivors = [];
    for (const c of cands) {
      const cell = board.get(c.from);
      if (!cell) continue;
      const dest0 = board.get(c.to);
      if (dest0 && dest0.side === cell.side) {
        E(`选项${o.L} 落点 ${c.to} 是己方子 ${dest0.piece}（不可吃己方子）→ "${o.raw}"`);
        continue;
      }
      if (!genMoves(board, c.from).includes(c.to)) { notes.push(`${tag} 选项${o.L} ${c.from}→${c.to} 走法不合法（${cell.piece}）`); continue; }
      const target = board.get(c.to);
      if (target) {
        if (target.side === cell.side) { E(`选项${o.L} 落点 ${c.to} 是己方子 ${target.piece}（走子不可吃己方子）→ "${o.raw}"`); continue; }
        if (isKing(target.piece)) { notes.push(`${tag} 选项${o.L} 吃了将/帅 ${c.to}`); continue; }
        if (!o.capture) E(`选项${o.L} 吃子 ${target.piece}${c.to} 却没标 x → "${o.raw}"`);
      } else if (o.capture) E(`选项${o.L} 标了 x，但 ${c.to} 上无子 → "${o.raw}"`);
      const nb = applyMove(board, c.from, c.to);
      if (kingsFacing(nb)) { notes.push(`${tag} 选项${o.L} 走后帅将见面`); continue; }
      if (sideInCheck(nb, cell.side)) { notes.push(`${tag} 选项${o.L} 走后自己仍被将军`); continue; }
      const givesCheck = sideInCheck(nb, opp(cell.side));
      survivors.push({ ...c, givesCheck, nb });
    }
    if (!cands.length) { E(`选项${o.L} 找不到可走的子 → "${o.raw}"`); return; }
    if (!survivors.length) { E(`选项${o.L} 没有任何合法走法 → "${o.raw}"`); return; }
    if (o.check && !survivors.some((s) => s.givesCheck)) {
      E(`选项${o.L} 标了 +，但按点位写法没有任何合法走法能将军 → "${o.raw}"`);
    }
    legalCount++;
    o.legal = survivors;
  });

  // 正解必须合法
  if (x.correctAnswer !== 'E') {
    const idx = 'ABCDE'.indexOf(x.correctAnswer);
    const o = opts[idx];
    if (o && !o.err && !o.legal) E(`正解 ${x.correctAnswer} 不是合法走法 → "${x.options[idx]}"`);
  } else {
    if (inCheckNow) notes.push(`${tag} 正解选 E，但开局红方正被将军（红方必须应将，选项里应有正解）`);
  }
  if (inCheckNow && legalCount === 0 && x.correctAnswer !== 'E') notes.push(`${tag} 红方正被将军，但四个选项都不是合法应将`);
}

console.log('=== 规则检查（1-' + all.length + ' 题，已填 ' + filled.length + ' 题）===');
console.log('\n【错误】' + (errors.length ? '' : ' 无'));
if (errors.length) console.log(errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
console.log('\n【提示/非硬错误】' + (notes.length ? '' : ' 无'));
if (notes.length) console.log([...new Set(notes)].map((e, i) => `${i + 1}. ${e}`).join('\n'));
