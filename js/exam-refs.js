/* ▼▼▼ 出題趣旨で指摘された条文・判例のつながり（v33.0〜） ▼▼▼
   出題趣旨（data/exam/*.json の shushi）に出てくる条文・判例を、あらかじめ索引
   （data/exam/refs.json、作り方は tools/exam-fetch/build-refs.js）にまとめておき、
   ・過去問の資料：判例の引用に下線 → 押すと判例タブの判例・百選の番号・ほかの年度の指摘
   ・判例タブ：判例ごとに「出題趣旨での指摘」、出題趣旨で指摘された百選判例の一覧
   ・条文タブ：出題趣旨で指摘された条文の一覧、全条を読む／条文ポップアップに印
   を出す。条文は法律名つきの参照（「民法第７０９条」「同法第…」）だけを数える
   （「法第３条」「本件条例第３２条」は架空の法令と区別できないため）。
   判例の照合は「裁判所の種類＋判決日」（判例集の巻号頁が両方にあればそれも）で行う。
   百選の目次は、利用者が手元の百選から取り込んだもの（ronshoHyakusenTocV1、同期・バックアップ対象）
   だけを使う。アプリ自体には百選の目次を入れない。 */
const EXAM_REFS_URL = 'data/exam/refs.json';
const HYAKUSEN_TOC_KEY = 'ronshoHyakusenTocV1';
const EXAM_REFS_EXAM_TYPE = { shiho: '新司法試験', yobi: '予備試験' };
const EXAM_REFS_EXAM_SHORT = { shiho: '司法', yobi: '予備' };

// --- 判例の引用の読み取り ---
// 全角の数字・記号を半角に（文字数は変わらないので、見つけた位置はそのまま元の文で使える）
function examRefsNormalize(s) {
  return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．]/g, '.').replace(/[，]/g, ',');
}
const EXAM_REFS_ERA_BASE = { 明治: 1867, 明: 1867, 大正: 1911, 大: 1911, 昭和: 1925, 昭: 1925, 平成: 1988, 平: 1988, 令和: 2018, 令: 2018 };
// 裁判所：最高裁（大法廷・小法廷を含む）／大審院／高裁・地裁・家裁・簡裁（場所は問わない）
const EXAM_REFS_COURT_SRC = '(?<court>'
  + '最高裁判所|最高裁'
  + '|最(?:大|[一二三123]小)?(?:判|決)'
  + '|大審院'
  + '|大(?:連)?(?:判|決)'
  + '|[一-龥々]{1,6}?(?:高等|地方|家庭|簡易)裁判所(?:[一-龥]{1,5}支部)?'
  + '|[一-龥々]{1,6}?(?:高|地|家|簡)(?:裁)?(?:[一-龥]{1,5}支)?(?:判|決)'
  + ')';
const EXAM_REFS_CASE_RE = new RegExp(
  EXAM_REFS_COURT_SRC
  + '(?:第?[一二三123]小法廷|大法廷|連合部|民事部|刑事部)?'
  + '(?:判決|決定)?[\\s　]*[（(]?[\\s　]*'
  + '(?<era>明治|大正|昭和|平成|令和|明|大|昭|平|令)[\\s　]*(?<y>[0-9]{1,2}|元)[\\s　]*[年・.,][\\s　]*(?<m>[0-9]{1,2})[\\s　]*[月・.,][\\s　]*(?<d>[0-9]{1,2})日?'
  + '(?:[\\s　]*(?:第?[一二三123]小法廷|大法廷|連合部))?(?:[\\s　]*(?:判決|決定))?',
  'g'
);
// 判決日が先に来る書き方：「昭和４４年１２月１８日最高裁判決」「平成元年３月７日最高裁判所第三小法廷判決」
const EXAM_REFS_CASE_AFTER_RE = new RegExp(
  '(?<era>明治|大正|昭和|平成|令和)[\\s　]*(?<y>[0-9]{1,2}|元)[\\s　]*年[\\s　]*(?<m>[0-9]{1,2})[\\s　]*月[\\s　]*(?<d>[0-9]{1,2})日[\\s　]*'
  + '(?<court>最高裁判所|最高裁|大審院)(?:第?[一二三123]小法廷|大法廷|連合部)?(?:判決|決定)',
  'g'
);
// 判例集の巻号頁：「民集２９巻４号５７２頁」「判例時報１３０８号１１１頁」「民録１０輯８６１頁」
const EXAM_REFS_REP_RE = /^[\s　、・（(〔]*(?<name>民集|刑集|民録|刑録|行集|集民|集刑|下民集|高民集|高刑集|下刑集|労民集|判例時報|判時|判例タイムズ|判タ|労判|労働判例|金判|金融・商事判例|判例地方自治|判自)[\s　]*(?:(?<vol>[0-9]+)[\s　]*(?:巻|輯)[\s　]*)?(?:(?<no>[0-9]+)[\s　]*号[\s　]*)?(?<page>[0-9]+)[\s　]*頁/;
const EXAM_REFS_REP_ALIAS = { 判例時報: '判時', 判例タイムズ: '判タ', 労働判例: '労判', '金融・商事判例': '金判', 判例地方自治: '判自' };
function examRefsCourtKind(court) {
  if (/^最/.test(court)) return '最';
  if (/^大審院$|^大(?:連)?(?:判|決)$/.test(court)) return '大';
  if (/高等裁判所|高(?:裁)?(?:[一-龥]{1,5}支)?(?:判|決)$/.test(court)) return '高';
  if (/地方裁判所|地(?:裁)?(?:[一-龥]{1,5}支)?(?:判|決)$/.test(court)) return '地';
  if (/家庭裁判所|家(?:裁)?(?:[一-龥]{1,5}支)?(?:判|決)$/.test(court)) return '家';
  return '簡';
}
// 文の中の判例の引用を順に返す。key は「最|1975-04-30」の形、rep は「民集29-4-572」（無ければ ''）
function examRefsFindCases(text) {
  const src = String(text || '');
  const norm = examRefsNormalize(src);
  const out = [];
  const raw = [];
  let m;
  EXAM_REFS_CASE_RE.lastIndex = 0;
  while ((m = EXAM_REFS_CASE_RE.exec(norm)) !== null) raw.push(m);
  EXAM_REFS_CASE_AFTER_RE.lastIndex = 0;
  while ((m = EXAM_REFS_CASE_AFTER_RE.exec(norm)) !== null) raw.push(m);
  raw.sort((a, b) => a.index - b.index);
  let lastEnd = 0;
  for (m of raw) {
    if (m.index < lastEnd) continue;
    const g = m.groups;
    let court = g.court;
    let start = m.index;
    // 「前掲東京高決」の「前掲」のような前置きは裁判所名に含めない
    const pre = /^(前掲|上記|同|及び|並びに|又は|参照|の)+/.exec(court);
    if (pre && court.length > pre[0].length && !/^(?:判|決)/.test(court.slice(pre[0].length))) {
      court = court.slice(pre[0].length);
      start += pre[0].length;
    }
    const y = g.y === '元' ? 1 : Number(g.y);
    const mo = Number(g.m), d = Number(g.d);
    if (!(y >= 1 && y <= 64 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
    const year = EXAM_REFS_ERA_BASE[g.era] + y;
    const date = year + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
    const kind = examRefsCourtKind(court);
    let end = m.index + m[0].length;
    let rep = '';
    const r = EXAM_REFS_REP_RE.exec(norm.slice(end, end + 40));
    if (r) {
      const name = EXAM_REFS_REP_ALIAS[r.groups.name] || r.groups.name;
      rep = name + [r.groups.vol, r.groups.no, r.groups.page].filter(Boolean).join('-');
      end += r[0].length;
    }
    out.push({ index: start, length: end - start, text: src.slice(start, end), key: kind + '|' + date, court: kind, date: date, rep: rep });
    lastEnd = end;
  }
  return out;
}
// 判例集が両方に書いてあって食い違うときだけ「別の判例」とみなす（同じ日の別の判決を分けるため）
function examRefsRepCompatible(a, b) {
  if (!a || !b) return true;
  const na = a.replace(/[0-9-]+$/, ''), nb = b.replace(/[0-9-]+$/, '');
  if (na !== nb) return true;
  return a === b;
}
// 判例タブの判例・百選の目次の1件から、照合用の {key, rep} を取り出す（読めなければ null）
function examRefsCaseOfText() {
  for (let i = 0; i < arguments.length; i++) {
    const found = examRefsFindCases(arguments[i]);
    if (found.length > 0) return { key: found[0].key, rep: found[0].rep };
  }
  return null;
}

// --- 条文の参照（法律名つきだけ）。「同法第…条」は、同じ段落で直前に出た法律名で読む ---
function examRefsFindArticles(text) {
  if (typeof lawrefFindRefs !== 'function') return [];
  const src = String(text || '');
  const out = [];
  lawrefFindRefs(src, null).forEach(r => {
    // 「旧民法」「改正前民法」の条番号は今の条文と違うので数えない
    if (/(旧|改正前の?)$/.test(src.slice(Math.max(0, r.index - 4), r.index))) return;
    out.push({ index: r.index, lid: r.lid, num: r.num, branch: r.branch });
  });
  const lawRe = new RegExp(LAWREF_ALIAS_PATTERN, 'g');
  const mentions = [];
  let m;
  while ((m = lawRe.exec(src)) !== null) {
    if (/(旧|改正前の?)$/.test(src.slice(Math.max(0, m.index - 4), m.index))) continue;
    mentions.push({ index: m.index, lid: LAWREF_ALIAS_TO_LID[m[0]] });
  }
  const sameRe = new RegExp('同法第?(' + LAWREF_NUM_PATTERN + ')条(?:の(' + LAWREF_NUM_PATTERN + '))?', 'g');
  while ((m = sameRe.exec(src)) !== null) {
    const before = mentions.filter(x => x.index < m.index);
    if (before.length === 0) continue;
    const num = lawrefParseNum(m[1]);
    const branch = m[2] ? lawrefParseNum(m[2]) : null;
    if (!Number.isFinite(num) || num < 1 || num > 2000) continue;
    if (m[2] && !(branch >= 1 && branch <= 99)) continue;
    out.push({ index: m.index, lid: before[before.length - 1].lid, num: num, branch: branch });
  }
  return out.sort((a, b) => a.index - b.index);
}
function examRefsArticleKey(lid, num, branch) {
  return lid + '|' + num + (branch ? '-' + branch : '');
}

// --- 索引づくり（tools/exam-fetch/build-refs.js から呼ぶ。テストでも作り直して一致を確かめる） ---
// files: [{ code: 'shiho', year: 5, data: <年度のJSON> }]
// 指摘は [試験, 年度, 科目, 段落の番号] の形。同じ段落で同じ条文・判例が何度出ても1回と数える
function examRefsBuildIndex(files) {
  const articles = {};
  const cases = {};
  (files || []).slice().sort((a, b) => (a.code === b.code ? a.year - b.year : (a.code === 'shiho' ? -1 : 1))).forEach(f => {
    const subjects = (f.data && f.data.subjects) || {};
    Object.keys(subjects).forEach(subj => {
      const doc = subjects[subj] && subjects[subj].shushi;
      if (!doc || !doc.paras) return;
      doc.paras.forEach((p, pi) => {
        const mention = [f.code, f.year, subj, pi];
        const seenA = new Set();
        examRefsFindArticles(p).forEach(a => {
          const k = examRefsArticleKey(a.lid, a.num, a.branch);
          if (seenA.has(k)) return;
          seenA.add(k);
          (articles[k] = articles[k] || []).push(mention);
        });
        const seenC = new Set();
        examRefsFindCases(p).forEach(c => {
          const id = c.key + '|' + c.rep;
          if (seenC.has(id)) return;
          seenC.add(id);
          const rec = cases[c.key] = cases[c.key] || { t: c.text, m: [] };
          if (c.rep && rec.t.length < c.text.length) rec.t = c.text;
          rec.m.push(mention.concat([c.rep]));
        });
      });
    });
  });
  const sortObj = o => Object.keys(o).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
  return { v: 1, articles: sortObj(articles), cases: sortObj(cases) };
}

// --- 索引の読み込み（オフラインでは Service Worker の控えから） ---
let examRefsPromise = null;
let examRefsData = null;
function examRefsGet() {
  if (examRefsData) return Promise.resolve(examRefsData);
  if (examRefsPromise) return examRefsPromise;
  examRefsPromise = fetch(EXAM_REFS_URL, { cache: 'no-cache' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(data => { examRefsData = data; return data; });
  examRefsPromise.catch(() => { examRefsPromise = null; });
  return examRefsPromise;
}
// 判例の指摘のうち、判例集の食い違わないもの
function examRefsCaseMentions(refs, key, rep) {
  const rec = refs && refs.cases && refs.cases[key];
  if (!rec) return [];
  return rec.m.filter(x => examRefsRepCompatible(rep, x[4]));
}
function examRefsArticleMentions(refs, lid, num, branch) {
  return (refs && refs.articles && refs.articles[examRefsArticleKey(lid, num, branch)]) || [];
}

// --- 百選の目次（利用者が取り込んだもの） ---
// 形：[{ id, title: '憲法判例百選Ⅰ（第7版）', items: [{ no: '81', name: '薬事法事件', date: '最大判昭和50年4月30日民集29巻4号572頁' }], at }]
function loadHyakusenToc() {
  try {
    const v = JSON.parse(localStorage.getItem(HYAKUSEN_TOC_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function saveHyakusenToc(list) {
  localStorage.setItem(HYAKUSEN_TOC_KEY, JSON.stringify(list || []));
  examRefsMatchMemo = null;
  if (typeof window !== 'undefined' && typeof window.ronshoSyncNotifyChange === 'function') window.ronshoSyncNotifyChange();
}
// 書名から科目を推し量る（一覧の科目分け用）
function hyakusenSubjectOf(title) {
  const t = String(title || '');
  const table = [['民事訴訟', '民事訴訟法'], ['民訴', '民事訴訟法'], ['刑事訴訟', '刑事訴訟法'], ['刑訴', '刑事訴訟法'], ['憲法', '憲法'], ['行政', '行政法'], ['地方自治', '行政法'],
    ['会社', '商法'], ['商法', '商法'], ['手形', '商法'], ['労働', '労働法'], ['刑法', '刑法'], ['家族', '民法'], ['親族', '民法'], ['民法', '民法'], ['民事執行', '民事訴訟法'], ['倒産', '民事訴訟法']];
  const hit = table.find(x => t.includes(x[0]));
  return hit ? hit[1] : 'その他';
}
// 貼り付けた目次の文を読む。1行に「番号　判例名（裁判所・判決日）」の形。
// 「〜百選」を含み、番号も判決日も無い行は書名として扱う（その行より下がその本の判例）
function parseHyakusenToc(text, defaultTitle) {
  const books = [];
  let cur = null;
  const fallback = String(defaultTitle || '').trim();
  const lines = String(text || '').split(/\r?\n/);
  let skipped = 0;
  lines.forEach(raw => {
    const line = raw.replace(/^[\s　]+|[\s　]+$/g, '');
    if (!line) return;
    const cases = examRefsFindCases(line);
    const numM = /^(?:No\.?|Ｎｏ．?|第)?[\s　]*([0-9０-９]{1,3}(?:[-－‐の][0-9０-９]{1,2})?|[ＡＢＣA-C][0-9０-９]{1,2})[\s　]*(?:事件)?[\s　.．、,:：|｜\-－]+/.exec(line);
    if (cases.length === 0) {
      if (!numM && /百選/.test(line)) {
        cur = { title: line.replace(/^[#＃■◆【\s　]+|[】\s　]+$/g, ''), items: [] };
        books.push(cur);
      } else if (numM) {
        skipped++;
      }
      return;
    }
    if (!numM) { skipped++; return; }
    if (!cur) {
      cur = { title: fallback, items: [] };
      books.push(cur);
    }
    const c = cases[0];
    const no = examRefsNormalize(numM[1]).replace(/[－‐]/g, '-');
    let name = line.slice(numM[0].length, c.index).replace(/[\s　（(〔［\[|｜:：,、－\-]+$/, '').replace(/^[\s　|｜]+/, '');
    if (!name) name = line.slice(c.index + c.length).replace(/^[\s　）)〕］\]|｜:：,、]+/, '').replace(/[\s　|｜]+$/, '');
    cur.items.push({ no: no, name: name, date: c.text });
  });
  return { books: books.filter(b => b.items.length > 0), skipped: skipped };
}
// 取り込んだ目次を保存に混ぜる。同じ書名は入れ替え（取り込み直し）
function mergeHyakusenToc(list, books, nowStr) {
  const out = (list || []).slice();
  (books || []).forEach(b => {
    const rec = { id: 'hy' + Math.random().toString(36).slice(2, 10), title: b.title, items: b.items, at: nowStr || '' };
    const i = out.findIndex(x => x.title === b.title);
    if (i >= 0) { rec.id = out[i].id; out[i] = rec; } else out.push(rec);
  });
  return out;
}

// --- 照合：判例の key → 判例タブの判例・百選の目次 ---
let examRefsMatchMemo = null;
function examRefsMatchIndex() {
  const list = typeof precedents !== 'undefined' && Array.isArray(precedents) ? precedents : [];
  const toc = loadHyakusenToc();
  const sig = list.map(p => (p.id || '') + '\u0001' + (p.date || '') + '\u0001' + (p.name || '') + '\u0001' + (p.hyakusen || '')).join('\u0002')
    + '\u0003' + JSON.stringify(toc);
  if (examRefsMatchMemo && examRefsMatchMemo.sig === sig) return examRefsMatchMemo.map;
  const map = {};
  const add = (c, item) => { if (c) (map[c.key] = map[c.key] || []).push(Object.assign({ rep: c.rep }, item)); };
  list.forEach(p => add(examRefsCaseOfText(p.date, p.name), { type: 'precedent', p: p }));
  toc.forEach(b => (b.items || []).forEach(it => add(examRefsCaseOfText(it.date), { type: 'toc', book: b.title, subject: hyakusenSubjectOf(b.title), no: it.no, name: it.name, date: it.date })));
  examRefsMatchMemo = { sig: sig, map: map };
  return map;
}
function examRefsMatchCase(key, rep) {
  const all = examRefsMatchIndex()[key] || [];
  const hits = all.filter(x => examRefsRepCompatible(rep, x.rep));
  return {
    precedents: hits.filter(x => x.type === 'precedent').map(x => x.p),
    toc: hits.filter(x => x.type === 'toc')
  };
}
function examRefsTocLabel(t) {
  return t.book + ' ' + t.no + (/事件$/.test(t.no) ? '' : '事件');
}

// --- 表示の部品 ---
function examRefsDocLabel(code, year, subject) {
  return (EXAM_REFS_EXAM_SHORT[code] || code) + 'R' + year + ' ' + subject;
}
// 指摘の一覧を、年度・科目ごとのボタンにする（押すとその出題趣旨のその段落が開く）
function examRefsMentionChipsHtml(mentions) {
  const groups = [];
  const byDoc = {};
  (mentions || []).forEach(x => {
    const id = x[0] + '|' + x[1] + '|' + x[2];
    if (!byDoc[id]) { byDoc[id] = { code: x[0], year: x[1], subject: x[2], paras: [] }; groups.push(byDoc[id]); }
    byDoc[id].paras.push(x[3]);
  });
  groups.sort((a, b) => (b.year - a.year) || (a.code === b.code ? 0 : a.code === 'shiho' ? -1 : 1));
  return '<span class="examRefChips">' + groups.map(g =>
    '<button type="button" class="examRefMention" data-exam="' + escapeHtml(EXAM_REFS_EXAM_TYPE[g.code] || '') + '" data-year="' + g.year + '" data-subj="' + escapeHtml(g.subject) + '" data-pi="' + g.paras[0] + '"'
    + ' title="' + escapeHtml(examRefsDocLabel(g.code, g.year, g.subject)) + 'の出題趣旨を開く">🎯 ' + escapeHtml(examRefsDocLabel(g.code, g.year, g.subject))
    + (g.paras.length > 1 ? '<span class="examRefChipCount">×' + g.paras.length + '</span>' : '') + '</button>').join('') + '</span>';
}
function examRefsDocCount(mentions) {
  return new Set((mentions || []).map(x => x[0] + '|' + x[1] + '|' + x[2])).size;
}
// 「📝 出題趣旨で指摘（3回）」の開閉つきの欄
function examRefsMentionsDetailsHtml(mentions, cls) {
  if (!mentions || mentions.length === 0) return '';
  const n = examRefsDocCount(mentions);
  return '<details class="examRefDetails ' + (cls || '') + '"><summary>🎯 出題趣旨で指摘（' + n + '回）</summary>' + examRefsMentionChipsHtml(mentions) + '</details>';
}
// 資料の本文（エスケープ済みHTML）の判例の引用に下線を付ける。タグの中は触らない
function examRefsLinkifyCasesHtml(html) {
  if (!html) return html;
  return String(html).split(/(<[^>]*>)/).map(part => {
    if (part.startsWith('<')) return part;
    const found = examRefsFindCases(part);
    if (found.length === 0) return part;
    let out = '', pos = 0;
    found.forEach(c => {
      out += part.slice(pos, c.index);
      const match = examRefsMatchCase(c.key, c.rep);
      const hit = match.precedents.length > 0 || match.toc.length > 0;
      let badge = '';
      if (match.toc.length > 0) badge = '<span class="examCaseBadge">百選' + escapeHtml(match.toc[0].no) + '</span>';
      else if (match.precedents.length > 0) badge = '<span class="examCaseBadge">⚖️</span>';
      out += '<span class="examCaseRef' + (hit ? ' hit' : '') + '" data-act="caseRef" data-ck="' + escapeHtml(c.key) + '" data-rep="' + escapeHtml(c.rep) + '" title="この判例の百選・判例タブ・ほかの年度を見る">'
        + c.text + badge + '</span>';
      pos = c.index + c.length;
    });
    return out + part.slice(pos);
  }).join('');
}

// --- 判例の小さな画面（資料の下線・判例の一覧から開く） ---
function examRefsModalRoot() {
  return typeof document !== 'undefined' ? document.getElementById('lawRefModalRoot') : null;
}
function openExamCasePopup(key, rep, label) {
  const root = examRefsModalRoot();
  if (!root) return;
  const match = examRefsMatchCase(key, rep);
  let body = '';
  if (match.toc.length > 0) {
    body += '<div class="examCaseSection"><div class="examCaseSectionTitle">📚 百選</div>'
      + match.toc.map(t => '<div class="examCaseTocItem"><b>' + escapeHtml(examRefsTocLabel(t)) + '</b>　' + escapeHtml(t.name) + '</div>').join('') + '</div>';
  }
  body += '<div class="examCaseSection"><div class="examCaseSectionTitle">⚖️ 判例タブ</div>';
  if (match.precedents.length > 0) {
    body += match.precedents.map(p => '<button type="button" class="stackBtn examCaseOpenPrecedent" data-pid="' + escapeHtml(p.id) + '">⚖️ ' + escapeHtml(precedentDisplayTitle(p)) + ' を開く</button>').join('');
  } else {
    const t = match.toc[0];
    body += '<div class="past-log-small-note">判例タブには、まだ登録されていません。</div>'
      + '<button type="button" class="stackBtn examCaseAddPrecedent" data-name="' + escapeHtml(t ? t.no + '　' + t.name : '') + '" data-date="' + escapeHtml(t ? t.date : label) + '"'
      + ' data-subject="' + escapeHtml(t ? t.subject : '') + '" data-hyakusen="' + escapeHtml(t ? examRefsTocLabel(t) : '') + '">＋ 判例タブに追加する</button>';
  }
  if (match.toc.length === 0 && loadHyakusenToc().length === 0) {
    body += '<div class="past-log-small-note">判例タブの「🎯 出題趣旨の判例」で百選の目次を取り込むと、百選の番号も出ます。</div>';
  }
  body += '</div>';
  body += '<div class="examCaseSection" id="examCaseMentions"><div class="lawModalLoading">読み込み中…</div></div>';
  root.innerHTML = '<div class="lawModalOverlay" id="lawModalOverlay">'
    + '<div class="lawModalBox examCaseBox">'
    + '<div class="lawModalHeader"><span>⚖️ ' + escapeHtml(label || key) + '</span><span class="lawModalCloseBtn" id="lawModalCloseBtn">✖</span></div>'
    + '<div class="lawModalBody">' + body + '</div>'
    + '</div></div>';
  examRefsGet().then(refs => {
    const box = document.getElementById('examCaseMentions');
    if (!box) return;
    const ms = examRefsCaseMentions(refs, key, rep);
    box.innerHTML = '<div class="examCaseSectionTitle">🎯 この判例を指摘した出題趣旨（' + examRefsDocCount(ms) + '回）</div>'
      + (ms.length ? examRefsMentionChipsHtml(ms) : '<div class="past-log-small-note">出題趣旨では見つかりませんでした（採点実感だけで触れている判例もあります）。</div>');
  }).catch(err => {
    const box = document.getElementById('examCaseMentions');
    if (box) box.innerHTML = '<div class="past-log-small-note">指摘の一覧を読み込めませんでした（' + escapeHtml(err.message) + '）。</div>';
  });
}

// --- 判例タブへ移る ---
function examRefsOpenPrecedent(pid) {
  if (typeof precedents === 'undefined') return;
  precedentSubjectFilter = 'all';
  precedentSearchQuery = '';
  const search = document.getElementById('precedentSearchInput');
  if (search) search.value = '';
  const list = precedentFilteredList();
  const i = list.findIndex(p => p.id === pid);
  if (i < 0) return;
  precedentIndex = i;
  precedentRevealed = true;
  precedentExamMode = false;
  const tab = document.querySelector('.tabBtn[data-page="precedentPage"]');
  if (tab && !tab.classList.contains('active')) tab.click();
  renderPrecedentPage();
  const area = document.getElementById('precedentArea');
  if (area && area.scrollIntoView) { try { area.scrollIntoView({ block: 'start' }); } catch (e) {} }
}
// 未登録の判例を、判例名・判決日・百選を入れた状態で追加フォームに出す（保存は利用者が押す）
function examRefsAddPrecedent(values) {
  const tab = document.querySelector('.tabBtn[data-page="precedentPage"]');
  if (tab && !tab.classList.contains('active')) tab.click();
  precedentExamMode = false;
  if (typeof resetPrecedentForm === 'function') resetPrecedentForm();
  renderPrecedentPage();
  setPrecedentFormOpen(true);
  const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  set('precedentNameInput', values.name);
  set('precedentDateInput', values.date);
  set('precedentSubjectInput', values.subject);
  set('precedentHyakusenInput', values.hyakusen);
  const form = document.getElementById('precedentForm');
  if (form && form.scrollIntoView) { try { form.scrollIntoView({ block: 'start' }); } catch (e) {} }
}

// --- 判例タブ：判例ごとの「出題趣旨での指摘」 ---
function renderPrecedentExamRefs(p) {
  const box = typeof document !== 'undefined' ? document.getElementById('precedentExamRefs') : null;
  if (!box || !p) return;
  const c = examRefsCaseOfText(p.date, p.name);
  if (!c) {
    box.innerHTML = '<div class="past-log-small-note">判決日（例：最大判昭和50年4月30日）が読み取れないため、出題趣旨と照らし合わせられません。</div>';
    return;
  }
  examRefsGet().then(refs => {
    if (!box.isConnected) return;
    const ms = examRefsCaseMentions(refs, c.key, c.rep);
    box.innerHTML = ms.length
      ? '<div class="examRefLine"><span class="examRefLineTitle">🎯 出題趣旨で指摘（' + examRefsDocCount(ms) + '回）</span>' + examRefsMentionChipsHtml(ms) + '</div>'
      : '<div class="past-log-small-note">🎯 令和の出題趣旨では、この判例は見つかりませんでした。</div>';
  }).catch(() => { if (box.isConnected) box.innerHTML = ''; });
}

// --- 判例タブ：出題趣旨で指摘された判例の一覧（百選にあるもの） ---
let precedentExamMode = false;
const precedentExamState = { subject: 'all', showAll: false, message: '' };
const EXAM_REFS_SUBJECT_ORDER = ['憲法', '民法', '刑法', '行政法', '商法', '民事訴訟法', '刑事訴訟法', '労働法', '実務基礎民事', '実務基礎刑事'];
// 指摘された判例を、照合結果つきで並べる（指摘の多い順）
function examRefsCaseRows(refs, showAll) {
  const rows = [];
  Object.keys((refs && refs.cases) || {}).forEach(key => {
    const rec = refs.cases[key];
    // 同じ日の別の判決（判例集が違う）は分けて数える
    const reps = [...new Set(rec.m.map(x => x[4]).filter(Boolean))];
    const variants = reps.length > 1 ? reps : [reps[0] || ''];
    variants.forEach(rep => {
      const ms = rec.m.filter(x => examRefsRepCompatible(rep, x[4]));
      const match = examRefsMatchCase(key, rep);
      const inToc = match.toc.length > 0;
      const registered = match.precedents.length > 0;
      if (!showAll && !inToc && !registered) return;
      const subjects = {};
      ms.forEach(x => { subjects[x[2]] = (subjects[x[2]] || 0) + 1; });
      const subject = (match.toc[0] && match.toc[0].subject !== 'その他' && match.toc[0].subject)
        || (match.precedents[0] && match.precedents[0].subject)
        || Object.keys(subjects).sort((a, b) => subjects[b] - subjects[a])[0];
      rows.push({ key: key, rep: rep, label: rec.t + (reps.length > 1 && rep && rec.t.indexOf(rep) < 0 ? '（' + rep + '）' : ''),
        mentions: ms, count: examRefsDocCount(ms), match: match, subject: subject });
    });
  });
  rows.sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : 1));
  return rows;
}
function renderPrecedentExamPane() {
  const pane = typeof document !== 'undefined' ? document.getElementById('precedentExamPane') : null;
  if (!pane) return;
  const toc = loadHyakusenToc();
  const tocCount = toc.reduce((a, b) => a + (b.items || []).length, 0);
  const st = precedentExamState;
  let head = '<div class="past-log-small-note">令和の出題趣旨（司法試験・予備試験）に出てくる判例のうち、百選の目次または判例タブにあるものを、指摘の多い順に並べます。判決日で照らし合わせています。</div>';
  head += '<details class="dataIoSection hyakusenTocBox"' + (tocCount === 0 ? ' open' : '') + '><summary class="dataIoSectionTitle">📚 百選の目次（' + toc.length + '冊・' + tocCount + '件）</summary>'
    + '<div class="dupCheckIntro">お持ちの百選の目次を取り込むと、出題趣旨の判例に「百選○事件」と出ます（この端末と同期先にだけ保存され、アプリには入っていません）。</div>'
    + '<ol class="past-log-small-note hyakusenTocSteps"><li>「📷 目次の写真から読み取る指示文をコピー」を押し、Claudeアプリに貼り付けて、目次のページの写真と一緒に送る。</li>'
    + '<li>返ってきた文を下に貼り付け、書名を確かめて「📥 取り込む」。同じ書名は入れ替わります。</li></ol>'
    + '<div class="bookActionsRow"><input type="text" id="hyakusenTocTitleInput" placeholder="書名（例：憲法判例百選Ⅰ 第7版）" style="flex:1 1 220px;">'
    + '<button type="button" class="stackBtn" data-hy="prompt">📷 目次の写真から読み取る指示文をコピー</button></div>'
    + '<textarea id="hyakusenTocInput" class="editBodyArea precedentTextarea" placeholder="例：&#10;憲法判例百選Ⅰ（第7版）&#10;1　（判例名）（最大判昭和53年10月4日民集32巻7号1223頁）&#10;2　（判例名）（最判平成…年…月…日）"></textarea>'
    + '<div class="bookActionsRow"><button type="button" class="stackBtn" data-hy="import">📥 取り込む</button></div>'
    + (st.message ? '<div class="examDocMessage">' + escapeHtml(st.message) + '</div>' : '')
    + (toc.length ? '<div class="hyakusenTocList">' + toc.map(b => '<div class="hyakusenTocRow"><span>' + escapeHtml(b.title || '（書名なし）') + '（' + (b.items || []).length + '件）</span>'
      + '<button type="button" class="stackBtn" data-hy="delete" data-id="' + escapeHtml(b.id) + '">🗑️ 削除</button></div>').join('') + '</div>' : '')
    + '</details>';
  pane.innerHTML = head + '<div id="precedentExamList"><div class="lawModalLoading">読み込み中…</div></div>';
  examRefsGet().then(refs => {
    const listEl = document.getElementById('precedentExamList');
    if (!listEl) return;
    const rows = examRefsCaseRows(refs, st.showAll);
    const subjects = EXAM_REFS_SUBJECT_ORDER.filter(s => rows.some(r => r.subject === s));
    if (st.subject !== 'all' && !subjects.includes(st.subject)) st.subject = 'all';
    const shown = st.subject === 'all' ? rows : rows.filter(r => r.subject === st.subject);
    let html = '<div class="progressViewToggle" style="flex-wrap:wrap;">' + ['all'].concat(subjects).map(s =>
      '<button type="button" class="progressViewToggleBtn' + (st.subject === s ? ' active' : '') + '" data-hy="subject" data-subject="' + escapeHtml(s) + '">'
      + (s === 'all' ? 'すべて' : escapeHtml(s)) + '（' + (s === 'all' ? rows.length : rows.filter(r => r.subject === s).length) + '）</button>').join('') + '</div>';
    html += '<label class="past-log-small-note examRefShowAll"><input type="checkbox" data-hy="showAll"' + (st.showAll ? ' checked' : '') + '> 百選の目次・判例タブに無い判例も出す</label>';
    if (shown.length === 0) {
      html += '<div class="quizEmpty">' + (st.showAll ? '出題趣旨に判例が見つかりませんでした。'
        : (toc.length ? '取り込んだ百選・判例タブの判例のうち、出題趣旨で指摘されたものはありませんでした。' : '上で百選の目次を取り込むか、判例タブに判例を登録すると、ここに出ます。')) + '</div>';
    } else {
      html += shown.map(r => {
        const t = r.match.toc[0];
        const p = r.match.precedents[0];
        const title = t ? examRefsTocLabel(t) + '　' + t.name : p ? precedentDisplayTitle(p) : r.label;
        return '<div class="lawStockCard examRefCaseCard">'
          + '<div class="lawStockTitle">' + (t ? '📚 ' : p ? '⚖️ ' : '') + escapeHtml(title) + '<span class="examRefCount">' + r.count + '回</span></div>'
          + '<div class="lawStockCaption">' + escapeHtml(r.label) + (r.subject ? '　｜ ' + escapeHtml(r.subject) : '') + '</div>'
          + examRefsMentionChipsHtml(r.mentions)
          + '<div class="bookActionsRow">'
          + (p ? '<button type="button" class="stackBtn examCaseOpenPrecedent" data-pid="' + escapeHtml(p.id) + '">⚖️ 判例タブで開く</button>'
            : '<button type="button" class="stackBtn examCaseAddPrecedent" data-name="' + escapeHtml(t ? t.no + '　' + t.name : '') + '" data-date="' + escapeHtml(t ? t.date : r.label) + '" data-subject="' + escapeHtml(t ? t.subject : r.subject || '') + '" data-hyakusen="' + escapeHtml(t ? examRefsTocLabel(t) : '') + '">＋ 判例タブに追加</button>')
          + '</div></div>';
      }).join('');
    }
    listEl.innerHTML = html;
  }).catch(err => {
    const listEl = document.getElementById('precedentExamList');
    if (listEl) listEl.innerHTML = '<div class="lawModalError">出題趣旨の索引を読み込めませんでした。' + (typeof navigator !== 'undefined' && !navigator.onLine ? 'オフラインのようです。' : '') + '（' + escapeHtml(err.message) + '）</div>';
  });
}
const HYAKUSEN_TOC_PROMPT = [
  'この写真は、判例百選の目次のページです。目次に載っている判例を、次の形式で1件1行ずつ書き出してください。',
  '',
  '1行目：書名と版（例：憲法判例百選Ⅰ（第7版））',
  '2行目から：事件番号　判例名（裁判所・判決日・判例集）',
  '例：12　〇〇事件（最大判昭和50年4月30日民集29巻4号572頁）',
  '',
  '・判決日は「最大判」「最判」「最決」「大判」「東京高判」などの裁判所の略称を付け、和暦の「昭和50年4月30日」の形で書いてください（目次に無ければ空けずに、その判例の本文の見出しにある判決日を使ってください）。',
  '・判例集（民集・刑集・判時など）は目次に書いてあるときだけ付けてください。',
  '・番号・判決日は写真のとおりに書き写し、分からないものは推測で埋めずに「？」と書いてください。',
  '・説明や前置きは書かず、上の形式の行だけを返してください。'
].join('\n');
function initPrecedentExamFeature() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const btn = document.getElementById('precedentExamToggleBtn');
  const pane = document.getElementById('precedentExamPane');
  if (!btn || !pane || !pane.addEventListener) return;
  btn.addEventListener('click', () => {
    precedentExamMode = !precedentExamMode;
    if (precedentExamMode && typeof setPrecedentFormOpen === 'function') { resetPrecedentForm(); setPrecedentFormOpen(false); }
    renderPrecedentPage();
  });
  pane.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-hy]') : null;
    if (!el || el.tagName === 'INPUT') return;
    const st = precedentExamState;
    const act = el.dataset.hy;
    if (act === 'subject') { st.subject = el.dataset.subject || 'all'; renderPrecedentExamPane(); return; }
    if (act === 'prompt') {
      if (typeof copyPrecedentText === 'function') copyPrecedentText(HYAKUSEN_TOC_PROMPT, '📋 目次を読み取る指示文をコピーしました。Claudeアプリに貼り付け、目次の写真と一緒に送ってください。');
      return;
    }
    if (act === 'import') {
      const text = (document.getElementById('hyakusenTocInput') || {}).value || '';
      const title = (document.getElementById('hyakusenTocTitleInput') || {}).value || '';
      const parsed = parseHyakusenToc(text, title);
      if (parsed.books.length === 0) {
        st.message = '判例を読み取れませんでした。1行に「番号　判例名（最判昭和50年4月30日）」の形で入っているか確かめてください。';
      } else if (parsed.books.some(b => !b.title)) {
        st.message = '書名が分かりません。1行目に「〇〇判例百選（第○版）」を入れるか、上の書名の欄に入力してください。';
      } else {
        saveHyakusenToc(mergeHyakusenToc(loadHyakusenToc(), parsed.books, typeof examDocsTodayStr === 'function' ? examDocsTodayStr(new Date()) : ''));
        st.message = '📥 ' + parsed.books.map(b => b.title + '（' + b.items.length + '件）').join('・') + 'を取り込みました。'
          + (parsed.skipped ? '判決日が読み取れなかった' + parsed.skipped + '行は入れていません。' : '');
      }
      renderPrecedentExamPane();
      return;
    }
    if (act === 'delete') {
      const list = loadHyakusenToc();
      const b = list.find(x => x.id === el.dataset.id);
      if (!b || !confirm('「' + (b.title || '書名なし') + '」の目次を削除しますか？')) return;
      saveHyakusenToc(list.filter(x => x.id !== b.id));
      st.message = '🗑️ 「' + (b.title || '書名なし') + '」の目次を削除しました。';
      renderPrecedentExamPane();
    }
  });
  pane.addEventListener('change', (e) => {
    const el = e.target;
    if (el && el.dataset && el.dataset.hy === 'showAll') { precedentExamState.showAll = !!el.checked; renderPrecedentExamPane(); }
  });
}

// --- 条文タブ：出題趣旨で指摘された条文の一覧 ---
const lawExamState = { subject: 'all' };
function examRefsArticleRows(refs) {
  return Object.keys((refs && refs.articles) || {}).map(k => {
    const sep = k.indexOf('|');
    const lid = k.slice(0, sep);
    const rest = k.slice(sep + 1);
    const dash = rest.indexOf('-');
    const num = Number(dash === -1 ? rest : rest.slice(0, dash));
    const branch = dash === -1 ? null : Number(rest.slice(dash + 1));
    const law = LAWREF_LAWS[lid];
    const ms = refs.articles[k];
    return { key: k, lid: lid, num: num, branch: branch, mentions: ms, count: examRefsDocCount(ms),
      subject: typeof lawrefSubjectOf === 'function' ? lawrefSubjectOf(lid) : 'その他',
      label: (law ? law.name : lid) + num + '条' + (branch ? 'の' + branch : '') };
  }).filter(r => LAWREF_LAWS[r.lid]).sort((a, b) => (b.count - a.count) || lawrefStockCompare(a, b));
}
function renderLawExamPane() {
  const area = typeof document !== 'undefined' ? document.getElementById('lawExamArea') : null;
  if (!area) return;
  area.innerHTML = '<div class="lawModalLoading">読み込み中…</div>';
  examRefsGet().then(refs => {
    const rows = examRefsArticleRows(refs);
    const subjects = LAWREF_SUBJECT_ORDER.filter(s => rows.some(r => r.subject === s));
    if (lawExamState.subject !== 'all' && !subjects.includes(lawExamState.subject)) lawExamState.subject = 'all';
    const shown = lawExamState.subject === 'all' ? rows : rows.filter(r => r.subject === lawExamState.subject);
    let html = '<div class="past-log-small-note">令和の出題趣旨（司法試験・予備試験）で、法律名を付けて挙げられた条文です（「同法第○条」も数えます。「法第○条」のように法律名の無いものは数えていません）。数字は、指摘した出題趣旨の数です。</div>';
    html += '<div class="progressViewToggle" style="flex-wrap:wrap;">' + ['all'].concat(subjects).map(s =>
      '<button type="button" class="progressViewToggleBtn lawExamSubjectBtn' + (lawExamState.subject === s ? ' active' : '') + '" data-subject="' + escapeHtml(s) + '">'
      + (s === 'all' ? 'すべて' : escapeHtml(s)) + '（' + (s === 'all' ? rows.length : rows.filter(r => r.subject === s).length) + '）</button>').join('') + '</div>';
    html += shown.map(r => '<div class="lawStockCard lawExamCard">'
      + '<div class="lawStockTitle">📜 ' + escapeHtml(r.label) + '<span class="examRefCount">' + r.count + '回</span></div>'
      + examRefsMentionChipsHtml(r.mentions)
      + '<div class="bookActionsRow"><button type="button" class="stackBtn lawExamViewBtn" data-lid="' + escapeHtml(r.lid) + '" data-num="' + r.num + '"' + (r.branch ? ' data-branch="' + r.branch + '"' : '') + ' data-label="' + escapeHtml(r.label) + '">📖 条文を見る</button></div>'
      + '</div>').join('');
    area.innerHTML = html;
  }).catch(err => {
    area.innerHTML = '<div class="lawModalError">出題趣旨の索引を読み込めませんでした。' + (typeof navigator !== 'undefined' && !navigator.onLine ? 'オフラインのようです。' : '') + '（' + escapeHtml(err.message) + '）</div>';
  });
}
function initLawExamFeature() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const area = document.getElementById('lawExamArea');
  if (!area || !area.addEventListener) return;
  area.addEventListener('click', (e) => {
    const sb = e.target.closest('.lawExamSubjectBtn');
    if (sb) { lawExamState.subject = sb.dataset.subject || 'all'; renderLawExamPane(); return; }
    const vb = e.target.closest('.lawExamViewBtn');
    if (vb) openLawRefPopup(vb);
  });
}

// --- どの画面からでも：指摘のボタン・判例の画面のボタン ---
function initExamRefsGlobal() {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  document.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    const chip = e.target.closest('.examRefMention');
    if (chip) {
      if (typeof closeLawRefPopup === 'function') closeLawRefPopup();
      openExamDocs({ examType: chip.dataset.exam, year: Number(chip.dataset.year), subject: chip.dataset.subj, kind: 'shushi', focusPara: Number(chip.dataset.pi) });
      return;
    }
    const open = e.target.closest('.examCaseOpenPrecedent');
    if (open) {
      if (typeof closeLawRefPopup === 'function') closeLawRefPopup();
      examRefsOpenPrecedent(open.dataset.pid);
      return;
    }
    const add = e.target.closest('.examCaseAddPrecedent');
    if (add) {
      if (typeof closeLawRefPopup === 'function') closeLawRefPopup();
      examRefsAddPrecedent({ name: add.dataset.name, date: add.dataset.date, subject: add.dataset.subject, hyakusen: add.dataset.hyakusen });
    }
  });
}
initPrecedentExamFeature();
initLawExamFeature();
initExamRefsGlobal();
/* ▲▲▲ 出題趣旨で指摘された条文・判例のつながり ここまで ▲▲▲ */
