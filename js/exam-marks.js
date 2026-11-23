/* ▼▼▼ 過去問の資料のマーカー（js/exam-marks.js、v34.0〜） ▼▼▼ */
// 問題・出題趣旨・採点実感の文に、3色（黄・青・ピンク）のマーカーを引く。
// 引き方：
//   ① 文字をなぞって選ぶ → 画面の下に出る色のボタン（「消す」で、選んだところのマーカーを消す）
//   ② 「文をタップで引く」をオンにして文を押す → その文（。まで）全体に引く。同じ色で引いてある文を押すと消す
//   ③ 引いてあるマーカーを押す → 色を変える・消す
// 「引いたところ」の一覧（年度・科目ごと）から、その場所へ飛べる。
//
// 保存：ronshoExamMarksV1（他の端末にも同期・手動バックアップの対象）
//   形：{ "新司法試験|7|民法|shushi": [ { p: 段落の番号, s: 始まり, e: 終わり（その字は含まない）, c: 'y'|'b'|'p', t: 引いた文 } ] }
//   位置は段落の文字の位置。資料を作り直して文がずれたときのため、引いた文（t）も持ち、
//   位置の文が t と違えば、同じ段落→ほかの段落の順に t を探し直す（見つからなければ一覧にだけ出す）。
const EXAM_MARKS_KEY = 'ronshoExamMarksV1';
const EXAM_MARK_COLORS = [
  { id: 'y', label: '黄' },
  { id: 'b', label: '青' },
  { id: 'p', label: 'ピンク' }
];
function examMarksColorOk(c) { return c === 'y' || c === 'b' || c === 'p'; }
function examMarksColorLabel(c) {
  const f = EXAM_MARK_COLORS.find(x => x.id === c);
  return f ? f.label : '';
}
function examMarksDocKey(examType, year, subject, kind) {
  return examType + '|' + year + '|' + subject + '|' + kind;
}
function loadExamMarks() {
  try {
    const v = JSON.parse(localStorage.getItem(EXAM_MARKS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function saveExamMarks(map) {
  try { localStorage.setItem(EXAM_MARKS_KEY, JSON.stringify(map || {})); } catch (e) {}
}
function examMarksValid(m) {
  return !!m && typeof m === 'object' && Number.isInteger(m.p) && m.p >= 0 && Number.isInteger(m.s) && m.s >= 0
    && Number.isInteger(m.e) && m.e > m.s && examMarksColorOk(m.c) && typeof m.t === 'string';
}

// 今の資料の段落に合わせて、各マーカーの位置を決める（i は保存している並びの番号）。
// 見つからないもの・壊れた値は p: null
function examMarksResolve(paras, list) {
  const ps = Array.isArray(paras) ? paras : [];
  return (Array.isArray(list) ? list : []).map((m, i) => {
    if (!examMarksValid(m)) return { i: i, p: null, s: 0, e: 0, c: '', t: '' };
    const base = { i: i, c: m.c, t: m.t };
    const para = typeof ps[m.p] === 'string' ? ps[m.p] : null;
    if (para != null && para.slice(m.s, m.e) === m.t) return Object.assign(base, { p: m.p, s: m.s, e: m.e });
    if (m.t) {
      if (para != null) {
        const k = para.indexOf(m.t);
        if (k >= 0) return Object.assign(base, { p: m.p, s: k, e: k + m.t.length });
      }
      for (let q = 0; q < ps.length; q++) {
        const k = typeof ps[q] === 'string' ? ps[q].indexOf(m.t) : -1;
        if (k >= 0) return Object.assign(base, { p: q, s: k, e: k + m.t.length });
      }
    }
    return Object.assign(base, { p: null, s: 0, e: 0 });
  });
}
// 段落ごとに並べる（重なりがあれば後のものを切り詰める。描くときに入れ子にしないため）
function examMarksByPara(resolved) {
  const out = {};
  (resolved || []).forEach(r => {
    if (r.p == null) return;
    (out[r.p] = out[r.p] || []).push({ s: r.s, e: r.e, c: r.c, i: r.i });
  });
  Object.keys(out).forEach(p => {
    const list = out[p].sort((a, b) => a.s - b.s || a.e - b.e);
    const kept = [];
    let end = 0;
    list.forEach(m => {
      const s = Math.max(m.s, end);
      if (m.e <= s) return;
      kept.push({ s: s, e: m.e, c: m.c, i: m.i });
      end = m.e;
    });
    out[p] = kept;
  });
  return out;
}
// 資料1つ分のマーカー（段落ごと）。exam-docs.js の examDocsPanelHtml から呼ぶ
function examMarksForDoc(examType, year, subject, kind, paras) {
  const list = loadExamMarks()[examMarksDocKey(examType, year, subject, kind)];
  if (!Array.isArray(list) || list.length === 0) return null;
  return examMarksByPara(examMarksResolve(paras, list));
}
// 段落の [a, b) の部分を、マーカーを入れてHTMLにする（marks は examMarksByPara の1段落分）
function examMarksSliceHtml(text, a, b, marks) {
  let out = '', pos = a;
  (marks || []).forEach(m => {
    const s = Math.max(m.s, pos), e = Math.min(m.e, b);
    if (e <= s) return;
    if (s > pos) out += escapeHtml(text.slice(pos, s));
    out += '<mark class="examMark examMark-' + m.c + '" data-mi="' + m.i + '">' + escapeHtml(text.slice(s, e)) + '</mark>';
    pos = e;
  });
  if (pos < b) out += escapeHtml(text.slice(pos, b));
  return out;
}

// 段落 p の [s, e) を色 c にする（c が null なら、そこのマーカーを消す）。元の list は変えない。
// 重なっていたところは新しい色で上書きし、同じ色で重なる・隣り合うものは1つにまとめる。
// 色を付けるときは、前後の空白は含めない。見失ったもの（作り直しで場所が分からないもの）はそのまま残す
function examMarksApply(paras, list, p, s, e, c) {
  const ps = Array.isArray(paras) ? paras : [];
  const src = Array.isArray(list) ? list : [];
  const para = typeof ps[p] === 'string' ? ps[p] : null;
  if (para == null) return src.slice();
  s = Math.max(0, Math.min(para.length, s | 0));
  e = Math.max(0, Math.min(para.length, e | 0));
  if (c) {
    while (s < e && /[\s　]/.test(para[s])) s++;
    while (e > s && /[\s　]/.test(para[e - 1])) e--;
  }
  if (e <= s) return src.slice();
  const keep = [], here = [];
  examMarksResolve(ps, src).forEach(r => {
    if (r.p == null) {
      if (examMarksValid(src[r.i])) keep.push(src[r.i]);
      return;
    }
    if (r.p !== p) { keep.push({ p: r.p, s: r.s, e: r.e, c: r.c, t: r.t }); return; }
    if (r.e <= s || r.s >= e) { here.push({ s: r.s, e: r.e, c: r.c }); return; }
    if (r.s < s) here.push({ s: r.s, e: s, c: r.c });
    if (r.e > e) here.push({ s: e, e: r.e, c: r.c });
  });
  if (c) here.push({ s: s, e: e, c: c });
  here.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged = [];
  here.forEach(r => {
    const last = merged[merged.length - 1];
    if (last && last.c === r.c && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else if (last && r.s < last.e) {
      // 違う色が重なっていれば（古い値など）、後のものを切り詰める
      if (r.e > last.e) merged.push({ s: last.e, e: r.e, c: r.c });
    } else merged.push({ s: r.s, e: r.e, c: r.c });
  });
  const out = keep.concat(merged.filter(r => r.e > r.s).map(r => ({ p: p, s: r.s, e: r.e, c: r.c, t: para.slice(r.s, r.e) })));
  out.sort((a, b) => a.p - b.p || a.s - b.s);
  return out;
}
// 段落 p の [s, e) が、全部 色 c のマーカーで覆われているか
function examMarksCovered(paras, list, p, s, e, c) {
  if (e <= s) return false;
  const rs = examMarksResolve(paras, list).filter(r => r.p === p && r.c === c).sort((a, b) => a.s - b.s);
  let pos = s;
  for (const r of rs) {
    if (r.s > pos) break;
    if (r.e > pos) pos = r.e;
    if (pos >= e) return true;
  }
  return pos >= e;
}
// offset の字を含む文（「。」まで）の範囲。前後の空白は含めない
function examMarksSentenceAt(text, offset) {
  const t = String(text || '');
  if (!t) return null;
  const sents = typeof examDocsSplitSentences === 'function' ? examDocsSplitSentences(t) : [t];
  let pos = 0;
  for (let k = 0; k < sents.length; k++) {
    const end = pos + sents[k].length;
    if (offset < end || k === sents.length - 1) {
      let s = pos, e = end;
      while (s < e && /[\s　]/.test(t[s])) s++;
      while (e > s && /[\s　]/.test(t[e - 1])) e--;
      return e > s ? { s: s, e: e } : null;
    }
    pos = end;
  }
  return null;
}
// 文をタップしたとき：その文が今の色で全部引いてあれば消し、そうでなければ今の色で引く
function examMarksToggleSentence(paras, list, p, offset, c) {
  const r = examMarksSentenceAt(paras && paras[p], offset);
  if (!r) return { list: (list || []).slice(), changed: false };
  const covered = examMarksCovered(paras, list, p, r.s, r.e, c);
  return { list: examMarksApply(paras, list, p, r.s, r.e, covered ? null : c), changed: true, removed: covered };
}
// 「引いたところ」の一覧の1行の文（長いものは途中まで）
function examMarksSnippet(t, max) {
  const s = String(t || '').replace(/\s+/g, ' ');
  const n = max || 90;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// --- 画面（exam-docs.js の examDocsState・renderExamDocs を使う） ---
const examMarksUi = {
  mode: '',          // '' | 'sel'（なぞって選んだところ） | 'edit'（押したマーカー）
  pending: null,     // { kind, ranges: [{ p, s, e }] }
  editing: null,     // { kind, mi }
  hideTimer: null,
  selTimer: null,
  pressed: false
};
function examMarksStoreFor(kind) {
  const st = examDocsState;
  const key = examMarksDocKey(st.examType, st.year, st.subject, kind);
  const map = loadExamMarks();
  return { key: key, map: map, list: Array.isArray(map[key]) ? map[key] : [], paras: (st.docParas && st.docParas[kind]) || [] };
}
function examMarksSaveList(store, list) {
  if (list.length > 0) store.map[store.key] = list;
  else delete store.map[store.key];
  saveExamMarks(store.map);
}
function examMarksToolsHtml(view) {
  const v = view || loadExamDocsView();
  return '<div class="examMarkTools">'
    + '<span class="examMarkToolsLabel">🖍 マーカー</span>'
    + '<span class="examMarkColors">' + EXAM_MARK_COLORS.map(c =>
      '<button type="button" class="examMarkColorBtn examMark-' + c.id + (v.mkColor === c.id ? ' active' : '') + '" data-act="mkColor" data-c="' + c.id + '" aria-pressed="' + (v.mkColor === c.id) + '">' + c.label + '</button>').join('') + '</span>'
    + '<label class="examMarkTapToggle"><input type="checkbox" data-act="mkTap"' + (v.mkTap ? ' checked' : '') + '> 文をタップで引く</label>'
    + '<span class="examMarkHint">' + (v.mkTap
      ? '文を押すと、その文に' + examMarksColorLabel(v.mkColor) + 'のマーカー（同じ色の文をもう一度押すと消す）'
      : '文字をなぞって選ぶと、下に色のボタンが出ます。引いたマーカーを押すと色を変える・消す')
    + '</span></div>';
}
function examMarksListHtml(st, subjData, locked) {
  const map = loadExamMarks();
  const groups = [];
  let total = 0;
  EXAM_DOCS_KINDS.forEach(k => {
    const list = map[examMarksDocKey(st.examType, st.year, st.subject, k.id)];
    if (!Array.isArray(list) || list.length === 0) return;
    const paras = subjData && subjData[k.id] && Array.isArray(subjData[k.id].paras) ? subjData[k.id].paras : [];
    const rs = examMarksResolve(paras, list).filter(r => r.t);
    rs.sort((a, b) => (a.p == null) - (b.p == null) || (a.p || 0) - (b.p || 0) || a.s - b.s);
    total += rs.length;
    groups.push({ kind: k, rs: rs, hidden: locked && k.id !== 'mondai' });
  });
  const open = !!st.mkListOpen;
  let html = '<div class="examMarkList">'
    + '<button type="button" class="examMarkListHead" data-act="mkList" aria-expanded="' + open + '">' + (open ? '▾' : '▸') + ' 🖍 引いたところ（' + total + '件）</button>';
  if (!open) return html + '</div>';
  if (total === 0) return html + '<div class="examMarkListNote">この年度・科目では、まだマーカーを引いていません。</div></div>';
  groups.forEach(g => {
    html += '<div class="examMarkListKind" data-kind="' + g.kind.id + '">' + g.kind.icon + ' ' + g.kind.label + '（' + g.rs.length + '件）</div>';
    if (g.hidden) {
      html += '<div class="examMarkListNote">解き終えるまで隠しています。</div>';
      return;
    }
    html += g.rs.map(r => {
      const armed = st.mkDelArmed === g.kind.id + ':' + r.i;
      return '<div class="examMarkItem">'
        + '<button type="button" class="examMarkItemGo" data-act="mkGo" data-kind="' + g.kind.id + '" data-mi="' + r.i + '"' + (r.p == null ? ' disabled' : '') + '>'
        + '<mark class="examMark examMark-' + r.c + '">' + escapeHtml(examMarksSnippet(r.t)) + '</mark>'
        + (r.p == null ? '<span class="examMarkLost">（資料が作り直されて、場所が見つかりません）</span>' : '') + '</button>'
        + '<button type="button" class="examMarkItemDel' + (armed ? ' armed' : '') + '" data-act="mkDel" data-kind="' + g.kind.id + '" data-mi="' + r.i + '" title="このマーカーを消す">' + (armed ? '消す？' : '✕') + '</button>'
        + '</div>';
    }).join('');
  });
  return html + '</div>';
}
function examMarksHandleAction(el) {
  const st = examDocsState;
  const act = el.dataset.act;
  if (act === 'mkColor') {
    const v = loadExamDocsView();
    if (examMarksColorOk(el.dataset.c)) v.mkColor = el.dataset.c;
    saveExamDocsView(v);
    renderExamDocs();
    return;
  }
  if (act === 'mkList') {
    st.mkListOpen = !st.mkListOpen;
    st.mkDelArmed = null;
    renderExamDocs();
    return;
  }
  if (act === 'mkGo') {
    const kind = el.dataset.kind;
    const mi = Number(el.dataset.mi);
    const store = examMarksStoreFor(kind);
    const r = examMarksResolve(store.paras, store.list)[mi];
    if (!r || r.p == null) return;
    st.kind = kind;
    st.focusPara = r.p;
    st.focusMark = mi;
    st.message = '';
    renderExamDocs();
    return;
  }
  if (act === 'mkDel') {
    const id = el.dataset.kind + ':' + el.dataset.mi;
    if (st.mkDelArmed !== id) { st.mkDelArmed = id; renderExamDocs(); return; }
    st.mkDelArmed = null;
    const store = examMarksStoreFor(el.dataset.kind);
    const mi = Number(el.dataset.mi);
    examMarksSaveList(store, store.list.filter((m, i) => i !== mi));
    examMarksHideBar();
    renderExamDocs();
  }
}

// --- 本文の文字の位置（DOM） ---
// 判例の印（「百選12」「⚖️」）は資料の文ではないので数えない
function examMarksTextOffset(pEl, node, off) {
  try {
    const r = document.createRange();
    r.setStart(pEl, 0);
    r.setEnd(node, off);
    const frag = r.cloneContents();
    frag.querySelectorAll('.examCaseBadge').forEach(b => b.parentNode.removeChild(b));
    return frag.textContent.length;
  } catch (e) { return null; }
}
// 押した点の字の位置（段落の中の文字の番号）
function examMarksCaretOffset(pEl, x, y) {
  let node = null, off = 0;
  try {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; off = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      if (c) { node = c.offsetNode; off = c.offset; }
    }
  } catch (e) { node = null; }
  if (!node || !pEl.contains(node)) return null;
  // 字の右半分を押すと「その字の後ろ」が返るので、押した点がその字の上でなければ1つ前の字にする
  // （「。」の右側を押して、次の文に引いてしまわないように）
  if (node.nodeType === 3 && off > 0) {
    let onChar = false;
    if (off < node.length) {
      try {
        const rr = document.createRange();
        rr.setStart(node, off);
        rr.setEnd(node, off + 1);
        const rect = rr.getBoundingClientRect();
        onChar = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      } catch (e) {}
    }
    if (!onChar) off -= 1;
  }
  return examMarksTextOffset(pEl, node, off);
}
function examMarksBodyOf(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el && el.closest ? el.closest('.examDocBody') : null;
}
// 今なぞって選んでいるところを、段落ごとの範囲にする（1つの資料の中だけ）
function examMarksSelectionRanges() {
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const body = examMarksBodyOf(range.startContainer) || examMarksBodyOf(range.endContainer) || examMarksBodyOf(range.commonAncestorContainer);
  if (!body) return null;
  const panel = body.closest('.examDocPanel');
  const kind = panel && panel.dataset.kind;
  const paras = examDocsState.docParas && examDocsState.docParas[kind];
  if (!paras) return null;
  const ranges = [];
  body.querySelectorAll('p[data-pi]').forEach(pEl => {
    let hit = false;
    try { hit = range.intersectsNode(pEl); } catch (e) {}
    if (!hit) return;
    const pi = Number(pEl.dataset.pi);
    const text = paras[pi];
    if (typeof text !== 'string') return;
    let s = 0, e = text.length;
    if (pEl.contains(range.startContainer)) s = examMarksTextOffset(pEl, range.startContainer, range.startOffset);
    if (pEl.contains(range.endContainer)) e = examMarksTextOffset(pEl, range.endContainer, range.endOffset);
    if (s == null || e == null) return;
    s = Math.max(0, Math.min(text.length, s));
    e = Math.max(0, Math.min(text.length, e));
    if (text.slice(s, e).trim()) ranges.push({ p: pi, s: s, e: e });
  });
  return ranges.length > 0 ? { kind: kind, ranges: ranges } : null;
}

// --- 画面の下に出る色のボタン ---
function examMarksBarEl() {
  let bar = document.getElementById('examMarkBar');
  if (!bar && document.body) {
    bar = document.createElement('div');
    bar.id = 'examMarkBar';
    bar.className = 'examMarkBar';
    bar.setAttribute('role', 'toolbar');
    // 押している間に選んだところが消えても、押したボタンが効くように（選ぶ操作を止めない）
    const press = (e) => {
      examMarksUi.pressed = true;
      if (examMarksUi.hideTimer) { clearTimeout(examMarksUi.hideTimer); examMarksUi.hideTimer = null; }
      if (e.type === 'mousedown') e.preventDefault();
    };
    bar.addEventListener('mousedown', press);
    bar.addEventListener('touchstart', press, { passive: true });
    bar.addEventListener('click', (e) => {
      examMarksUi.pressed = false;
      const btn = e.target && e.target.closest ? e.target.closest('[data-mk]') : null;
      if (btn) examMarksBarAction(btn.dataset.mk, btn.dataset.c);
    });
    document.body.appendChild(bar);
  }
  return bar;
}
function examMarksShowBar(mode) {
  const bar = examMarksBarEl();
  if (!bar) return;
  examMarksUi.mode = mode;
  if (examMarksUi.hideTimer) { clearTimeout(examMarksUi.hideTimer); examMarksUi.hideTimer = null; }
  let current = '';
  if (mode === 'edit' && examMarksUi.editing) {
    const store = examMarksStoreFor(examMarksUi.editing.kind);
    const m = store.list[examMarksUi.editing.mi];
    current = m ? m.c : '';
  }
  bar.innerHTML = '<span class="examMarkBarLabel">🖍<span class="examMarkBarText"> ' + (mode === 'edit' ? 'このマーカー' : '選んだところに') + '</span></span>'
    + EXAM_MARK_COLORS.map(c => '<button type="button" class="examMarkBarBtn examMark-' + c.id + (current === c.id ? ' active' : '') + '" data-mk="color" data-c="' + c.id + '">' + c.label + '</button>').join('')
    + '<button type="button" class="examMarkBarBtn examMarkBarErase" data-mk="erase">消す</button>'
    + '<button type="button" class="examMarkBarClose" data-mk="close" aria-label="閉じる">✕</button>';
  bar.classList.add('show');
}
function examMarksHideBar() {
  examMarksUi.mode = '';
  examMarksUi.pending = null;
  examMarksUi.editing = null;
  examMarksUi.pressed = false;
  if (examMarksUi.hideTimer) { clearTimeout(examMarksUi.hideTimer); examMarksUi.hideTimer = null; }
  const bar = typeof document !== 'undefined' && document.getElementById ? document.getElementById('examMarkBar') : null;
  if (bar && bar.classList) bar.classList.remove('show');
}
function examMarksBarAction(what, color) {
  if (what === 'close') { examMarksClearSelection(); examMarksHideBar(); return; }
  const c = what === 'color' && examMarksColorOk(color) ? color : null;
  if (what !== 'color' && what !== 'erase') return;
  if (examMarksUi.mode === 'sel' && examMarksUi.pending) {
    const pend = examMarksUi.pending;
    const store = examMarksStoreFor(pend.kind);
    let list = store.list;
    pend.ranges.forEach(r => { list = examMarksApply(store.paras, list, r.p, r.s, r.e, c); });
    examMarksSaveList(store, list);
    if (c) {
      const v = loadExamDocsView();
      v.mkColor = c;
      saveExamDocsView(v);
    }
  } else if (examMarksUi.mode === 'edit' && examMarksUi.editing) {
    const ed = examMarksUi.editing;
    const store = examMarksStoreFor(ed.kind);
    const r = examMarksResolve(store.paras, store.list)[ed.mi];
    if (r && r.p != null) examMarksSaveList(store, examMarksApply(store.paras, store.list, r.p, r.s, r.e, c));
  } else {
    return;
  }
  examMarksClearSelection();
  examMarksHideBar();
  renderExamDocs();
}
function examMarksClearSelection() {
  try { const sel = window.getSelection && window.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (e) {}
}
// 本文を押したとき（exam-docs.js の click から）。マーカーの操作をしたら true
function examMarksHandleBodyClick(e) {
  const t = e.target;
  if (!t || !t.closest) return false;
  const body = t.closest('.examDocBody');
  if (!body) return false;
  // 判例の下線・条文リンク・ボタンは、そちらを優先する
  if (t.closest('.lawRef, [data-act], a, button, input, select')) return false;
  const sel = window.getSelection ? window.getSelection() : null;
  if (sel && !sel.isCollapsed && String(sel).trim()) return false;
  const panel = body.closest('.examDocPanel');
  const kind = panel && panel.dataset.kind;
  if (!kind) return false;
  const view = loadExamDocsView();
  if (view.mkTap) {
    const pEl = t.closest('p[data-pi]');
    if (!pEl) return false;
    const off = examMarksCaretOffset(pEl, e.clientX, e.clientY);
    if (off == null) return false;
    const store = examMarksStoreFor(kind);
    const res = examMarksToggleSentence(store.paras, store.list, Number(pEl.dataset.pi), off, view.mkColor);
    if (!res.changed) return false;
    examMarksSaveList(store, res.list);
    examMarksHideBar();
    renderExamDocs();
    return true;
  }
  const mEl = t.closest('mark.examMark[data-mi]');
  if (mEl) {
    examMarksUi.editing = { kind: kind, mi: Number(mEl.dataset.mi) };
    examMarksUi.pending = null;
    examMarksShowBar('edit');
    return true;
  }
  if (examMarksUi.mode === 'edit') examMarksHideBar();
  return false;
}
function initExamMarks() {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  document.addEventListener('selectionchange', () => {
    if (!examDocsState.open) return;
    if (examMarksUi.selTimer) clearTimeout(examMarksUi.selTimer);
    examMarksUi.selTimer = setTimeout(() => {
      examMarksUi.selTimer = null;
      const r = examMarksSelectionRanges();
      if (r) {
        examMarksUi.pending = r;
        examMarksUi.editing = null;
        examMarksShowBar('sel');
      } else if (examMarksUi.mode === 'sel' && !examMarksUi.pressed && !examMarksUi.hideTimer) {
        // 選んだところが消えたら、少し待ってから隠す（ボタンを押した拍子に選択が消える端末でも、押したボタンが効くように）
        examMarksUi.hideTimer = setTimeout(() => {
          examMarksUi.hideTimer = null;
          if (!examMarksUi.pressed) examMarksHideBar();
        }, 700);
      }
    }, 150);
  });
}
initExamMarks();
/* ▲▲▲ 過去問の資料のマーカー ここまで ▲▲▲ */
