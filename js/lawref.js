/* ▼▼▼ 新規追加：条文参照機能（既存の変数・関数名と一切重複しない名前空間で実装）
   論証本文中の「民法90条」「刑法199条」「90条」などの条文参照に下線を付け、
   タップするとe-Gov法令APIから条文本文を取得して表示する。
   ・検出は表示時に行うだけで、保存済みの entries / bodyHtml には一切書き込まない
   ・条文本文はe-Gov（CORS開放済み）から取得し、端末内のキャッシュ
     'ronshoLawCacheV1' に保持する（キャッシュは端末固有のため同期対象外）
   ・表示方法（ポップアップ／その場に展開）は 'ronshoLawRefViewV1' で保持し、
     同期・バックアップの対象に含める（drive-sync.js・js/backup.jsに登録） */
const LAWREF_LAWS = {
  constitution: { name: '憲法', lawId: '321CONSTITUTION', aliases: ['憲法'] },
  minpou: { name: '民法', lawNum: '明治二十九年法律第八十九号', aliases: ['民法'] },
  keiho: { name: '刑法', lawNum: '明治四十年法律第四十五号', aliases: ['刑法'] },
  shouhou: { name: '商法', lawNum: '明治三十二年法律第四十八号', aliases: ['商法'] },
  kaishahou: { name: '会社法', lawNum: '平成十七年法律第八十六号', aliases: ['会社法'] },
  minsou: { name: '民事訴訟法', lawNum: '平成八年法律第百九号', aliases: ['民事訴訟法', '民訴法', '民訴'] },
  keisou: { name: '刑事訴訟法', lawNum: '昭和二十三年法律第百三十一号', aliases: ['刑事訴訟法', '刑訴法', '刑訴'] },
  gyousohou: { name: '行政事件訴訟法', lawNum: '昭和三十七年法律第百三十九号', aliases: ['行政事件訴訟法', '行訴法'] },
  gyoufufukushinsa: { name: '行政不服審査法', lawNum: '平成二十六年法律第六十八号', aliases: ['行政不服審査法', '行審法'] },
  gyoutetsuzuki: { name: '行政手続法', lawNum: '平成五年法律第八十八号', aliases: ['行政手続法', '行手法'] },
  kokubai: { name: '国家賠償法', lawNum: '昭和二十二年法律第百二十五号', aliases: ['国家賠償法', '国賠法'] },
  gyoudaishikkou: { name: '行政代執行法', lawNum: '昭和二十三年法律第四十三号', aliases: ['行政代執行法'] },
  rouki: { name: '労働基準法', lawNum: '昭和二十二年法律第四十九号', aliases: ['労働基準法', '労基法'] },
  roukumi: { name: '労働組合法', lawNum: '昭和二十四年法律第百七十四号', aliases: ['労働組合法', '労組法'] },
  roukeiyaku: { name: '労働契約法', lawNum: '平成十九年法律第百二十八号', aliases: ['労働契約法', '労契法'] },
  minshikkou: { name: '民事執行法', lawNum: '昭和五十四年法律第四号', aliases: ['民事執行法', '民執法'] },
  minhozen: { name: '民事保全法', lawNum: '平成元年法律第九十一号', aliases: ['民事保全法', '民保法'] },
  minsaisei: { name: '民事再生法', noFull: true, lawNum: '平成十一年法律第二百二十五号', aliases: ['民事再生法', '民再法'] },
  hasan: { name: '破産法', noFull: true, lawNum: '平成十六年法律第七十五号', aliases: ['破産法'] }
};
// 法律名の指定が無い「90条」のような参照は、その論証の科目から法律を推測する
const LAWREF_SUBJECT_DEFAULT = {
  '民法': 'minpou',
  '刑法': 'keiho',
  '憲法': 'constitution',
  '商法': 'shouhou',
  '民事訴訟法': 'minsou',
  '刑事訴訟法': 'keisou',
  '行政法': 'gyousohou',
  '労働法': 'rouki',
  '実務基礎民事': 'minsou',
  '実務基礎刑事': 'keisou'
};
const LAWREF_ALIAS_TO_LID = {};
Object.keys(LAWREF_LAWS).forEach(lid => {
  LAWREF_LAWS[lid].aliases.forEach(a => { LAWREF_ALIAS_TO_LID[a] = lid; });
});
function lawrefEscapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 別名の長い順（「民事訴訟法」→「民訴」の順）に並べ、前方一致の誤検出を防ぐ
const LAWREF_ALIAS_PATTERN = Object.keys(LAWREF_ALIAS_TO_LID)
  .sort((a, b) => b.length - a.length)
  .map(lawrefEscapeRegExp).join('|');
const LAWREF_NUM_PATTERN = '[0-9０-９一二三四五六七八九十百千]+';
// 法律名＋条（「民法90条」「第九十条」「121条の2」「14条1項」など）か、
// 法律名の無い条番号（科目から推測）のどちらかにマッチする
const LAWREF_RE = new RegExp(
  '(?:(?<law>' + LAWREF_ALIAS_PATTERN + '))?第?(?<num>' + LAWREF_NUM_PATTERN + ')条'
  + '(?:の(?<branch>' + LAWREF_NUM_PATTERN + '))?'
  + '(?:第?(?<para>' + LAWREF_NUM_PATTERN + ')項)?',
  'g'
);
// 「第九十条」「1」「２３」→ 90 / 1 / 23。変換不能なら NaN
function lawrefParseNum(s) {
  const t = String(s || '').trim();
  if (/^[0-9０-９]+$/.test(t)) {
    return Number(t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  }
  const DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const UNIT = { 十: 10, 百: 100, 千: 1000 };
  let result = 0, temp = 0, seen = false;
  for (const ch of t) {
    if (DIGIT[ch] !== undefined) { temp = DIGIT[ch]; seen = true; }
    else if (UNIT[ch] !== undefined) { result += (temp === 0 ? 1 : temp) * UNIT[ch]; temp = 0; seen = true; }
    else return NaN;
  }
  if (!seen) return NaN;
  return result + temp;
}
// テキスト中の条文参照を、DOM生成前に純粋なデータとして抜き出す
// （Nodeでの単体検証ができるよう、DOM操作とは分離している）
function lawrefFindRefs(text, subject) {
  const out = [];
  LAWREF_RE.lastIndex = 0;
  let m;
  while ((m = LAWREF_RE.exec(text)) !== null) {
    const g = m.groups || {};
    const lid = (g.law && LAWREF_ALIAS_TO_LID[g.law]) || LAWREF_SUBJECT_DEFAULT[subject] || null;
    if (!lid || !LAWREF_LAWS[lid]) continue;
    const num = lawrefParseNum(g.num);
    if (!Number.isFinite(num) || num < 1 || num > 2000) continue;
    const branch = g.branch ? lawrefParseNum(g.branch) : null;
    if (g.branch && (!Number.isFinite(branch) || branch < 1 || branch > 99)) continue;
    const para = g.para ? lawrefParseNum(g.para) : null;
    if (g.para && (!Number.isFinite(para) || para < 1 || para > 30)) continue;
    const lawName = g.law || LAWREF_LAWS[lid].name;
    out.push({
      index: m.index,
      length: m[0].length,
      text: m[0],
      lid: lid,
      num: num,
      branch: branch,
      para: para,
      label: lawName + num + '条' + (branch ? 'の' + branch : '') + (para ? '第' + para + '項' : '')
    });
  }
  return out;
}
// 表示用HTML中の条文参照に下線リンク（span.lawRef）を付ける。
// 保存データは変えず、表示のたびに掛けるだけなので二重化しない
function linkifyLawRefs(html, subject) {
  if (!html || typeof document === 'undefined' || typeof NodeFilter === 'undefined') return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement && n.parentElement.closest && n.parentElement.closest('.lawRef')) continue;
    textNodes.push(n);
  }
  textNodes.forEach(n => {
    const refs = lawrefFindRefs(n.nodeValue, subject);
    if (refs.length === 0) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    refs.forEach(r => {
      if (r.index > pos) frag.appendChild(document.createTextNode(n.nodeValue.slice(pos, r.index)));
      const span = document.createElement('span');
      span.className = 'lawRef';
      span.setAttribute('data-lid', r.lid);
      span.setAttribute('data-num', String(r.num));
      if (r.branch) span.setAttribute('data-branch', String(r.branch));
      if (r.para) span.setAttribute('data-para', String(r.para));
      span.setAttribute('data-label', r.label);
      span.setAttribute('title', r.label + 'の条文を表示');
      span.textContent = r.text;
      frag.appendChild(span);
      pos = r.index + r.length;
    });
    if (pos < n.nodeValue.length) frag.appendChild(document.createTextNode(n.nodeValue.slice(pos)));
    n.parentNode.replaceChild(frag, n);
  });
  return tmp.innerHTML;
}

// --- 条文本文の取得・キャッシュ ---
// 取得済みの条文は端末内に保持し、オフラインでも確認できるようにする。
// 端末固有のキャッシュであり他端末と揃える意味が無いため、同期対象には含めない
const LAWREF_CACHE_KEY = 'ronshoLawCacheV1';
const LAWREF_CACHE_MAX = 300;
function lawrefCacheKey(lid, num, branch) {
  return lid + '|' + num + (branch ? '-' + branch : '');
}
function lawrefLoadCache() {
  try {
    const raw = localStorage.getItem(LAWREF_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}
function lawrefSaveCache(cache) {
  try {
    const keys = Object.keys(cache).sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
    while (keys.length > LAWREF_CACHE_MAX) delete cache[keys.shift()];
    localStorage.setItem(LAWREF_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.error('条文キャッシュの保存に失敗しました:', e);
  }
}
function lawrefBuildArticleUrl(lid, num, branch) {
  const law = LAWREF_LAWS[lid];
  const articleParam = num + '条' + (branch ? 'の' + branch : '');
  const base = 'https://laws.e-gov.go.jp/api/1/articles;';
  const lawPart = law.lawId
    ? 'lawId=' + encodeURIComponent(law.lawId)
    : 'lawNum=' + encodeURIComponent(law.lawNum);
  return base + lawPart + ';article=' + encodeURIComponent(articleParam);
}
// e-Govの条文XML（DOMParser用）を
// {v, caption, title, paras:[{num, label, text, items:[{label, text, children}], tables}]} に整形する。
// 項（Paragraph）の下の号（Item）・号の細分（Subitem1〜）も入れ子のまま保持する。
// 1条ずつの取得（articles API）と、法律まるごとの取得（lawdata API・全条ダウンロード）の両方で使う。
// Nodeのテストで小さなXMLの模型を渡せるよう、使うDOM機能は firstChild / nextSibling /
// nodeType / tagName / nodeValue / getAttribute だけにしている
const LAWREF_FORMAT_VERSION = 3;
function lawrefChildEls(el, pred) {
  const out = [];
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && pred(c.tagName)) out.push(c);
  }
  return out;
}
// 要素の文字を取り出す。ルビの読み（Rt）は捨て、XMLの整形用の改行・字下げは取り除き、
// 号の「一　法人　…」のような欄（Column）は全角空白で区切る
function lawrefNodeText(el) {
  let s = '';
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 || c.nodeType === 4) {
      s += String(c.nodeValue || '').replace(/[ \t\r]*\n[ \t\r\n]*/g, '');
    } else if (c.nodeType === 1 && c.tagName !== 'Rt') {
      const t = lawrefNodeText(c);
      if (c.tagName === 'Column' && s && t) s += '　';
      s += t;
    }
  }
  return s;
}
function lawrefOwnText(el, tagPred) {
  const hit = lawrefChildEls(el, tagPred)[0];
  return hit ? lawrefNodeText(hit).trim() : '';
}
// 深さ優先で最初に見つかった要素（getElementsByTagName の代わり）
function lawrefFindEl(root, tag) {
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    if (c.tagName === tag) return c;
    const hit = lawrefFindEl(c, tag);
    if (hit) return hit;
  }
  return null;
}
// 号（Item）・細分（Subitem1〜）を再帰的に読む
function lawrefParseItems(parentEl) {
  const isItem = t => t === 'Item' || /^Subitem\d+$/.test(t);
  return lawrefChildEls(parentEl, isItem).map(el => ({
    label: lawrefOwnText(el, t => /Title$/.test(t)),
    text: lawrefOwnText(el, t => /Sentence$/.test(t)),
    children: lawrefParseItems(el)
  }));
}
// 読替え表などの表（TableStruct）を [[行の各欄の文字]] の配列にする
function lawrefParseTables(parentEl) {
  return lawrefChildEls(parentEl, t => t === 'TableStruct').map(ts => {
    const table = lawrefChildEls(ts, t => t === 'Table')[0];
    if (!table) return [];
    return lawrefChildEls(table, t => t === 'TableRow').map(row =>
      lawrefChildEls(row, t => t === 'TableColumn').map(col => lawrefNodeText(col).trim()));
  }).filter(rows => rows.length > 0);
}
function lawrefParseParas(parentEl) {
  return lawrefChildEls(parentEl, t => t === 'Paragraph').map((el, i) => {
    const p = {
      num: Number(el.getAttribute('Num')) || (i + 1),
      label: lawrefOwnText(el, t => t === 'ParagraphNum'),
      text: lawrefOwnText(el, t => t === 'ParagraphSentence'),
      items: lawrefParseItems(el)
    };
    const tables = lawrefParseTables(el);
    if (tables.length > 0) p.tables = tables;
    return p;
  }).filter(p => p.text || p.items.length > 0 || p.tables);
}
function lawrefFormatArticleEl(articleEl) {
  const paras = lawrefParseParas(articleEl);
  if (paras.length === 0) return null;
  return {
    v: LAWREF_FORMAT_VERSION,
    caption: lawrefOwnText(articleEl, t => t === 'ArticleCaption'),
    title: lawrefOwnText(articleEl, t => t === 'ArticleTitle'),
    paras: paras
  };
}
function lawrefFormatArticleDoc(doc) {
  const articles = doc.getElementsByTagName('Article');
  if (articles.length === 0) return null;
  return lawrefFormatArticleEl(articles[articles.length - 1]);
}
async function lawrefGetArticle(lid, num, branch) {
  const key = lawrefCacheKey(lid, num, branch);
  const cache = lawrefLoadCache();
  // 全条ダウンロード済みの法律なら、ネットを使わずその中から出す
  // （開いた条文は「開いた条文」一覧に並ぶよう、1条キャッシュにも記録する）
  const full = await lawfullLookup(lid, num, branch).catch(() => null);
  if (full) {
    cache[key] = Object.assign({ at: Date.now() }, full.article, { v: LAWREF_FORMAT_VERSION });
    lawrefSaveCache(cache);
    return Object.assign({ cached: true, fromFull: true }, full.article, { at: full.at });
  }
  const hit = cache[key];
  if (hit && hit.v === LAWREF_FORMAT_VERSION) return Object.assign({ cached: true }, hit);
  // 号などを含まない旧形式のキャッシュは取得し直す（オフライン等で失敗したら旧形式のまま表示）
  try {
    return await lawrefFetchArticle(key, cache, lid, num, branch);
  } catch (e) {
    if (hit) return Object.assign({ cached: true }, hit);
    throw e;
  }
}
async function lawrefFetchArticle(key, cache, lid, num, branch) {
  const res = await fetch(lawrefBuildArticleUrl(lid, num, branch));
  if (!res.ok) throw new Error('条文の取得に失敗しました（HTTP ' + res.status + '）');
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const codes = doc.getElementsByTagName('Code');
  if (codes.length === 0 || (codes[0].textContent || '').trim() !== '0') {
    throw new Error('該当する条文が見つかりませんでした。');
  }
  const formatted = lawrefFormatArticleDoc(doc);
  if (!formatted) throw new Error('条文の形式を読み取れませんでした。');
  const entry = Object.assign({ at: Date.now() }, formatted);
  cache[key] = entry;
  lawrefSaveCache(cache);
  return Object.assign({ cached: false }, entry);
}
// --- 全条ダウンロード（オフライン用） ---
// 法律まるごとの条文を e-Gov の lawdata API から取得し、端末内の IndexedDB に保存する。
// localStorage（約5MB）には入りきらない大きさ（17法で合計約10MB）のため IndexedDB を使う。
// 再ダウンロードできる端末内の控えであり、他端末と揃える意味が薄いので同期・バックアップの対象外
const LAWFULL_DB_NAME = 'ronshoLawFullDB';
const LAWFULL_FORMAT_VERSION = 1;
const LAWFULL_LIDS = Object.keys(LAWREF_LAWS).filter(lid => !LAWREF_LAWS[lid].noFull);
// 編・章・節・款・目。目次と「通読」の区切りに使う
const LAWFULL_HEADING_LEVEL = { Part: 1, Chapter: 2, Section: 3, Subsection: 4, Division: 5 };
function lawfullBuildUrl(lid) {
  const law = LAWREF_LAWS[lid];
  return 'https://laws.e-gov.go.jp/api/1/lawdata/' + encodeURIComponent(law.lawId || law.lawNum);
}
// 条の Num 属性（"90"・"121_2"・"32_3_2"・範囲削除の "38:84"）を読む
function lawfullParseArticleNum(numAttr) {
  const s = String(numAttr || '');
  const m = /^(\d+)((?:_\d+)*)(?::(\d+)((?:_\d+)*))?$/.exec(s);
  if (!m) return null;
  const branches = m[2] ? m[2].slice(1).split('_').map(Number) : [];
  const out = { k: m[1] + (branches.length ? '-' + branches.join('-') : ''), num: Number(m[1]) };
  if (m[3] !== undefined) {
    out.k = s.replace(/_/g, '-');
    if (!m[2] && !m[4]) out.to = Number(m[3]);
  }
  return out;
}
// lawdata の XML 文書を {lid, v, lawTitle, lawNum, count, items} にする。
// items は本則の並び順どおりの配列で、見出しは {h:深さ, t:見出し}、条は {k, num, to?, caption, title, paras}。
// 附則（SupplProvision）は条番号が本則と重なるため含めない
function lawfullParseDoc(doc, lid) {
  const root = doc.documentElement || doc;
  const code = lawrefFindEl(root, 'Code');
  if (code && lawrefNodeText(code).trim() !== '0') return null;
  const body = lawrefFindEl(root, 'LawBody');
  const main = body && lawrefChildEls(body, t => t === 'MainProvision')[0];
  if (!main) return null;
  const items = [];
  let count = 0;
  const pre = lawrefChildEls(body, t => t === 'Preamble')[0];
  if (pre) {
    const paras = lawrefParseParas(pre);
    if (paras.length > 0) items.push({ k: 'preamble', num: 0, caption: '', title: '前文', paras: paras });
  }
  const walk = (el) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const level = LAWFULL_HEADING_LEVEL[c.tagName];
      if (level) {
        items.push({ h: level, t: lawrefOwnText(c, t => t === c.tagName + 'Title') });
        walk(c);
      } else if (c.tagName === 'Article') {
        const n = lawfullParseArticleNum(c.getAttribute('Num'));
        const art = n && lawrefFormatArticleEl(c);
        if (!art) continue;
        delete art.v;
        items.push(Object.assign(n, art));
        count++;
      }
    }
  };
  walk(main);
  if (count === 0) return null;
  const lawNumEl = lawrefFindEl(root, 'Law');
  return {
    lid: lid,
    v: LAWFULL_FORMAT_VERSION,
    lawTitle: lawrefOwnText(body, t => t === 'LawTitle') || LAWREF_LAWS[lid].name,
    lawNum: lawNumEl ? lawrefOwnText(lawNumEl, t => t === 'LawNum') : '',
    count: count,
    items: items
  };
}
// 条番号から条を探す（"709"・"121-2"、範囲削除の条にも当てる）
function lawfullFindIn(rec, num, branch) {
  if (!rec || !rec.items) return null;
  if (!rec._index) {
    const map = new Map();
    const ranges = [];
    rec.items.forEach((it, i) => {
      if (it.h) return;
      map.set(it.k, i);
      if (it.to) ranges.push(i);
    });
    Object.defineProperty(rec, '_index', { value: { map: map, ranges: ranges }, enumerable: false });
  }
  const key = num + (branch ? '-' + branch : '');
  if (rec._index.map.has(key)) return rec._index.map.get(key);
  if (branch) return null;
  const r = rec._index.ranges.find(i => num >= rec.items[i].num && num <= rec.items[i].to);
  return r === undefined ? null : r;
}
// 条の入っている区切り：その条の直前にある見出し（いちばん近いもの）から、
// 同じ深さ以上の次の見出しの手前まで
function lawfullSectionRange(rec, headIndex) {
  const items = rec.items;
  if (headIndex == null || headIndex < 0) {
    const first = items.findIndex(it => it.h);
    return { start: 0, end: first === -1 ? items.length : first };
  }
  const level = items[headIndex].h;
  let end = headIndex + 1;
  while (end < items.length && !(items[end].h && items[end].h <= level)) end++;
  return { start: headIndex, end: end };
}
function lawfullHeadingBefore(rec, index) {
  for (let i = index; i >= 0; i--) if (rec.items[i].h) return i;
  return -1;
}
// その条を含む、いちばん細かい区切り
function lawfullSectionOf(rec, index) {
  return lawfullSectionRange(rec, lawfullHeadingBefore(rec, index));
}
// 区切りの前後移動：直前・直後の条を含む、いちばん細かい区切り（無ければ null）
function lawfullPrevSection(rec, range) {
  for (let i = range.start - 1; i >= 0; i--) if (!rec.items[i].h) return lawfullSectionOf(rec, i);
  return null;
}
function lawfullNextSection(rec, range) {
  for (let i = range.end; i < rec.items.length; i++) if (!rec.items[i].h) return lawfullSectionOf(rec, i);
  return null;
}
// 区切りの見出しの道筋（「第三編　債権 ＞ 第二章　契約」）
function lawfullBreadcrumb(rec, index) {
  const out = [];
  let level = Infinity;
  for (let i = index; i >= 0; i--) {
    const it = rec.items[i];
    if (it.h && it.h < level) { out.unshift(it.t); level = it.h; }
  }
  return out;
}
function lawfullIndexOfKey(rec, k) {
  lawfullFindIn(rec, 0, null);
  const i = rec._index.map.get(k);
  return i === undefined ? null : i;
}
// 条の見出し・本文・号・表をすべてつなげた文字（条文内検索用）
function lawfullArticleText(art) {
  const parts = [art.caption || '', art.title || ''];
  const addItems = (list) => (list || []).forEach(it => { parts.push(it.label + it.text); addItems(it.children); });
  (art.paras || []).forEach(p => {
    parts.push(p.text);
    addItems(p.items);
    (p.tables || []).forEach(rows => rows.forEach(row => parts.push(row.join(' '))));
  });
  return parts.join('\n');
}
// 空白区切りの語をすべて含む条を、並び順で返す
function lawfullSearch(rec, query, limit) {
  const words = String(query || '').split(/[\s　]+/).filter(Boolean);
  if (words.length === 0 || !rec) return [];
  const out = [];
  for (let i = 0; i < rec.items.length && out.length < (limit || 100); i++) {
    const it = rec.items[i];
    if (it.h) continue;
    const text = lawfullArticleText(it);
    if (words.every(w => text.includes(w))) out.push(i);
  }
  return out;
}
// 「709」「709条」「第七百九条」「121の2」「121条の2」→ {num, branch}
function lawfullParseJump(input) {
  const t = String(input || '').replace(/\s/g, '');
  const m = /^第?([0-9０-９一二三四五六七八九十百千]+)条?(?:の([0-9０-９一二三四五六七八九十百千]+))?条?$/.exec(t);
  if (!m) return null;
  const num = lawrefParseNum(m[1]);
  const branch = m[2] ? lawrefParseNum(m[2]) : null;
  if (!Number.isFinite(num) || (m[2] && !Number.isFinite(branch))) return null;
  return { num: num, branch: branch };
}

// IndexedDB：'laws'（条文の本体）と 'meta'（一覧表示用の軽い情報）の2つの入れ物
let lawfullDbPromise = null;
function lawfullOpenDb() {
  if (lawfullDbPromise) return lawfullDbPromise;
  lawfullDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('この端末（ブラウザ）では大きなデータの保存領域（IndexedDB）が使えません。'));
      return;
    }
    let req;
    try { req = indexedDB.open(LAWFULL_DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('laws')) db.createObjectStore('laws', { keyPath: 'lid' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'lid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('保存領域（IndexedDB）を開けませんでした。'));
  });
  lawfullDbPromise.catch(() => { lawfullDbPromise = null; });
  return lawfullDbPromise;
}
function lawfullRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function lawfullTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存に失敗しました。'));
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました（端末の空き容量が足りない可能性があります）。'));
  });
}
// 一覧表示用の情報は起動後に一度だけ読み、以後はメモリ上で更新する
let lawfullMetaPromise = null;
const lawfullLawMemo = {};
function lawfullLoadMeta() {
  if (!lawfullMetaPromise) {
    lawfullMetaPromise = lawfullOpenDb().then(db => lawfullRequest(db.transaction('meta', 'readonly').objectStore('meta').getAll()))
      .then(list => {
        const map = {};
        (list || []).forEach(m => { if (m && m.lid) map[m.lid] = m; });
        return map;
      });
    lawfullMetaPromise.catch(() => { lawfullMetaPromise = null; });
  }
  return lawfullMetaPromise;
}
async function lawfullGetLaw(lid) {
  const meta = await lawfullLoadMeta();
  if (!meta[lid]) return null;
  if (!lawfullLawMemo[lid]) {
    lawfullLawMemo[lid] = lawfullOpenDb()
      .then(db => lawfullRequest(db.transaction('laws', 'readonly').objectStore('laws').get(lid)))
      .then(rec => (rec && rec.v === LAWFULL_FORMAT_VERSION ? rec : null));
    lawfullLawMemo[lid].catch(() => { delete lawfullLawMemo[lid]; });
  }
  return lawfullLawMemo[lid];
}
async function lawfullLookup(lid, num, branch) {
  const rec = await lawfullGetLaw(lid);
  const i = lawfullFindIn(rec, num, branch);
  if (i == null) return null;
  return { at: rec.at, article: rec.items[i], index: i };
}
async function lawfullSaveLaw(rec) {
  const db = await lawfullOpenDb();
  const tx = db.transaction(['laws', 'meta'], 'readwrite');
  const done = lawfullTxDone(tx);
  const meta = { lid: rec.lid, at: rec.at, count: rec.count, lawTitle: rec.lawTitle, v: rec.v };
  tx.objectStore('laws').put(rec);
  tx.objectStore('meta').put(meta);
  await done;
  const map = await lawfullLoadMeta();
  map[rec.lid] = meta;
  lawfullLawMemo[rec.lid] = Promise.resolve(rec);
}
async function lawfullDeleteLaw(lid) {
  const db = await lawfullOpenDb();
  const tx = db.transaction(['laws', 'meta'], 'readwrite');
  const done = lawfullTxDone(tx);
  tx.objectStore('laws').delete(lid);
  tx.objectStore('meta').delete(lid);
  await done;
  const map = await lawfullLoadMeta();
  delete map[lid];
  delete lawfullLawMemo[lid];
}
async function lawfullDownload(lid) {
  const res = await fetch(lawfullBuildUrl(lid));
  if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）');
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('受け取ったデータを読み取れませんでした。');
  const rec = lawfullParseDoc(doc, lid);
  if (!rec) throw new Error('条文が見つかりませんでした。');
  rec.at = Date.now();
  await lawfullSaveLaw(rec);
  // 端末の空き容量が少ないときにブラウザが勝手に消さないよう、保存の継続をお願いする（断られても動作は同じ）
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* 対応していない端末は何もしない */ }
  return rec;
}

function lawrefItemsHtml(items, depth) {
  if (!items || items.length === 0) return '';
  return items.map(it => '<div class="lawRefItem lawRefItemDepth' + Math.min(depth, 3) + '">'
    + (it.label ? '<span class="lawRefParaNum">' + escapeHtml(it.label) + '</span>' : '')
    + escapeHtml(it.text) + '</div>' + lawrefItemsHtml(it.children, depth + 1)).join('');
}
// hitPara：「民法90条第2項」のように項が指定された参照の項番号（その項を強調表示する）
function lawrefArticleBodyHtml(data, hitPara) {
  let html = '';
  if (data.caption) html += '<div class="lawRefCaption">' + escapeHtml(data.caption) + '</div>';
  if (data.title) html += '<div class="lawRefTitle">' + escapeHtml(data.title) + '</div>';
  html += data.paras.map(p => '<div class="lawRefPara' + (hitPara && p.num === hitPara ? ' lawRefParaHit' : '') + '" data-para="' + p.num + '">'
    + (p.label ? '<span class="lawRefParaNum">' + escapeHtml(p.label) + '</span>' : '')
    + escapeHtml(p.text) + '</div>' + lawrefItemsHtml(p.items, 1) + lawrefTablesHtml(p.tables)).join('');
  return html;
}
function lawrefTablesHtml(tables) {
  if (!tables || tables.length === 0) return '';
  return tables.map(rows => '<div class="lawRefTableWrap"><table class="lawRefTable">'
    + rows.map(row => '<tr>' + row.map(cell => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>').join('')
    + '</table></div>').join('');
}
function lawrefScrollToHit(container) {
  const hit = container && container.querySelector('.lawRefParaHit');
  if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
}

// --- 表示（ポップアップ／その場に展開の2方式） ---
const LAWREF_VIEW_KEY = 'ronshoLawRefViewV1';
function loadLawRefView() {
  const raw = localStorage.getItem(LAWREF_VIEW_KEY);
  return raw === 'inline' ? 'inline' : 'popup';
}
function saveLawRefView(v) {
  localStorage.setItem(LAWREF_VIEW_KEY, v === 'inline' ? 'inline' : 'popup');
  if (typeof window !== 'undefined' && typeof window.ronshoSyncNotifyChange === 'function') window.ronshoSyncNotifyChange();
}
function lawrefSourceNote(data) {
  const date = data.at ? new Date(data.at).toLocaleDateString('ja-JP') : '';
  if (data.fromFull) return '出典：e-Gov法令検索（' + date + 'にダウンロードした全条データ）';
  return '出典：e-Gov法令検索' + (date ? '（' + date + '取得' + (data.cached ? '・キャッシュ表示' : '') + '）' : '');
}
// 全条ダウンロードに対応した法律なら、オフライン用のダウンロードを案内する
function lawrefOfflineHint(lid) {
  if (!LAWREF_LAWS[lid] || LAWREF_LAWS[lid].noFull) return '';
  return '<div class="past-log-small-note">「📜 条文」タブの「📖 全条を読む」で' + escapeHtml(LAWREF_LAWS[lid].name)
    + 'をダウンロードしておくと、オフラインでも全条を見られます。</div>';
}
// 全条データから出した条文なら、前後の条文を通読画面で開くボタンを付ける
function lawrefReadMoreButtonHtml(data, lid) {
  if (!data.fromFull) return '';
  return ' <button type="button" class="lawRefReadMoreBtn stackBtn" data-lid="' + escapeHtml(lid) + '" data-k="' + escapeHtml(data.k || '') + '">📖 前後の条文を読む</button>';
}
function openLawRefPopup(ref) {
  const root = document.getElementById('lawRefModalRoot');
  if (!root) return;
  const label = ref.getAttribute('data-label') || '条文';
  const lid = ref.getAttribute('data-lid');
  const num = Number(ref.getAttribute('data-num'));
  const branch = ref.getAttribute('data-branch') ? Number(ref.getAttribute('data-branch')) : null;
  const para = ref.getAttribute('data-para') ? Number(ref.getAttribute('data-para')) : null;
  root.innerHTML = '<div class="lawModalOverlay" id="lawModalOverlay">'
    + '<div class="lawModalBox">'
    + '<div class="lawModalHeader"><span>📜 ' + escapeHtml(label) + '</span><span class="lawModalCloseBtn" id="lawModalCloseBtn">✖</span></div>'
    + '<div class="lawModalBody" id="lawModalBody"><div class="lawModalLoading">読み込み中…</div></div>'
    + '<div class="lawModalFoot" id="lawModalFoot"></div>'
    + '</div>'
    + '</div>';
  lawrefGetArticle(lid, num, branch).then(data => {
    const body = document.getElementById('lawModalBody');
    const foot = document.getElementById('lawModalFoot');
    if (!body) return;
    body.innerHTML = lawrefArticleBodyHtml(data, para);
    lawrefScrollToHit(body);
    if (foot) foot.innerHTML = escapeHtml(lawrefSourceNote(data)) + lawrefReadMoreButtonHtml(data, lid);
  }).catch(err => {
    const body = document.getElementById('lawModalBody');
    if (!body) return;
    const offline = !navigator.onLine ? 'オフラインのようです。' : '';
    body.innerHTML = '<div class="lawModalError">条文を取得できませんでした。' + escapeHtml(offline)
      + 'オンラインになってからもう一度お試しください。（' + escapeHtml(err.message) + '）'
      + lawrefOfflineHint(lid) + '</div>';
  });
}
function closeLawRefPopup() {
  const root = document.getElementById('lawRefModalRoot');
  if (root) root.innerHTML = '';
}
// その場に展開モード：押した参照の直後に条文ボックスを出し、もう一度押すと閉じる
function toggleLawRefInline(ref) {
  const lid = ref.getAttribute('data-lid');
  const num = Number(ref.getAttribute('data-num'));
  const branch = ref.getAttribute('data-branch') ? Number(ref.getAttribute('data-branch')) : null;
  const label = ref.getAttribute('data-label') || '条文';
  const para = ref.getAttribute('data-para') ? Number(ref.getAttribute('data-para')) : null;
  const key = lawrefCacheKey(lid, num, branch);
  const next = ref.nextSibling;
  if (next && next.classList && next.classList.contains('lawRefInline') && next.getAttribute('data-key') === key) {
    next.remove();
    return;
  }
  const box = document.createElement('div');
  box.className = 'lawRefInline';
  box.setAttribute('data-key', key);
  box.innerHTML = '<div class="lawRefInlineHead"><span>📜 ' + escapeHtml(label) + '</span><span class="lawRefInlineClose">✖</span></div>'
    + '<div class="lawRefInlineBody"><div class="lawModalLoading">読み込み中…</div></div>'
    + '<div class="lawRefInlineFoot"></div>';
  ref.parentNode.insertBefore(box, ref.nextSibling);
  box.querySelector('.lawRefInlineClose').addEventListener('click', (e) => {
    e.stopPropagation();
    box.remove();
  });
  lawrefGetArticle(lid, num, branch).then(data => {
    if (!box.isConnected) return;
    box.querySelector('.lawRefInlineBody').innerHTML = lawrefArticleBodyHtml(data, para);
    box.querySelector('.lawRefInlineFoot').innerHTML = escapeHtml(lawrefSourceNote(data)) + lawrefReadMoreButtonHtml(data, lid);
  }).catch(err => {
    if (!box.isConnected) return;
    const offline = !navigator.onLine ? 'オフラインのようです。' : '';
    box.querySelector('.lawRefInlineBody').innerHTML = '<div class="lawModalError">条文を取得できませんでした。' + escapeHtml(offline)
      + 'オンラインになってからもう一度お試しください。（' + escapeHtml(err.message) + '）'
      + lawrefOfflineHint(lid) + '</div>';
  });
}
// --- 条文ストック（一覧タブ）：取得済みキャッシュを辞書として眺める ---
// 条文ストックの科目分け：法律→科目の対応と、科目タブ・一覧の並び順
const LAWREF_LAW_SUBJECT = {
  constitution: '憲法', minpou: '民法', keiho: '刑法', shouhou: '商法', kaishahou: '商法',
  minsou: '民事訴訟法', minshikkou: '民事訴訟法', minhozen: '民事訴訟法', minsaisei: '民事訴訟法', hasan: '民事訴訟法',
  keisou: '刑事訴訟法',
  gyousohou: '行政法', gyoufufukushinsa: '行政法', gyoutetsuzuki: '行政法', kokubai: '行政法', gyoudaishikkou: '行政法',
  rouki: '労働法', roukumi: '労働法', roukeiyaku: '労働法'
};
const LAWREF_SUBJECT_ORDER = ['憲法', '民法', '刑法', '行政法', '商法', '民事訴訟法', '刑事訴訟法', '労働法', 'その他'];
const LAWREF_LID_ORDER = Object.keys(LAWREF_LAWS);
let lawStockSubjectFilter = 'all';
function lawrefSubjectOf(lid) {
  return LAWREF_LAW_SUBJECT[lid] || 'その他';
}
// 科目順 → 同じ科目内は法律の順 → 条番号 → 枝番号（「121条の2」は「121条」の次）
function lawrefStockCompare(a, b) {
  const sa = LAWREF_SUBJECT_ORDER.indexOf(a.subject), sb = LAWREF_SUBJECT_ORDER.indexOf(b.subject);
  if (sa !== sb) return sa - sb;
  const la = LAWREF_LID_ORDER.indexOf(a.lid), lb = LAWREF_LID_ORDER.indexOf(b.lid);
  if (la !== lb) return la - lb;
  const na = Number(a.num) || 0, nb = Number(b.num) || 0;
  if (na !== nb) return na - nb;
  return (Number(a.branch) || 0) - (Number(b.branch) || 0);
}
function lawrefStockList() {
  const cache = lawrefLoadCache();
  return Object.keys(cache).map(key => {
    const sep = key.indexOf('|');
    const lid = sep === -1 ? key : key.slice(0, sep);
    const rest = sep === -1 ? '' : key.slice(sep + 1);
    const dash = rest.indexOf('-');
    const num = dash === -1 ? rest : rest.slice(0, dash);
    const branch = dash === -1 ? null : rest.slice(dash + 1);
    const lawName = (LAWREF_LAWS[lid] && LAWREF_LAWS[lid].name) || lid;
    return Object.assign({
      key: key, lid: lid, num: num, branch: branch, subject: lawrefSubjectOf(lid),
      label: lawName + num + '条' + (branch ? 'の' + branch : '')
    }, cache[key]);
  }).sort(lawrefStockCompare);
}
function renderLawStockPage() {
  const area = document.getElementById('lawStockArea');
  if (!area) return;
  document.querySelectorAll('.lawStockModeBtn').forEach(b => b.classList.toggle('active', b.dataset.mode === lawStockMode));
  const stockPane = document.getElementById('lawStockStockPane');
  const readPane = document.getElementById('lawStockReadPane');
  if (stockPane) stockPane.style.display = lawStockMode === 'read' ? 'none' : '';
  if (readPane) readPane.style.display = lawStockMode === 'read' ? '' : 'none';
  if (lawStockMode === 'read') {
    renderLawReadPane();
    return;
  }
  const all = lawrefStockList();
  const tabsEl = document.getElementById('lawStockSubjectTabs');
  const subjects = LAWREF_SUBJECT_ORDER.filter(sub => all.some(x => x.subject === sub));
  if (lawStockSubjectFilter !== 'all' && !subjects.includes(lawStockSubjectFilter)) lawStockSubjectFilter = 'all';
  if (tabsEl) {
    tabsEl.innerHTML = all.length === 0 ? '' : ['all'].concat(subjects).map(sub => {
      const count = sub === 'all' ? all.length : all.filter(x => x.subject === sub).length;
      return '<button type="button" class="progressViewToggleBtn lawStockSubjectBtn' + (lawStockSubjectFilter === sub ? ' active' : '')
        + '" data-subject="' + escapeHtml(sub) + '">' + (sub === 'all' ? 'すべて' : escapeHtml(sub)) + '（' + count + '）</button>';
    }).join('');
  }
  const list = lawStockSubjectFilter === 'all' ? all : all.filter(x => x.subject === lawStockSubjectFilter);
  const countEl = document.getElementById('lawStockProgress');
  if (countEl) countEl.textContent = list.length > 0 ? list.length + '件' : '';
  if (all.length === 0) {
    area.innerHTML = '<div class="quizEmpty">まだ取得した条文がありません。論証本文の条文リンクを押すとここに集まります。</div>';
    return;
  }
  area.innerHTML = list.map(item => {
    const firstPara = (item.paras && item.paras[0] && item.paras[0].text) || '';
    const snippet = firstPara.length > 60 ? firstPara.slice(0, 60) + '…' : firstPara;
    return '<div class="lawStockCard" data-key="' + escapeHtml(item.key) + '">'
      + '<div class="lawStockTitle">📜 ' + escapeHtml(item.label) + '</div>'
      + (item.caption ? '<div class="lawStockCaption">' + escapeHtml(item.caption) + '</div>' : '')
      + (snippet ? '<div class="lawStockSnippet">' + escapeHtml(snippet) + '</div>' : '')
      + '<div class="bookActionsRow">'
      + '<button type="button" class="lawStockViewBtn" data-key="' + escapeHtml(item.key) + '">📖 表示</button>'
      + '<button type="button" class="lawStockDeleteBtn" data-key="' + escapeHtml(item.key) + '">🗑️ 削除</button>'
      + '</div>'
      + '</div>';
  }).join('');
}
// --- 全条を読む（通読・条番号ジャンプ・条文内検索）とダウンロード管理 ---
let lawStockMode = 'stock';
const lawReadState = { lid: null, view: 'toc', range: null, hitIndex: null, query: '', jumpKey: null };
const lawfullBusy = {};
let lawfullBulkRunning = false;
let lawReadRenderToken = 0;
function lawfullFormatDate(at) {
  return at ? new Date(at).toLocaleDateString('ja-JP') : '';
}
function lawfullDlRowsHtml(meta) {
  return LAWFULL_LIDS.map(lid => {
    const law = LAWREF_LAWS[lid];
    const m = meta[lid];
    let state, actions;
    if (lawfullBusy[lid]) {
      state = '⏳ ダウンロード中…';
      actions = '';
    } else if (m) {
      state = '✅ ' + Number(m.count).toLocaleString('ja-JP') + '条・' + escapeHtml(lawfullFormatDate(m.at)) + '取得';
      actions = '<button type="button" class="stackBtn lawFullActBtn" data-act="update" data-lid="' + lid + '">🔄 更新</button>'
        + '<button type="button" class="stackBtn lawFullActBtn" data-act="delete" data-lid="' + lid + '">🗑️</button>';
    } else {
      state = '未ダウンロード';
      actions = '<button type="button" class="stackBtn lawFullActBtn" data-act="download" data-lid="' + lid + '">📥 ダウンロード</button>';
    }
    return '<div class="lawFullRow"><div class="lawFullRowText"><span class="lawFullName">' + escapeHtml(law.name) + '</span>'
      + '<span class="lawFullState">' + state + '</span></div><div class="bookActionsRow">' + actions + '</div></div>';
  }).join('');
}
async function renderLawReadPane() {
  const token = ++lawReadRenderToken;
  const listEl = document.getElementById('lawFullDlList');
  const area = document.getElementById('lawReadArea');
  const controls = document.getElementById('lawReadControls');
  const select = document.getElementById('lawReadLawSelect');
  if (!listEl || !area) return;
  let meta = {};
  try {
    meta = await lawfullLoadMeta();
  } catch (e) {
    if (token !== lawReadRenderToken) return;
    listEl.innerHTML = '<div class="lawModalError">' + escapeHtml(e.message || String(e)) + '</div>';
    if (controls) controls.style.display = 'none';
    area.innerHTML = '';
    return;
  }
  if (token !== lawReadRenderToken) return;
  listEl.innerHTML = lawfullDlRowsHtml(meta);
  const have = LAWFULL_LIDS.filter(lid => meta[lid]);
  const box = document.getElementById('lawFullDlBox');
  if (box && box.dataset.autoOpened !== '1') {
    box.open = have.length === 0;
    box.dataset.autoOpened = '1';
  }
  if (have.length === 0) {
    if (controls) controls.style.display = 'none';
    area.innerHTML = '<div class="quizEmpty">上の「全条ダウンロード」で法律をダウンロードすると、ここで目次から全条を読んだり、条番号や言葉で探したりできます（ダウンロード後はオフラインでも使えます）。</div>';
    return;
  }
  if (controls) controls.style.display = '';
  if (!have.includes(lawReadState.lid)) {
    lawReadState.lid = have[0];
    lawReadState.view = 'toc';
  }
  if (select) {
    select.innerHTML = have.map(lid => '<option value="' + lid + '"' + (lid === lawReadState.lid ? ' selected' : '') + '>'
      + escapeHtml(LAWREF_LAWS[lid].name) + '</option>').join('');
  }
  await renderLawReadContent(token);
}
function lawReadArticleHtml(rec, i, words) {
  const art = rec.items[i];
  let body = lawrefArticleBodyHtml(art, null);
  if (words && words.length) body = lawReadHighlight(body, words);
  return '<div class="lawReadArticle' + (i === lawReadState.hitIndex ? ' lawReadArticleHit' : '') + '" data-i="' + i + '">' + body + '</div>';
}
// HTMLのタグの外側（文字の部分）だけで語を <mark> で囲む
function lawReadHighlight(html, words) {
  const re = new RegExp(words.map(w => lawrefEscapeRegExp(escapeHtml(w))).join('|'), 'g');
  return html.split(/(<[^>]*>)/).map(part => (part.startsWith('<') ? part : part.replace(re, m => '<mark>' + m + '</mark>'))).join('');
}
function lawReadNavHtml(rec, range) {
  const prev = lawfullPrevSection(rec, range), next = lawfullNextSection(rec, range);
  return '<div class="lawReadNav">'
    + '<button type="button" class="stackBtn lawReadNavBtn" data-nav="prev"' + (prev ? '' : ' disabled') + '>◀ 前</button>'
    + '<button type="button" class="stackBtn lawReadNavBtn" data-nav="toc">📑 目次</button>'
    + '<button type="button" class="stackBtn lawReadNavBtn" data-nav="next"' + (next ? '' : ' disabled') + '>次 ▶</button>'
    + '</div>';
}
async function renderLawReadContent(token) {
  const area = document.getElementById('lawReadArea');
  if (!area) return;
  let rec = null;
  try { rec = await lawfullGetLaw(lawReadState.lid); } catch (e) { rec = null; }
  if (token !== undefined && token !== lawReadRenderToken) return;
  if (!rec) {
    area.innerHTML = '<div class="lawModalError">保存した条文を読み出せませんでした。もう一度ダウンロードしてください。</div>';
    return;
  }
  if (lawReadState.jumpKey) {
    const i = lawfullIndexOfKey(rec, lawReadState.jumpKey);
    lawReadState.jumpKey = null;
    if (i != null) {
      lawReadState.view = 'section';
      lawReadState.range = lawfullSectionOf(rec, i);
      lawReadState.hitIndex = i;
    }
  }
  const hasHeadings = rec.items.some(it => it.h);
  if (lawReadState.view === 'toc' && !hasHeadings) {
    lawReadState.view = 'section';
    lawReadState.range = { start: 0, end: rec.items.length };
  }
  const note = '<div class="past-log-small-note">出典：e-Gov法令検索（' + escapeHtml(lawfullFormatDate(rec.at)) + 'にダウンロード）。'
    + '法改正の反映は「🔄 更新」で取り直してください。</div>';
  if (lawReadState.view === 'search') {
    const words = lawReadState.query.split(/[\s　]+/).filter(Boolean);
    const hits = lawfullSearch(rec, lawReadState.query, 100);
    area.innerHTML = '<div class="lawReadNav"><button type="button" class="stackBtn lawReadNavBtn" data-nav="toc">📑 目次に戻る</button></div>'
      + '<div class="quizProgress">「' + escapeHtml(lawReadState.query) + '」' + hits.length + '件' + (hits.length >= 100 ? '（先頭100件まで表示）' : '') + '</div>'
      + (hits.length === 0 ? '<div class="quizEmpty">見つかりませんでした。</div>'
        : hits.map(i => {
          const art = rec.items[i];
          const text = lawfullArticleText(art).replace(/\n/g, ' ');
          const pos = Math.max(0, text.indexOf(words[0]) - 30);
          const snippet = (pos > 0 ? '…' : '') + text.slice(pos, pos + 90) + (text.length > pos + 90 ? '…' : '');
          return '<div class="lawStockCard lawReadSearchHit" data-i="' + i + '">'
            + '<div class="lawStockTitle">📜 ' + escapeHtml(art.title) + ' ' + escapeHtml(art.caption || '') + '</div>'
            + '<div class="lawStockSnippet">' + lawReadHighlight(escapeHtml(snippet), words) + '</div></div>';
        }).join(''))
      + note;
    return;
  }
  if (lawReadState.view === 'section' && lawReadState.range) {
    const range = lawReadState.range;
    const crumbs = lawfullBreadcrumb(rec, range.start);
    let html = lawReadNavHtml(rec, range);
    if (crumbs.length) html += '<div class="lawReadCrumbs">' + crumbs.map(escapeHtml).join(' ＞ ') + '</div>';
    for (let i = range.start; i < range.end; i++) {
      const it = rec.items[i];
      if (it.h) {
        if (i === range.start && crumbs.length) continue;
        html += '<div class="lawReadHeading lawReadHeadingLevel' + it.h + '">' + escapeHtml(it.t) + '</div>';
      } else {
        html += lawReadArticleHtml(rec, i, null);
      }
    }
    html += lawReadNavHtml(rec, range) + note;
    area.innerHTML = html;
    const hit = area.querySelector('.lawReadArticleHit');
    if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'start' });
    return;
  }
  // 目次
  lawReadState.view = 'toc';
  area.innerHTML = '<div class="lawReadTitle">' + escapeHtml(rec.lawTitle) + '（' + Number(rec.count).toLocaleString('ja-JP') + '条）</div>'
    + rec.items.map((it, i) => {
      if (it.k === 'preamble') return '<div class="lawReadTocItem lawReadTocLevel1" data-i="' + i + '">前文</div>';
      if (!it.h) return '';
      return '<div class="lawReadTocItem lawReadTocLevel' + it.h + '" data-i="' + i + '">' + escapeHtml(it.t) + '</div>';
    }).join('') + note;
}
async function lawfullRunDownload(lid) {
  if (lawfullBusy[lid]) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    status.textContent = '📴 オフラインのため、' + LAWREF_LAWS[lid].name + 'をダウンロードできません。';
    return false;
  }
  lawfullBusy[lid] = true;
  renderLawReadPane();
  try {
    const rec = await lawfullDownload(lid);
    status.textContent = '📥 ' + LAWREF_LAWS[lid].name + '（' + rec.count + '条）をダウンロードしました。オフラインでも見られます。';
    return true;
  } catch (e) {
    status.textContent = '⚠️ ' + LAWREF_LAWS[lid].name + 'のダウンロードに失敗しました：' + (e && e.message ? e.message : String(e));
    return false;
  } finally {
    delete lawfullBusy[lid];
    renderLawReadPane();
  }
}
async function lawfullRunBulk(onlyMissing) {
  if (lawfullBulkRunning) return;
  let meta;
  try { meta = await lawfullLoadMeta(); } catch (e) { status.textContent = '⚠️ ' + e.message; return; }
  const targets = LAWFULL_LIDS.filter(lid => (onlyMissing ? !meta[lid] : !!meta[lid]));
  if (targets.length === 0) {
    status.textContent = onlyMissing ? '✅ すべての法律をダウンロード済みです。' : 'まだダウンロードした法律がありません。';
    return;
  }
  lawfullBulkRunning = true;
  const failed = [];
  try {
    for (const lid of targets) {
      const ok = await lawfullRunDownload(lid);
      if (!ok) failed.push(LAWREF_LAWS[lid].name);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
    }
  } finally {
    lawfullBulkRunning = false;
  }
  status.textContent = failed.length === 0
    ? '📥 ' + targets.length + '法の全条を' + (onlyMissing ? 'ダウンロード' : '更新') + 'しました。'
    : '⚠️ ' + failed.join('・') + 'を取得できませんでした（ほかは完了）。電波の良い所でもう一度お試しください。';
}
function lawReadOpenArticle(lid, k) {
  lawStockMode = 'read';
  lawReadState.lid = lid;
  lawReadState.jumpKey = k;
  const tab = document.querySelector('.tabBtn[data-page="lawStockPage"]');
  if (tab) tab.click();
  else renderLawStockPage();
}
function initLawReadFeature() {
  const page = document.getElementById('lawStockPage');
  if (!page) return;
  page.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('.lawStockModeBtn');
    if (modeBtn) {
      lawStockMode = modeBtn.dataset.mode === 'read' ? 'read' : 'stock';
      renderLawStockPage();
      return;
    }
    const act = e.target.closest('.lawFullActBtn');
    if (act) {
      const lid = act.dataset.lid;
      if (!LAWREF_LAWS[lid]) return;
      if (act.dataset.act === 'delete') {
        if (!confirm(LAWREF_LAWS[lid].name + 'の全条データをこの端末から削除しますか？（もう一度ダウンロードできます）')) return;
        lawfullDeleteLaw(lid).then(() => {
          status.textContent = '🗑️ ' + LAWREF_LAWS[lid].name + 'の全条データを削除しました。';
          renderLawReadPane();
        }).catch(err => { status.textContent = '⚠️ 削除に失敗しました：' + err.message; });
      } else {
        lawfullRunDownload(lid);
      }
      return;
    }
    if (e.target.closest('#lawFullDlAllBtn')) { lawfullRunBulk(true); return; }
    if (e.target.closest('#lawFullUpdateAllBtn')) {
      if (confirm('ダウンロード済みの法律をすべて取り直しますか？（法改正を反映します）')) lawfullRunBulk(false);
      return;
    }
    const toc = e.target.closest('.lawReadTocItem');
    if (toc) {
      const i = Number(toc.dataset.i);
      lawfullGetLaw(lawReadState.lid).then(rec => {
        if (!rec) return;
        lawReadState.view = 'section';
        lawReadState.range = rec.items[i].h ? lawfullSectionRange(rec, i) : lawfullSectionOf(rec, i);
        lawReadState.hitIndex = null;
        renderLawReadContent().then(() => { const a = document.getElementById('lawReadArea'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'start' }); });
      });
      return;
    }
    const nav = e.target.closest('.lawReadNavBtn');
    if (nav) {
      if (nav.dataset.nav === 'toc') {
        lawReadState.view = 'toc';
        renderLawReadContent();
        return;
      }
      lawfullGetLaw(lawReadState.lid).then(rec => {
        if (!rec || !lawReadState.range) return;
        const r = nav.dataset.nav === 'prev' ? lawfullPrevSection(rec, lawReadState.range) : lawfullNextSection(rec, lawReadState.range);
        if (!r) return;
        lawReadState.range = r;
        lawReadState.hitIndex = null;
        renderLawReadContent().then(() => { const a = document.getElementById('lawReadArea'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'start' }); });
      });
      return;
    }
    const sh = e.target.closest('.lawReadSearchHit');
    if (sh) {
      const i = Number(sh.dataset.i);
      lawfullGetLaw(lawReadState.lid).then(rec => {
        if (!rec) return;
        lawReadState.view = 'section';
        lawReadState.range = lawfullSectionOf(rec, i);
        lawReadState.hitIndex = i;
        renderLawReadContent();
      });
    }
  });
  const select = document.getElementById('lawReadLawSelect');
  if (select) select.addEventListener('change', () => {
    lawReadState.lid = select.value;
    lawReadState.view = 'toc';
    lawReadState.hitIndex = null;
    renderLawReadContent();
  });
  const jumpInput = document.getElementById('lawReadJumpInput');
  const doJump = () => {
    const j = lawfullParseJump(jumpInput && jumpInput.value);
    if (!j) { status.textContent = '条番号を「709」「121の2」のように入力してください。'; return; }
    lawfullGetLaw(lawReadState.lid).then(rec => {
      const i = lawfullFindIn(rec, j.num, j.branch);
      if (i == null) { status.textContent = LAWREF_LAWS[lawReadState.lid].name + 'に' + j.num + '条' + (j.branch ? 'の' + j.branch : '') + 'は見つかりませんでした。'; return; }
      lawReadState.view = 'section';
      lawReadState.range = lawfullSectionOf(rec, i);
      lawReadState.hitIndex = i;
      renderLawReadContent();
    });
  };
  const jumpBtn = document.getElementById('lawReadJumpBtn');
  if (jumpBtn) jumpBtn.addEventListener('click', doJump);
  if (jumpInput) jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });
  const searchInput = document.getElementById('lawReadSearchInput');
  const doSearch = () => {
    const q = (searchInput && searchInput.value || '').trim();
    if (!q) return;
    lawReadState.view = 'search';
    lawReadState.query = q;
    lawReadState.hitIndex = null;
    renderLawReadContent();
  };
  const searchBtn = document.getElementById('lawReadSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', doSearch);
  if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}
initLawReadFeature();
function initLawStockFeature() {
  const area = document.getElementById('lawStockArea');
  const clearBtn = document.getElementById('lawStockClearBtn');
  if (!area) return;
  const subjectTabs = document.getElementById('lawStockSubjectTabs');
  if (subjectTabs) subjectTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.lawStockSubjectBtn');
    if (!btn) return;
    lawStockSubjectFilter = btn.dataset.subject || 'all';
    renderLawStockPage();
  });
  area.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('.lawStockViewBtn');
    if (viewBtn) {
      const item = lawrefStockList().find(x => x.key === viewBtn.dataset.key);
      if (!item) return;
      const span = document.createElement('span');
      span.setAttribute('data-lid', item.lid);
      span.setAttribute('data-num', String(item.num));
      if (item.branch) span.setAttribute('data-branch', String(item.branch));
      span.setAttribute('data-label', item.label);
      openLawRefPopup(span);
      return;
    }
    const delBtn = e.target.closest('.lawStockDeleteBtn');
    if (delBtn) {
      const cache = lawrefLoadCache();
      if (!cache[delBtn.dataset.key]) return;
      delete cache[delBtn.dataset.key];
      lawrefSaveCache(cache);
      renderLawStockPage();
      status.textContent = '🗑️ 条文ストックから削除しました。';
    }
  });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (Object.keys(lawrefLoadCache()).length === 0) return;
    if (!confirm('取得済みの条文ストックをすべて削除しますか？（条文リンクから再取得できます）')) return;
    lawrefSaveCache({});
    renderLawStockPage();
    status.textContent = '🗑️ 条文ストックをすべて削除しました。';
  });
  renderLawStockPage();
}
initLawStockFeature();
// 論証本文中の条文リンク（span.lawRef）のタップを拾う委任リスナー
document.addEventListener('click', (e) => {
  const ref = e.target.closest ? e.target.closest('.lawRef') : null;
  if (ref) {
    if (loadLawRefView() === 'inline') toggleLawRefInline(ref);
    else openLawRefPopup(ref);
    return;
  }
  const more = e.target.closest ? e.target.closest('.lawRefReadMoreBtn') : null;
  if (more) {
    closeLawRefPopup();
    lawReadOpenArticle(more.dataset.lid, more.dataset.k);
    return;
  }
  if (e.target.closest && (e.target.closest('#lawModalCloseBtn') || e.target.id === 'lawModalOverlay')) {
    closeLawRefPopup();
  }
});

// --- 設定画面（表示方法の切替） ---
function renderLawRefViewSetting() {
  const radios = document.querySelectorAll('input[name="lawRefView"]');
  if (!radios || radios.length === 0) return;
  const current = loadLawRefView();
  radios.forEach(r => { r.checked = (r.value === current); });
}
function initLawRefFeature() {
  document.querySelectorAll('input[name="lawRefView"]').forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      saveLawRefView(r.value);
      status.textContent = r.value === 'inline'
        ? '📜 条文リンクの表示を「その場に展開」にしました。'
        : '📜 条文リンクの表示を「ポップアップ」にしました。';
    });
  });
  if (typeof registerSettingsPageRenderer === 'function') registerSettingsPageRenderer(renderLawRefViewSetting);
}
initLawRefFeature();
/* ▲▲▲ 新規追加：条文参照機能 ここまで ▲▲▲ */
