/* ▼▼▼ 過去問の資料（問題・出題趣旨・採点実感）v32.0〜 ▼▼▼
   法務省ウェブサイトのPDFから抜き出した文（data/exam/*.json、作り方は tools/exam-fetch/build.py）を、
   「📝 過去問ログ」タブの中で年度・科目ごとに読めるようにする。
   ・入口：年度×科目の表のマスを長押し（右クリック）→ 下から資料のボタン（案1）／表の上の「📄 資料」
   ・読む画面：問題／出題趣旨／採点実感をタブで切り替え（案3）、広い画面では3列に並べる（案4）
   ・採点実感の文に色を付ける（良い例＝緑、注意点＝赤）（案5）
   ・論証の「出題年」が同じ年度・科目の論証を並べる。頻出論点ランキングの年度からも開ける（案7）
   ・「✍ 解く」でタイマー → 書き終えるまで趣旨・実感は閉じたまま → 書き終えたら解答ログに記録（案8）
   ・読んだ印（ronshoExamReadV1、同期・バックアップ対象）と年度ごとの進み具合（案10）
   データは開いた年度の分だけ取得し、端末（IndexedDB ronshoExamDocsDB）に控えを残すので、
   一度開いた年度はオフラインでも読める。控えは再取得できるので同期・バックアップの対象外。
   出典：法務省ウェブサイト（公共データ利用規約 PDL1.0）。各資料の下に元のページを表示する。 */
const EXAM_DOCS_BASE = 'data/exam/';
const EXAM_DOCS_DB_NAME = 'ronshoExamDocsDB';
const EXAM_READ_KEY = 'ronshoExamReadV1';
const EXAM_PRACTICE_KEY = 'ronshoExamPracticeV1';
const EXAM_DOCS_VIEW_KEY = 'ronshoExamDocsViewV1';
const EXAM_DOCS_KINDS = [
  { id: 'mondai', label: '問題', icon: '📄', mark: 'm' },
  { id: 'shushi', label: '出題趣旨', icon: '🎯', mark: 's' },
  { id: 'jikkan', label: '採点実感', icon: '✍', mark: 'j' }
];
// アプリの種別名（過去問ログの「新司法試験」「予備試験」）→ データのファイル名の頭
const EXAM_DOCS_EXAM_CODE = { '新司法試験': 'shiho', '予備試験': 'yobi' };
const EXAM_DOCS_REIWA_MIN = 1;

function examDocsKind(id) { return EXAM_DOCS_KINDS.find(k => k.id === id) || EXAM_DOCS_KINDS[0]; }
function examDocsCode(examType) { return EXAM_DOCS_EXAM_CODE[examType] || 'shiho'; }
function examDocsFileName(examType, year) { return examDocsCode(examType) + '-R' + year + '.json'; }
function examDocsYearLabel(year) { return year === 1 ? '令和元年' : '令和' + year + '年'; }
function examDocsSubjects() {
  return typeof PAST_EXAM_MATRIX_SUBJECTS !== 'undefined' ? PAST_EXAM_MATRIX_SUBJECTS.map(s => s.name)
    : ['憲法', '民法', '刑法', '行政法', '商法', '民事訴訟法', '刑事訴訟法', '労働法', '実務基礎民事', '実務基礎刑事'];
}
// その試験・年度にその科目があるか（過去問ログの表と同じ決まり：実務基礎は予備試験だけ、
// 予備試験の労働法は令和4年から）
function examDocsSubjectApplies(examType, subject, year) {
  if (typeof pastMatrixApplicable === 'function') return pastMatrixApplicable(examType, subject, { era: 'R', num: year });
  if ((subject === '実務基礎民事' || subject === '実務基礎刑事') && examType !== '予備試験') return false;
  if (subject === '労働法' && examType === '予備試験') return year >= 4;
  return true;
}
function examDocsMaxYear() {
  return typeof pastMatrixMaxReiwaYear === 'function' ? pastMatrixMaxReiwaYear() : Math.max(8, new Date().getFullYear() - 2018);
}

// --- 文の見た目 ---
// 段落が見出し（〔第１問〕・［労働法］・【事例】・「１　出題の趣旨」など）かどうか
function examDocsIsHeading(p) {
  const s = String(p || '');
  if (s.length > 48) return false;
  if (/[。]$/.test(s)) return false;
  return /^(〔[^〕]*〕|［[^］]*］|\[[^\]]*\]|【[^】]*】|（[^）]{1,20}）$|[0-9０-９]{1,2}[　\s．.]|第[0-9０-９一二三四五六七八九十]+[　\s]|[⑴-⒇]|\([0-9０-９]+\)|（[0-9０-９]+）)/.test(s);
}
// 「。」で文に分ける（「。」は前の文に付けたまま）。括弧の中の「。」でも切るが、色付けの単位としては十分
function examDocsSplitSentences(p) {
  const out = [];
  const re = /[^。]*。|[^。]+$/g;
  let m;
  const s = String(p || '');
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') break;
    out.push(m[0]);
  }
  return out;
}
// 採点実感の文の色分け（案5）。言い回しだけで判定するので、外れることもある
const EXAM_DOCS_BAD_RE = /(不十分|不正確|不適切|不明確|不明瞭|誤り|誤って|誤解|誤った|欠く|欠いて|欠ける|乏しい|残念|散見|目立った|目に付いた|少なくなか|少なからず|できていない|できていなかった|論じていない|論じられていない|触れていない|触れられていない|言及していない|言及がない|検討していない|検討されていない|示していない|示されていない|理解していない|意識していない|見られなかった|見当たらなかった|ほとんどなかった|ほとんど見られ|混同|看過|曖昧|安易|羅列|途中答案|時間切れ|物足りな|疑問がある|問題がある|留意すべき|注意すべき|すべきでない|避けるべき|書き写|写しただけ|丸写し|一定数見られ|相当数見られ|多数見られ|まま結論)/;
// 良い例：はっきり褒めている言い回しはそれだけで緑。「的確に」「正確に」のような言葉は、
// 採点方針の説明（「〜を的確に行うことができるかを問う」）にも出てくるので、「答案」の話をしている文だけ緑にする
const EXAM_DOCS_GOOD_STRONG_RE = /(よく書けて|良く書けて|よくできて|良くできて|高く評価|高い評価|好印象|良好な答案|優秀な答案|良い答案|優れた答案|評価できる|好ましい|出来が良|出来は良)/;
const EXAM_DOCS_GOOD_SOFT_RE = /(的確に(論|指摘|検討|分析|示|理解|把握)|正確に(論|理解|指摘|把握|示)|適切に(論|指摘|検討|分析|示|理解|把握)|十分に(論|検討)|説得的|丁寧に(論|検討|分析)|充実した論述)/;
function examDocsClassifySentence(s) {
  const t = String(s || '');
  if (EXAM_DOCS_BAD_RE.test(t)) return 'bad';
  if (EXAM_DOCS_GOOD_STRONG_RE.test(t)) return 'good';
  if (EXAM_DOCS_GOOD_SOFT_RE.test(t) && /答案/.test(t)) return 'good';
  return '';
}
function examDocsParagraphClass(p) {
  const kinds = examDocsSplitSentences(p).map(examDocsClassifySentence);
  return { bad: kinds.includes('bad'), good: kinds.includes('good') };
}
// 1つの段落をHTMLにする。hl が真なら文ごとに色を付ける
function examDocsParaHtml(p, hl) {
  if (examDocsIsHeading(p)) return '<p class="examDocH">' + escapeHtml(p) + '</p>';
  if (!hl) return '<p>' + escapeHtml(p) + '</p>';
  const html = examDocsSplitSentences(p).map(s => {
    const c = examDocsClassifySentence(s);
    if (c === 'bad') return '<span class="examHlBad">' + escapeHtml(s) + '</span>';
    if (c === 'good') return '<span class="examHlGood">' + escapeHtml(s) + '</span>';
    return escapeHtml(s);
  }).join('');
  return '<p>' + html + '</p>';
}
// filter: 'all' | 'bad' | 'good'。絞り込むときも見出しは残し、どの設問の話かが分かるようにする
function examDocsBodyHtml(paras, opts) {
  const hl = !!(opts && opts.hl);
  const filter = (opts && opts.filter) || 'all';
  const list = (paras || []).filter(p => {
    if (filter === 'all' || examDocsIsHeading(p)) return true;
    const c = examDocsParagraphClass(p);
    return filter === 'bad' ? c.bad : c.good;
  });
  let html = list.map(p => examDocsParaHtml(p, hl)).join('');
  // 条文リンク：試験の文は「本件条例第３２条」のような架空の法令が多いので、
  // 法律名つきの参照（「民法第４１５条」「行訴法第９条」など）だけに付ける（科目を渡さない）
  if (typeof linkifyLawRefs === 'function') html = linkifyLawRefs(html, null);
  return html;
}
function examDocsCountMarks(paras) {
  let good = 0, bad = 0;
  (paras || []).forEach(p => {
    if (examDocsIsHeading(p)) return;
    examDocsSplitSentences(p).forEach(s => {
      const c = examDocsClassifySentence(s);
      if (c === 'good') good++;
      else if (c === 'bad') bad++;
    });
  });
  return { good: good, bad: bad };
}

// --- 読んだ印（案10）。他の端末にも同期する ---
// 形：{ "新司法試験|7|民法": { m: "2026-11-21", s: "...", j: "..." } }（読んだ日。読んでいなければ項目なし）
function examDocsReadKey(examType, year, subject) { return examType + '|' + year + '|' + subject; }
function loadExamRead() {
  try {
    const v = JSON.parse(localStorage.getItem(EXAM_READ_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function saveExamRead(map) {
  localStorage.setItem(EXAM_READ_KEY, JSON.stringify(map || {}));
  if (typeof window !== 'undefined' && typeof window.ronshoSyncNotifyChange === 'function') window.ronshoSyncNotifyChange();
}
function examDocsTodayStr(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function examDocsIsRead(map, examType, year, subject, kindId) {
  const rec = map[examDocsReadKey(examType, year, subject)];
  return !!(rec && rec[examDocsKind(kindId).mark]);
}
// on: true＝読んだ／false＝読んでいない。新しい map を返す（引数は書き換えない）
function examDocsSetRead(map, examType, year, subject, kindId, on, dateStr) {
  const out = Object.assign({}, map);
  const key = examDocsReadKey(examType, year, subject);
  const rec = Object.assign({}, out[key] || {});
  const mark = examDocsKind(kindId).mark;
  if (on) rec[mark] = dateStr || examDocsTodayStr(); else delete rec[mark];
  if (Object.keys(rec).length === 0) delete out[key]; else out[key] = rec;
  return out;
}
// 年度ごとの進み具合：公表されている資料のうち、読んだ数
function examDocsYearProgress(map, examType, year, indexEntry) {
  let total = 0, done = 0;
  const subjects = (indexEntry && indexEntry.subjects) || {};
  Object.keys(subjects).forEach(subj => {
    subjects[subj].forEach(kindId => {
      total++;
      if (examDocsIsRead(map, examType, year, subj, kindId)) done++;
    });
  });
  return { total: total, done: done };
}

// --- 論証とのつながり（案7） ---
// 「出題年」の1つの区切り（例 "R5|#2fff2e"）から、令和の年と試験を読み取る。
// 緑（#2fff2e）＝新司法試験、水色（#00ccff/#00dcff）＝予備試験、色なし＝どちらか決めていない（null）
function examDocsParseYearToken(tok) {
  const [rawText, rawColor] = String(tok || '').split('|');
  const text = String(rawText || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  let m = text.match(/^(?:R|Ｒ|令和)\s*(元|[0-9]{1,2})/);
  if (!m) return null;
  const year = m[1] === '元' ? 1 : Number(m[1]);
  if (!(year >= 1 && year <= 99)) return null;
  const color = String(rawColor || '').toLowerCase();
  let examType = null;
  if (color === '#2fff2e') examType = '新司法試験';
  else if (color === '#00ccff' || color === '#00dcff') examType = '予備試験';
  return { year: year, examType: examType, text: rawText };
}
function examDocsEntryMatches(e, examType, year, subject) {
  if (!e || (e.subject || '') !== subject) return false;
  return String(e.year || '').split(';').filter(Boolean).some(tok => {
    const t = examDocsParseYearToken(tok);
    return t && t.year === year && (t.examType === null || t.examType === examType);
  });
}
function examDocsRelatedEntries(list, examType, year, subject) {
  return (list || []).filter(e => examDocsEntryMatches(e, examType, year, subject));
}
// 頻出論点ランキングの「出題年」を、令和の年度は資料へのリンクにして返す（色は元のまま）
function examDocsYearLinksHtml(e, fallbackExamType) {
  const yearStr = e && e.year;
  if (!yearStr) return '';
  return String(yearStr).split(';').filter(Boolean).map(tok => {
    const [text, rawColor] = tok.split('|');
    const color = typeof sanitizeHexColor === 'function' ? sanitizeHexColor(rawColor) : null;
    const style = color ? ' style="color:' + color + '; font-weight:bold;"' : '';
    const t = examDocsParseYearToken(tok);
    if (!t || t.year > examDocsMaxYear()) return '<span' + style + '>' + escapeHtml(text) + '</span>';
    const examType = t.examType || fallbackExamType || '新司法試験';
    if (!examDocsSubjectApplies(examType, e.subject || '', t.year)) return '<span' + style + '>' + escapeHtml(text) + '</span>';
    return '<span class="examYearLink"' + style + ' data-exam="' + escapeHtml(examType) + '" data-year="' + t.year
      + '" data-subj="' + escapeHtml(e.subject || '') + '" title="' + escapeHtml(examType + ' ' + examDocsYearLabel(t.year) + ' ' + (e.subject || '') + 'の出題趣旨を開く') + '">'
      + escapeHtml(text) + '</span>';
  }).join(', ');
}

// --- 解いてから答え合わせ（案8） ---
// 試験時間の目安（分）。司法試験は1問2時間（選択科目は2問で3時間）、
// 予備試験は1科目70分（法律実務基礎科目は民事・刑事で3時間＝各90分）。画面で変えられる
function examDocsDefaultMinutes(examType, subject) {
  if (examType === '予備試験') return (subject === '実務基礎民事' || subject === '実務基礎刑事') ? 90 : 70;
  return subject === '労働法' ? 180 : 120;
}
const EXAM_DOCS_MINUTE_CHOICES = [30, 45, 60, 70, 90, 120, 150, 180];
function loadExamPractice() {
  try {
    const v = JSON.parse(localStorage.getItem(EXAM_PRACTICE_KEY) || 'null');
    if (v && v.examType && v.year && v.subject && v.startedAt) return v;
  } catch (e) {}
  return null;
}
function saveExamPractice(p) {
  try {
    if (p) localStorage.setItem(EXAM_PRACTICE_KEY, JSON.stringify(p));
    else localStorage.removeItem(EXAM_PRACTICE_KEY);
  } catch (e) {}
}
function examDocsPracticeMatches(p, examType, year, subject) {
  return !!(p && p.examType === examType && p.year === year && p.subject === subject);
}
// 残り時間（ミリ秒）を「1:05:09」「-0:03:00」（超過）の形にする
function examDocsFormatRemaining(ms) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (neg ? '-' : '') + h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

// --- 表示の好み（この端末だけ）：並べ方・色分け・絞り込み ---
function loadExamDocsView() {
  const d = { layout: 'tabs', hl: true, filter: 'all' };
  try {
    const v = JSON.parse(localStorage.getItem(EXAM_DOCS_VIEW_KEY) || '{}');
    if (v && (v.layout === 'tabs' || v.layout === 'side')) d.layout = v.layout;
    if (v && typeof v.hl === 'boolean') d.hl = v.hl;
    if (v && (v.filter === 'all' || v.filter === 'bad' || v.filter === 'good')) d.filter = v.filter;
  } catch (e) {}
  return d;
}
function saveExamDocsView(v) {
  try { localStorage.setItem(EXAM_DOCS_VIEW_KEY, JSON.stringify(v)); } catch (e) {}
}

// --- データの取得と端末への控え（IndexedDB） ---
let examDocsDbPromise = null;
function examDocsOpenDb() {
  if (examDocsDbPromise) return examDocsDbPromise;
  examDocsDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDBが使えません')); return; }
    let req;
    try { req = indexedDB.open(EXAM_DOCS_DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('years')) db.createObjectStore('years', { keyPath: 'file' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('保存領域を開けませんでした'));
  });
  examDocsDbPromise.catch(() => { examDocsDbPromise = null; });
  return examDocsDbPromise;
}
function examDocsIdb(store, mode, fn) {
  return examDocsOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('保存に失敗しました'));
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました（空き容量が足りない可能性があります）'));
  }));
}
let examDocsIndexPromise = null;
let examDocsIndexCache = null;
function examDocsGetIndex() {
  if (examDocsIndexPromise) return examDocsIndexPromise;
  examDocsIndexPromise = fetch(EXAM_DOCS_BASE + 'index.json', { cache: 'no-cache' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(index => {
      examDocsIdb('meta', 'readwrite', st => st.put({ id: 'index', data: index })).catch(() => {});
      return index;
    })
    .catch(err => examDocsIdb('meta', 'readonly', st => st.get('index')).then(rec => {
      if (rec && rec.data) return rec.data;
      throw err;
    }, () => { throw err; }))
    .then(index => { examDocsIndexCache = index; return index; });
  // 失敗したら次に開いたときにもう一度試す
  examDocsIndexPromise.catch(() => { examDocsIndexPromise = null; });
  return examDocsIndexPromise;
}
function examDocsIndexEntry(index, examType, year) {
  const label = examDocsCode(examType) === 'yobi' ? '予備試験' : '司法試験';
  return ((index && index.years) || []).find(y => y.exam === label && y.year === year) || null;
}
const examDocsYearMemo = {};
async function examDocsGetYear(examType, year) {
  const index = await examDocsGetIndex();
  const entry = examDocsIndexEntry(index, examType, year);
  if (!entry) return null;
  const memo = examDocsYearMemo[entry.file];
  if (memo && memo.rev === entry.rev) return memo.data;
  let saved = null;
  try { saved = await examDocsIdb('years', 'readonly', st => st.get(entry.file)); } catch (e) {}
  if (saved && saved.rev === entry.rev && saved.data) {
    examDocsYearMemo[entry.file] = saved;
    return saved.data;
  }
  try {
    const res = await fetch(EXAM_DOCS_BASE + entry.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const rec = { file: entry.file, rev: entry.rev, data: data, savedAt: Date.now() };
    examDocsYearMemo[entry.file] = rec;
    examDocsIdb('years', 'readwrite', st => st.put(rec)).then(() => { examDocsSavedFilesCache = null; }).catch(() => {});
    return data;
  } catch (err) {
    // オフラインなどで取り直せないときは、古い控えでも見せる
    if (saved && saved.data) { examDocsYearMemo[entry.file] = saved; return saved.data; }
    throw err;
  }
}
let examDocsSavedFilesCache = null;
function examDocsSavedFiles() {
  if (examDocsSavedFilesCache) return Promise.resolve(examDocsSavedFilesCache);
  return examDocsIdb('years', 'readonly', st => st.getAll()).then(list => {
    const map = {};
    (list || []).forEach(r => { if (r && r.file) map[r.file] = r.rev; });
    examDocsSavedFilesCache = map;
    return map;
  }).catch(() => ({}));
}

// --- 画面 ---
const examDocsState = {
  open: false,
  examType: '新司法試験',
  year: null,         // null のときは年度の一覧（進み具合）
  subject: '憲法',
  kind: 'mondai',
  message: '',        // 解答を記録したときなどの一言
  saveAllRunning: false,
  saveAllText: '',
  quitArmed: false
};
let examDocsTimerId = null;
let examDocsRenderSeq = 0;

function examDocsEls() {
  return {
    page: document.getElementById('pastExamPage'),
    view: document.getElementById('examDocView'),
    sheet: document.getElementById('examDocSheet')
  };
}
function examDocsExamTypeDefault() {
  return typeof pastMatrixCurrentType !== 'undefined' && pastMatrixCurrentType ? pastMatrixCurrentType : '新司法試験';
}
function openExamDocs(opts) {
  const o = opts || {};
  examDocsState.examType = o.examType || examDocsState.examType || examDocsExamTypeDefault();
  examDocsState.year = o.year == null ? null : Number(o.year);
  if (o.subject) examDocsState.subject = o.subject;
  if (o.kind) examDocsState.kind = o.kind;
  examDocsState.message = '';
  examDocsState.quitArmed = false;
  examDocsState.open = true;
  closeExamDocSheet();
  const tabBtn = document.querySelector('.tabBtn[data-page="pastExamPage"]');
  if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
  const els = examDocsEls();
  if (els.page) els.page.classList.add('examDocsOpen');
  renderExamDocs();
  if (els.view && els.view.scrollIntoView) {
    try { els.view.scrollIntoView({ block: 'start' }); } catch (e) {}
  }
}
function closeExamDocs() {
  examDocsState.open = false;
  const els = examDocsEls();
  if (els.page) els.page.classList.remove('examDocsOpen');
  if (els.view) els.view.innerHTML = '';
  examDocsUpdateTimer();
}
function renderExamDocsIfOpen() {
  if (examDocsState.open) renderExamDocs();
}

function examDocsExamTabsHtml(current, act) {
  return '<span class="examDocExamTabs">' + Object.keys(EXAM_DOCS_EXAM_CODE).map(t =>
    '<button type="button" class="pastMatrixTabBtn' + (t === current ? ' active' : '') + '" data-act="' + act + '" data-exam="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>'
  ).join('') + '</span>';
}
function examDocsSourceHtml(doc) {
  return '<div class="examDocSource">出典：<a href="' + escapeHtml(doc.page) + '" target="_blank" rel="noopener">法務省ウェブサイト（' + escapeHtml(doc.title) + '）</a>を加工して作成'
    + '　<a href="' + escapeHtml(doc.pdf) + '" target="_blank" rel="noopener">📎 元のPDF</a>'
    + '<div class="examDocSourceNote">PDFから文を抜き出して段落につなげ直しています。表・図・改行の位置は元のPDFと違うことがあります。</div></div>';
}
function examDocsPracticeBarHtml(st, docAvailable) {
  const p = loadExamPractice();
  if (p && !examDocsPracticeMatches(p, st.examType, st.year, st.subject)) {
    return '<div class="examDocPractice examDocPracticeOther">✍ 解答中：' + escapeHtml(p.examType + ' ' + examDocsYearLabel(p.year) + ' ' + p.subject)
      + '　<span class="examDocTimer" data-timer="1">' + examDocsFormatRemaining(p.startedAt + p.minutes * 60000 - Date.now()) + '</span>'
      + '　<button type="button" class="stackBtn" data-act="practiceGo">▶ 戻る</button></div>';
  }
  if (p) {
    const remain = p.startedAt + p.minutes * 60000 - Date.now();
    return '<div class="examDocPractice examDocPracticeRun' + (remain < 0 ? ' examDocPracticeOver' : '') + '">'
      + '<span class="examDocPracticeLabel">✍ 解答中</span>'
      + '<span class="examDocTimer" data-timer="1">' + examDocsFormatRemaining(remain) + '</span>'
      + '<span class="examDocPracticeOf">／ ' + p.minutes + '分' + (remain < 0 ? '（時間です）' : '') + '</span>'
      + '<button type="button" class="stackBtn examDocDoneBtn" data-act="practiceDone">✅ 書き終えた（解答ログに記録）</button>'
      + '<button type="button" class="stackBtn" data-act="practiceQuit">' + (st.quitArmed ? 'もう一度押すと中止（記録しない）' : '中止') + '</button>'
      + '</div>';
  }
  if (!docAvailable) return '';
  const def = examDocsDefaultMinutes(st.examType, st.subject);
  const choices = EXAM_DOCS_MINUTE_CHOICES.includes(def) ? EXAM_DOCS_MINUTE_CHOICES : EXAM_DOCS_MINUTE_CHOICES.concat([def]).sort((a, b) => a - b);
  return '<div class="examDocPractice">'
    + '<button type="button" class="stackBtn examDocStartBtn" data-act="practiceStart">✍ 時間を計って解く</button>'
    + '<select id="examDocMinutes" aria-label="制限時間">' + choices.map(m => '<option value="' + m + '"' + (m === def ? ' selected' : '') + '>' + m + '分</option>').join('') + '</select>'
    + '<span class="examDocPracticeHint">解き終えるまで出題趣旨・採点実感は閉じておきます</span>'
    + '</div>';
}
function examDocsPanelHtml(st, data, kind, view, readMap, locked) {
  const subjData = data && data.subjects ? data.subjects[st.subject] : null;
  const doc = subjData ? subjData[kind.id] : null;
  let html = '<section class="examDocPanel" data-kind="' + kind.id + '">';
  const read = examDocsIsRead(readMap, st.examType, st.year, st.subject, kind.id);
  html += '<div class="examDocPanelHead"><span class="examDocPanelTitle">' + kind.icon + ' ' + kind.label + '</span>';
  if (doc && !locked) {
    html += '<button type="button" class="examReadBtn' + (read ? ' on' : '') + '" data-act="toggleRead" data-kind="' + kind.id + '">' + (read ? '✔ 読んだ' : '○ 読んだ印をつける') + '</button>';
  }
  html += '</div>';
  if (!doc) {
    let why = 'この資料はまだ入っていません（法務省で公表されたら追加します）。';
    if (kind.id === 'jikkan' && st.examType === '予備試験') why = '予備試験は、採点実感が公表されていません。';
    html += '<div class="examDocEmpty">' + why + '</div></section>';
    return html;
  }
  if (locked) {
    html += '<div class="examDocLocked">🔒 解き終えるまで閉じています。<br>「✅ 書き終えた」を押すと開きます。</div></section>';
    return html;
  }
  if (kind.id === 'jikkan') {
    const c = examDocsCountMarks(doc.paras);
    html += '<div class="examHlBar">'
      + '<label class="examHlToggle"><input type="checkbox" data-act="toggleHl"' + (view.hl ? ' checked' : '') + '> 色分け</label>'
      + '<span class="examHlCount"><span class="examHlGood">良い例 ' + c.good + '</span> <span class="examHlBad">注意点 ' + c.bad + '</span></span>'
      + '<span class="examHlFilters">'
      + [['all', 'すべて'], ['bad', '注意点だけ'], ['good', '良い例だけ']].map(f =>
        '<button type="button" class="examHlFilterBtn' + (view.filter === f[0] ? ' active' : '') + '" data-act="hlFilter" data-filter="' + f[0] + '">' + f[1] + '</button>').join('')
      + '</span>'
      + '<span class="examHlNote">言い回しで機械的に判定しています</span>'
      + '</div>';
  }
  const opts = kind.id === 'jikkan' ? { hl: view.hl, filter: view.filter } : { hl: false, filter: 'all' };
  html += '<div class="examDocBody">' + examDocsBodyHtml(doc.paras, opts) + '</div>';
  html += '<div class="examDocPanelFoot">'
    + '<button type="button" class="examReadBtn' + (read ? ' on' : '') + '" data-act="toggleRead" data-kind="' + kind.id + '">' + (read ? '✔ 読んだ' : '○ 読んだ印をつける') + '</button>'
    + examDocsSourceHtml(doc) + '</div>';
  html += '</section>';
  return html;
}
function examDocsRelatedHtml(st) {
  const list = typeof entries !== 'undefined' ? examDocsRelatedEntries(entries, st.examType, st.year, st.subject) : [];
  let html = '<div class="examDocRelated"><div class="examDocRelatedTitle">📚 この年度・科目の論証（' + list.length + '件）</div>';
  if (list.length === 0) {
    html += '<div class="examDocRelatedNote">論証の「出題年」に「R' + st.year + '」が入っている' + escapeHtml(st.subject) + 'の論証が、ここに出ます。</div>';
  } else {
    html += '<div class="examDocRelatedList">' + list.map(e =>
      '<button type="button" class="examDocRelatedItem" data-act="openEntry" data-title="' + escapeHtml(e.title) + '">' + escapeHtml(e.title) + '</button>').join('') + '</div>';
  }
  return html + '</div>';
}
function examDocsSelectHtml(id, act, options, value) {
  return '<select id="' + id + '" data-act="' + act + '">' + options.map(o =>
    '<option value="' + escapeHtml(o.value) + '"' + (String(o.value) === String(value) ? ' selected' : '') + (o.disabled ? ' disabled' : '') + '>' + escapeHtml(o.label) + '</option>').join('') + '</select>';
}
function examDocsWide() {
  return typeof window !== 'undefined' && window.innerWidth >= 900;
}

async function renderExamDocs() {
  const els = examDocsEls();
  if (!els.view || !examDocsState.open) return;
  const seq = ++examDocsRenderSeq;
  const st = examDocsState;
  const prevScroll = els.view.dataset.renderedFor === examDocsRenderKey() ? examDocsPanelScrolls(els.view) : null;
  if (!els.view.innerHTML) els.view.innerHTML = '<div class="examDocLoading">読み込み中…</div>';
  let index;
  try {
    index = await examDocsGetIndex();
  } catch (err) {
    if (seq !== examDocsRenderSeq) return;
    els.view.innerHTML = examDocsHeaderHtml(st, true)
      + '<div class="examDocError">資料の一覧を読み込めませんでした。' + (typeof navigator !== 'undefined' && !navigator.onLine ? 'オフラインのようです。' : '')
      + 'オンラインになってからもう一度開いてください。（' + escapeHtml(err.message) + '）</div>';
    return;
  }
  if (seq !== examDocsRenderSeq) return;
  if (st.year == null) {
    const saved = await examDocsSavedFiles();
    if (seq !== examDocsRenderSeq) return;
    els.view.innerHTML = examDocsHomeHtml(st, index, saved);
    els.view.dataset.renderedFor = '';
    examDocsUpdateTimer();
    return;
  }
  let data = null;
  let loadErr = null;
  try {
    data = await examDocsGetYear(st.examType, st.year);
  } catch (err) { loadErr = err; }
  if (seq !== examDocsRenderSeq) return;
  const readMap = loadExamRead();
  const view = loadExamDocsView();
  const practice = loadExamPractice();
  const locked = examDocsPracticeMatches(practice, st.examType, st.year, st.subject);
  const side = view.layout === 'side' && examDocsWide();
  let html = examDocsHeaderHtml(st, false);
  if (loadErr) {
    html += '<div class="examDocError">この年度の資料を読み込めませんでした。' + (typeof navigator !== 'undefined' && !navigator.onLine ? 'オフラインのようです（一度開いた年度はオフラインでも読めます）。' : '')
      + '（' + escapeHtml(loadErr.message) + '）</div>';
    els.view.innerHTML = html;
    return;
  }
  if (!data) {
    html += '<div class="examDocEmpty">' + escapeHtml(st.examType + ' ' + examDocsYearLabel(st.year)) + 'の資料は、まだ入っていません。</div>';
    els.view.innerHTML = html;
    return;
  }
  const subjData = data.subjects && data.subjects[st.subject];
  html += examDocsPracticeBarHtml(st, !!(subjData && subjData.mondai));
  if (st.message) html += '<div class="examDocMessage">' + escapeHtml(st.message) + '</div>';
  // タブ（狭い画面・タブ表示のとき）
  html += '<div class="examDocKindTabs">';
  if (!side) {
    html += EXAM_DOCS_KINDS.map(k => {
      const has = !!(subjData && subjData[k.id]);
      const read = examDocsIsRead(readMap, st.examType, st.year, st.subject, k.id);
      const lock = locked && k.id !== 'mondai';
      return '<button type="button" class="examDocKindTab' + (k.id === st.kind ? ' active' : '') + (has ? '' : ' missing') + '" data-act="kind" data-kind="' + k.id + '">'
        + k.icon + ' ' + k.label + (lock ? ' 🔒' : read ? ' ✔' : '') + '</button>';
    }).join('');
  }
  if (examDocsWide()) {
    html += '<button type="button" class="examDocLayoutBtn" data-act="layout">' + (side ? '▤ タブで切り替える' : '▥ 3つ並べて読む') + '</button>';
  }
  html += '</div>';
  if (side) {
    html += '<div class="examDocSide">' + EXAM_DOCS_KINDS.map(k => examDocsPanelHtml(st, data, k, view, readMap, locked && k.id !== 'mondai')).join('') + '</div>';
  } else {
    const k = examDocsKind(st.kind);
    html += examDocsPanelHtml(st, data, k, view, readMap, locked && k.id !== 'mondai');
  }
  html += examDocsRelatedHtml(st);
  els.view.innerHTML = html;
  els.view.dataset.renderedFor = examDocsRenderKey();
  if (prevScroll) examDocsRestoreScrolls(els.view, prevScroll);
  examDocsUpdateTimer();
}
function examDocsRenderKey() {
  const st = examDocsState;
  return [st.examType, st.year, st.subject, st.kind, loadExamDocsView().layout].join('|');
}
// 3列表示では各列が自分でスクロールするので、読んだ印などで描き直しても位置を保つ
function examDocsPanelScrolls(view) {
  const out = {};
  view.querySelectorAll('.examDocSide .examDocPanel').forEach(p => { out[p.dataset.kind] = p.scrollTop; });
  return out;
}
function examDocsRestoreScrolls(view, map) {
  view.querySelectorAll('.examDocSide .examDocPanel').forEach(p => {
    if (map[p.dataset.kind] != null) p.scrollTop = map[p.dataset.kind];
  });
}
function examDocsHeaderHtml(st, home) {
  let html = '<div class="examDocHeader">'
    + '<button type="button" class="stackBtn" data-act="' + (home || st.year == null ? 'close' : 'home') + '">← ' + (home || st.year == null ? '過去問ログに戻る' : '年度の一覧') + '</button>';
  if (st.year == null || home) {
    html += '<span class="examDocHeaderTitle">📄 問題・出題趣旨・採点実感</span>';
    return html + '</div>';
  }
  const exams = Object.keys(EXAM_DOCS_EXAM_CODE).map(t => ({ value: t, label: t }));
  const years = [];
  for (let y = examDocsMaxYear(); y >= EXAM_DOCS_REIWA_MIN; y--) years.push({ value: y, label: examDocsYearLabel(y) });
  const subjects = examDocsSubjects().map(s => ({ value: s, label: s, disabled: !examDocsSubjectApplies(st.examType, s, st.year) }));
  html += examDocsSelectHtml('examDocExamSel', 'selExam', exams, st.examType)
    + examDocsSelectHtml('examDocYearSel', 'selYear', years, st.year)
    + examDocsSelectHtml('examDocSubjSel', 'selSubj', subjects, st.subject);
  return html + '</div>';
}
function examDocsHomeHtml(st, index, saved) {
  const readMap = loadExamRead();
  let html = examDocsHeaderHtml(st, true);
  html += '<div class="examDocHomeBar">' + examDocsExamTabsHtml(st.examType, 'homeExam') + '</div>';
  const code = examDocsCode(st.examType);
  const list = ((index && index.years) || []).filter(y => (code === 'yobi' ? y.exam === '予備試験' : y.exam === '司法試験'));
  const totalBytes = ((index && index.years) || []).reduce((a, y) => a + (y.bytes || 0), 0);
  const savedCount = ((index && index.years) || []).filter(y => saved[y.file] === y.rev).length;
  const allCount = ((index && index.years) || []).length;
  html += '<div class="examDocHomeNote">令和の論文式試験（' + (code === 'yobi' ? '予備試験は採点実感が公表されていないため、問題と出題趣旨' : '問題・出題趣旨・採点実感') + '）を読めます。科目の点を押すとその資料が開きます。'
    + '<br>一度開いた年度は、この端末に控えが残り、オフラインでも読めます。</div>';
  html += '<div class="examDocSaveAll"><button type="button" class="stackBtn" data-act="saveAll"' + (st.saveAllRunning ? ' disabled' : '') + '>📥 全年度をこの端末に保存（約' + (Math.round(totalBytes / 100000) / 10) + 'MB）</button>'
    + '<span class="examDocSaveAllState">' + escapeHtml(st.saveAllText || ('保存済み ' + savedCount + '／' + allCount + '年度')) + '</span></div>';
  html += '<div class="examDocYears">';
  list.forEach(y => {
    const prog = examDocsYearProgress(readMap, st.examType, y.year, y);
    const pct = prog.total ? Math.round(prog.done * 100 / prog.total) : 0;
    html += '<div class="examDocYearCard">'
      + '<div class="examDocYearHead"><span class="examDocYearName">' + examDocsYearLabel(y.year) + '</span>'
      + '<span class="examDocYearCount">読んだ ' + prog.done + '／' + prog.total + (prog.total && prog.done === prog.total ? ' ✔' : '') + '</span>'
      + (saved[y.file] === y.rev ? '<span class="examDocSavedMark" title="この端末に保存済み（オフラインで読めます）">📥</span>' : '')
      + '</div>'
      + '<div class="examDocProg"><i style="width:' + pct + '%"></i></div>'
      + '<div class="examDocYearSubjects">';
    examDocsSubjects().forEach(subj => {
      if (!examDocsSubjectApplies(st.examType, subj, y.year)) return;
      const kinds = (y.subjects && y.subjects[subj]) || [];
      html += '<div class="examDocSubjRow"><button type="button" class="examDocSubjName" data-act="openDoc" data-year="' + y.year + '" data-subj="' + escapeHtml(subj) + '" data-kind="' + (kinds[0] || 'mondai') + '">' + escapeHtml(subj) + '</button>';
      EXAM_DOCS_KINDS.forEach(k => {
        if (k.id === 'jikkan' && code === 'yobi') return;
        const has = kinds.includes(k.id);
        const read = has && examDocsIsRead(readMap, st.examType, y.year, subj, k.id);
        html += '<button type="button" class="examDot examDot-' + k.id + (read ? ' read' : '') + (has ? '' : ' none') + '" data-act="openDoc" data-year="' + y.year + '" data-subj="' + escapeHtml(subj) + '" data-kind="' + k.id + '"'
          + ' title="' + escapeHtml(subj + ' ' + k.label + (has ? (read ? '（読んだ）' : '') : '（未公表）')) + '" aria-label="' + escapeHtml(subj + ' ' + k.label) + '"' + (has ? '' : ' disabled') + '></button>';
      });
      html += '</div>';
    });
    html += '</div></div>';
  });
  html += '</div>';
  html += '<div class="examDocLegend"><span class="examDot examDot-mondai read"></span>問題 <span class="examDot examDot-shushi read"></span>出題趣旨'
    + (code === 'yobi' ? '' : ' <span class="examDot examDot-jikkan read"></span>採点実感') + '（塗りつぶし＝読んだ、白＝まだ、点線＝未公表）</div>';
  html += '<div class="examDocSource">出典：法務省ウェブサイト（司法試験・司法試験予備試験の各年度のページ）を加工して作成</div>';
  return html;
}

// --- 下から出す小さな画面（案1：表のマスを長押し） ---
function openExamDocSheet(examType, year, subject) {
  const els = examDocsEls();
  if (!els.sheet) return;
  const isReiwa = year && year.era === 'R';
  const label = (typeof pastMatrixYearFullLabel === 'function' ? pastMatrixYearFullLabel(year) : '') + '　' + subject;
  let html = '<div class="examDocSheetBox" role="dialog" aria-label="' + escapeHtml(label) + 'の資料">'
    + '<div class="examDocSheetHead"><b>' + escapeHtml(label) + '</b><span class="examDocSheetExam">' + escapeHtml(examType) + '</span>'
    + '<button type="button" class="examDocSheetClose" data-act="sheetClose" aria-label="閉じる">✖</button></div>';
  if (!isReiwa) {
    html += '<div class="examDocSheetNote">平成の年度の資料は、まだ入っていません（今は令和だけです）。</div>';
  } else {
    html += '<div class="examDocSheetBtns" id="examDocSheetBtns"><span class="examDocSheetNote">読み込み中…</span></div>';
  }
  html += '<div class="examDocSheetNote">ふつうにタップすると、今までどおり解答を記録します。</div></div>';
  els.sheet.innerHTML = html;
  els.sheet.classList.add('show');
  if (!isReiwa) return;
  examDocsGetIndex().then(index => {
    const entry = examDocsIndexEntry(index, examType, year.num);
    const kinds = (entry && entry.subjects && entry.subjects[subject]) || [];
    const readMap = loadExamRead();
    const box = document.getElementById('examDocSheetBtns');
    if (!box) return;
    box.innerHTML = EXAM_DOCS_KINDS.filter(k => !(k.id === 'jikkan' && examType === '予備試験')).map(k => {
      const has = kinds.includes(k.id);
      const read = has && examDocsIsRead(readMap, examType, year.num, subject, k.id);
      return '<button type="button" class="examDocSheetBtn examDocSheetBtn-' + k.id + '" data-act="sheetOpen" data-exam="' + escapeHtml(examType) + '" data-year="' + year.num + '" data-subj="' + escapeHtml(subject) + '" data-kind="' + k.id + '"' + (has ? '' : ' disabled') + '>'
        + k.icon + ' ' + k.label + (has ? (read ? ' ✔' : '') : '（未公表）') + '</button>';
    }).join('')
      + (kinds.includes('mondai') ? '<button type="button" class="examDocSheetBtn examDocSheetBtn-solve" data-act="sheetSolve" data-exam="' + escapeHtml(examType) + '" data-year="' + year.num + '" data-subj="' + escapeHtml(subject) + '">✍ 時間を計って解く</button>' : '');
  }).catch(err => {
    const box = document.getElementById('examDocSheetBtns');
    if (box) box.innerHTML = '<span class="examDocSheetNote">資料の一覧を読み込めませんでした（' + escapeHtml(err.message) + '）。</span>';
  });
}
function closeExamDocSheet() {
  const els = examDocsEls();
  if (!els.sheet) return;
  els.sheet.classList.remove('show');
  els.sheet.innerHTML = '';
}

// --- 解答の開始・終了 ---
function examDocsStartPractice(minutes) {
  const st = examDocsState;
  const m = Number(minutes) || examDocsDefaultMinutes(st.examType, st.subject);
  saveExamPractice({ examType: st.examType, year: st.year, subject: st.subject, startedAt: Date.now(), minutes: m });
  st.kind = 'mondai';
  st.message = '';
  st.quitArmed = false;
}
// 書き終えた：解答ログに1件足し（表のマスを押したときと同じ：今日の日付・次の回数）、問題を読んだ印にする
function examDocsFinishPractice() {
  const p = loadExamPractice();
  if (!p) return '';
  const yearObj = { era: 'R', num: p.year };
  let msg = '';
  if (typeof upsertPastExamLogEntry === 'function' && typeof computePastMatrixRounds === 'function') {
    const round = (computePastMatrixRounds(p.examType)[p.subject + '|R' + p.year] || 0) + 1;
    const date = examDocsTodayStr();
    upsertPastExamLogEntry(p.examType, p.subject, pastMatrixYearFullLabel(yearObj), round, date);
    const usedMin = Math.max(1, Math.round((Date.now() - p.startedAt) / 60000));
    msg = '解答ログに記録しました（' + p.examType + ' ' + examDocsYearLabel(p.year) + ' ' + p.subject + '・' + round + '回目・' + usedMin + '分）。出題趣旨・採点実感が開きました。';
    if (typeof renderPastMatrixTable === 'function') renderPastMatrixTable();
    if (typeof renderPastLogs === 'function') renderPastLogs();
  }
  saveExamRead(examDocsSetRead(loadExamRead(), p.examType, p.year, p.subject, 'mondai', true));
  saveExamPractice(null);
  return msg;
}
function examDocsUpdateTimer() {
  examDocsUpdateOpenBtn();
  const need = examDocsState.open && !!loadExamPractice();
  if (need && !examDocsTimerId && typeof setInterval === 'function') {
    examDocsTimerId = setInterval(() => {
      const p = loadExamPractice();
      if (!p || !examDocsState.open) { clearInterval(examDocsTimerId); examDocsTimerId = null; return; }
      const remain = p.startedAt + p.minutes * 60000 - Date.now();
      document.querySelectorAll('#examDocView [data-timer]').forEach(el => { el.textContent = examDocsFormatRemaining(remain); });
      const bar = document.querySelector('#examDocView .examDocPracticeRun');
      if (bar && remain < 0 && !bar.classList.contains('examDocPracticeOver')) renderExamDocs();
    }, 1000);
  } else if (!need && examDocsTimerId) {
    clearInterval(examDocsTimerId);
    examDocsTimerId = null;
  }
}

async function examDocsSaveAll() {
  const st = examDocsState;
  if (st.saveAllRunning) return;
  st.saveAllRunning = true;
  try {
    const index = await examDocsGetIndex();
    const list = (index && index.years) || [];
    let done = 0, failed = 0;
    for (const y of list) {
      st.saveAllText = '保存中… ' + done + '／' + list.length;
      const s = document.querySelector('#examDocView .examDocSaveAllState');
      if (s) s.textContent = st.saveAllText;
      const examType = y.exam === '予備試験' ? '予備試験' : '新司法試験';
      try { await examDocsGetYear(examType, y.year); } catch (e) { failed++; }
      done++;
    }
    examDocsSavedFilesCache = null;
    st.saveAllText = failed ? (failed + '年度を保存できませんでした（オンラインでもう一度お試しください）') : '';
  } catch (e) {
    st.saveAllText = '保存できませんでした（' + e.message + '）';
  } finally {
    st.saveAllRunning = false;
    // 書き込みが終わってから数え直す
    setTimeout(() => { examDocsSavedFilesCache = null; renderExamDocsIfOpen(); }, 300);
  }
}

// --- 操作の受け付け ---
function examDocsHandleAction(el, evt) {
  const st = examDocsState;
  const act = el.dataset.act;
  if (act === 'close') { closeExamDocs(); return; }
  if (act === 'home') { st.year = null; st.message = ''; renderExamDocs(); return; }
  if (act === 'homeExam') { st.examType = el.dataset.exam; renderExamDocs(); return; }
  if (act === 'openDoc') {
    openExamDocs({ examType: st.examType, year: Number(el.dataset.year), subject: el.dataset.subj, kind: el.dataset.kind || 'mondai' });
    return;
  }
  if (act === 'kind') { st.kind = el.dataset.kind; st.message = ''; renderExamDocs(); return; }
  if (act === 'layout') {
    const v = loadExamDocsView();
    v.layout = v.layout === 'side' ? 'tabs' : 'side';
    saveExamDocsView(v);
    renderExamDocs();
    return;
  }
  if (act === 'toggleRead') {
    const kindId = el.dataset.kind;
    const now = examDocsIsRead(loadExamRead(), st.examType, st.year, st.subject, kindId);
    saveExamRead(examDocsSetRead(loadExamRead(), st.examType, st.year, st.subject, kindId, !now));
    renderExamDocs();
    return;
  }
  if (act === 'hlFilter') {
    const v = loadExamDocsView();
    v.filter = el.dataset.filter;
    saveExamDocsView(v);
    renderExamDocs();
    return;
  }
  if (act === 'openEntry') {
    if (typeof jumpToEntryByTitle === 'function') jumpToEntryByTitle(el.dataset.title);
    return;
  }
  if (act === 'practiceStart') {
    const sel = document.getElementById('examDocMinutes');
    examDocsStartPractice(sel ? sel.value : null);
    renderExamDocs();
    return;
  }
  if (act === 'practiceDone') {
    st.message = examDocsFinishPractice();
    st.kind = 'shushi';
    st.quitArmed = false;
    renderExamDocs();
    return;
  }
  if (act === 'practiceQuit') {
    if (!st.quitArmed) { st.quitArmed = true; renderExamDocs(); return; }
    saveExamPractice(null);
    st.quitArmed = false;
    st.message = '解答を中止しました（解答ログには記録していません）。';
    renderExamDocs();
    return;
  }
  if (act === 'practiceGo') {
    const p = loadExamPractice();
    if (p) openExamDocs({ examType: p.examType, year: p.year, subject: p.subject, kind: 'mondai' });
    return;
  }
  if (act === 'saveAll') { examDocsSaveAll(); renderExamDocs(); return; }
  if (act === 'sheetClose') { closeExamDocSheet(); return; }
  if (act === 'sheetOpen') {
    openExamDocs({ examType: el.dataset.exam, year: Number(el.dataset.year), subject: el.dataset.subj, kind: el.dataset.kind });
    return;
  }
  if (act === 'sheetSolve') {
    const p = loadExamPractice();
    openExamDocs({ examType: el.dataset.exam, year: Number(el.dataset.year), subject: el.dataset.subj, kind: 'mondai' });
    if (!p) {
      examDocsStartPractice(examDocsDefaultMinutes(el.dataset.exam, el.dataset.subj));
      renderExamDocs();
    }
  }
}
function examDocsHandleChange(el) {
  const st = examDocsState;
  const act = el.dataset.act;
  if (act === 'selExam') {
    st.examType = el.value;
    if (!examDocsSubjectApplies(st.examType, st.subject, st.year)) st.subject = '憲法';
  } else if (act === 'selYear') {
    st.year = Number(el.value);
    if (!examDocsSubjectApplies(st.examType, st.subject, st.year)) st.subject = '憲法';
  } else if (act === 'selSubj') {
    st.subject = el.value;
  } else if (act === 'toggleHl') {
    const v = loadExamDocsView();
    v.hl = !!el.checked;
    saveExamDocsView(v);
  } else {
    return;
  }
  st.message = '';
  st.quitArmed = false;
  renderExamDocs();
}

// 表の上のボタン：解答中は「✍ 解答中」にして、押すとその問題に戻れるようにする
function examDocsUpdateOpenBtn() {
  const btn = document.getElementById('examDocOpenBtn');
  if (!btn) return;
  const p = loadExamPractice();
  btn.textContent = p ? '✍ 解答中' : '📄 資料';
  if (btn.classList) btn.classList.toggle('examDocOpenBtnRun', !!p);
}
function initExamDocsFeature() {
  const els = examDocsEls();
  if (!els.view || !els.view.addEventListener) return;
  els.view.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    // 条文リンクは document の委任リスナーに任せる（ここでは止めない）
    if (e.target.closest('.lawRef')) return;
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
    examDocsHandleAction(el, e);
  });
  els.view.addEventListener('change', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (el) examDocsHandleChange(el);
  });
  if (els.sheet && els.sheet.addEventListener) {
    els.sheet.addEventListener('click', (e) => {
      if (e.target === els.sheet) { closeExamDocSheet(); return; }
      const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (el) examDocsHandleAction(el, e);
    });
  }
  // 表の上に「📄 資料」ボタン（長押しを知らなくても開けるように）
  const tabsEl = document.getElementById('pastMatrixTabs');
  if (tabsEl && tabsEl.appendChild && !document.getElementById('examDocOpenBtn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'examDocOpenBtn';
    btn.className = 'pastMatrixTabBtn examDocOpenBtn';
    btn.textContent = '📄 資料';
    btn.title = '問題・出題趣旨・採点実感を読む（表のマスを長押ししても開けます）';
    btn.addEventListener('click', () => {
      // 解答中なら、その問題に戻る（タブを移ったり開き直したりしても、時間は計り続けている）
      const p = loadExamPractice();
      if (p) openExamDocs({ examType: p.examType, year: p.year, subject: p.subject, kind: 'mondai' });
      else openExamDocs({ examType: examDocsExamTypeDefault(), year: null });
    });
    tabsEl.appendChild(btn);
  }
  // 表のマスの長押し（案1）。長押しのあとの click は、記録してしまわないよう捨てる
  const wrap = document.getElementById('pastMatrixTableWrap');
  if (wrap && wrap.addEventListener) {
    let pressTimer = null;
    let startX = 0, startY = 0;
    let suppressClick = false;
    const cellOf = (t) => (t && t.closest ? t.closest('td.pastMatrixCell:not(.pastMatrixNa)') : null);
    const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    const fire = (td) => {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 1200);
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
      openExamDocSheet(examDocsExamTypeDefault(), { era: td.dataset.yearEra, num: Number(td.dataset.yearNum) }, td.dataset.subj);
    };
    wrap.addEventListener('pointerdown', (e) => {
      const td = cellOf(e.target);
      if (!td || (e.pointerType === 'mouse' && e.button !== 0)) return;
      startX = e.clientX; startY = e.clientY;
      cancel();
      pressTimer = setTimeout(() => { pressTimer = null; fire(td); }, 550);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (pressTimer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => wrap.addEventListener(t, cancel));
    wrap.addEventListener('contextmenu', (e) => {
      const td = cellOf(e.target);
      if (!td) return;
      e.preventDefault();
      cancel();
      const sheet = examDocsEls().sheet;
      if (!(sheet && sheet.classList.contains('show'))) fire(td);
    });
    // 捕捉段階で止めるので、past-exam.js の「マスを押したら記録」より先に効く
    wrap.addEventListener('click', (e) => {
      if (suppressClick && cellOf(e.target)) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }
  // 頻出論点ランキングの年度リンク（案7の逆向き：論証 → 出題趣旨）
  const trend = document.getElementById('examTrendBody');
  if (trend && trend.addEventListener) {
    trend.addEventListener('click', (e) => {
      const link = e.target && e.target.closest ? e.target.closest('.examYearLink') : null;
      if (!link) return;
      openExamDocs({ examType: link.dataset.exam, year: Number(link.dataset.year), subject: link.dataset.subj, kind: 'shushi' });
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    let lastWide = examDocsWide();
    window.addEventListener('resize', () => {
      const w = examDocsWide();
      if (w !== lastWide) { lastWide = w; renderExamDocsIfOpen(); }
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeExamDocSheet();
    });
  }
  examDocsUpdateOpenBtn();
}
initExamDocsFeature();
/* ▲▲▲ 過去問の資料 ここまで ▲▲▲ */
