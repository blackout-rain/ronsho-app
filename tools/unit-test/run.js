#!/usr/bin/env node
// 同期以外のロジックの自動テスト（Word解析・条文参照・書籍・localStorageキーの同期登録漏れ）。
// アプリの実ファイルをそのまま Node の vm に読み込み、DOM・localStorage をスタブに
// 差し替えて検証する。実行: node tools/unit-test/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (detail != null && !cond ? ' — ' + detail : ''));
  if (!cond) failures++;
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(label, a === e, '期待値 ' + e + ' / 実際 ' + a);
}

// ---- スタブ ----
// どんなプロパティ参照・呼び出し・代入も受け流す「何でも要素」。
// アプリのスクリプトは読み込み時にDOM要素を取得してイベントを登録するため、
// テスト対象の純粋な関数を使えるところまで読み込みを通すためだけに使う
function makeAnything() {
  const target = function () {};
  const handler = {
    get(t, prop) {
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'length') return 0;
      if (prop === 'then') return undefined; // Promiseと誤認されないように
      if (prop in t && typeof prop === 'string' && t[prop] !== undefined && prop !== 'prototype') return t[prop];
      return anything;
    },
    set(t, prop, value) { t[prop] = value; return true; },
    apply() { return anything; },
    construct() { return anything; },
    has() { return true; }
  };
  const anything = new Proxy(target, handler);
  return anything;
}
function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); },
    key: i => [...m.keys()][i] || null,
    get length() { return m.size; }
  };
}
function loadApp(files) {
  const anything = makeAnything();
  const documentStub = new Proxy({}, {
    get(t, prop) {
      if (prop === 'getElementById' || prop === 'querySelector' || prop === 'createElement') return () => anything;
      if (prop === 'querySelectorAll' || prop === 'getElementsByClassName' || prop === 'getElementsByTagName') return () => [];
      return anything;
    }
  });
  const ctx = {
    console, Math, Date, JSON, Promise, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    document: documentStub, navigator: { onLine: true, userAgent: 'node' },
    location: { href: 'https://example.invalid/', search: '', hash: '', pathname: '/' },
    history: anything, alert: () => {}, confirm: () => false, prompt: () => null,
    fetch: () => Promise.reject(new Error('fetch disabled in tests')),
    requestAnimationFrame: () => 0, matchMedia: () => anything, getComputedStyle: () => anything,
    URL, Blob: function () {}, Image: function () {}, speechSynthesis: anything, SpeechSynthesisUtterance: function () {}
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // 読み込み順は index.html と同じにする
  files.forEach(f => {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch (e) {
      check(f + ' を読み込める', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
    }
  });
  return (expr) => vm.runInContext(expr, ctx);
}

// 本番と同じ読み込み順（index.html）で、テスト対象を含むファイルだけを読み込む
const app = loadApp(['js/core.js', 'js/study-table.js', 'js/book.js', 'js/lawref.js']);
const R = (runs) => runs.map(([text, color]) => ({ text: text, color: color || null, bold: false }));

console.log('\n■ Word解析：色の検証（セキュリティ）');
{
  const sanitize = app('sanitizeHexColor');
  const toHex = app('docxColorValToHex');
  eq('正しい色はそのまま', sanitize('#F92269'), '#F92269');
  eq('「#」＋16進6桁以外は捨てる', [sanitize('red'), sanitize('#12345'), sanitize('#1234567'), sanitize(null)], [null, null, null, null]);
  eq('Wordの色値を変換する', toHex('F92269'), '#F92269');
  eq('黒・自動は色なし', [toHex('000000'), toHex('auto'), toHex('')], [null, null, null]);
  const evil = '000;"><img src=x onerror=alert(1)>';
  eq('細工した色値は色なし扱い', toHex(evil), null);
  const html = app('buildBodyHtml')([[{ text: '本文', color: '#000"><img src=x onerror=alert(1)>', bold: true }]]);
  check('本文HTMLに不正な色が埋め込まれない', !/onerror|<img/.test(html), html);
  const yearHtml = app('buildYearHtml')('R5|#2fff2e;H30|red"><script>x</script>');
  check('年度HTMLに不正な色が埋め込まれない', !/<script|red"/.test(yearHtml), yearHtml);
  check('年度HTMLの正しい色は残る', yearHtml.includes('color:#2fff2e'), yearHtml);
  const textHtml = app('buildBodyHtml')([[{ text: '<b>タグ</b>', color: null, bold: false }]]);
  check('本文の文字はエスケープされる', textHtml.includes('&lt;b&gt;'), textHtml);
}

console.log('\n■ Word解析：見出し行（重要度・年度・出典）');
{
  const parse = app('parseTitleLineRuns');
  const r = parse(R([['★★ 債権譲渡の対抗要件'], ['　'], ['趣旨182,合格173', '#F92269'], ['　'], ['R5,H30', '#2fff2e']]));
  eq('タイトルから★を除く', r.title, '債権譲渡の対抗要件');
  eq('★の数が重要度になる', r.importance, 2);
  eq('出典色(#f92269)の文字を出典にする', app('buildSourceFromTokens')(r.yearTokensColored), '趣旨182,合格173');
  eq('出典は年度欄に入れない', app('buildFilteredYearStr')(r.yearTokensColored), 'R5|#2fff2e;H30|#2fff2e');
  const old = parse(R([['★ 旧試の論点'], ['　'], ['H10', '#ff9900'], [','], ['R1', '#2fff2e']]));
  eq('旧司法試験の色の年度は除く', app('buildFilteredYearStr')(old.yearTokensColored), 'R1|#2fff2e');
  const su = parse(R([['☆ ス付き'], ['　'], ['ス R2,R3']]));
  eq('「ス」で始まる区切りは年度に数えない', app('buildFilteredYearStr')(su.yearTokensColored), '');
}

console.log('\n■ Word解析：段落の並びから論証を取り出す');
{
  const entries = app('extractEntries')([
    R([['民法']]),
    R([['★★ 債権譲渡の対抗要件　'], ['趣旨182', '#f92269']]),
    R([['本文1行目']]),
    R([['本文2行目']]),
    R([['★ 詐害行為取消権　'], ['R3', '#2fff2e']]),
    R([['受益者に対する取消し。']])
  ]);
  eq('論証の件数', entries.length, 2);
  eq('タイトル', entries.map(e => e.title), ['債権譲渡の対抗要件', '詐害行為取消権']);
  eq('科目', entries.map(e => e.subject), ['民法', '民法']);
  eq('本文', entries[0].body, '本文1行目\n本文2行目');
  eq('出典', entries.map(e => e.source || ''), ['趣旨182', '']);
  eq('年度', entries.map(e => e.year), ['', 'R3|#2fff2e']);
}

console.log('\n■ 条文参照の検出');
{
  const find = (text, subject) => app('lawrefFindRefs')(text, subject).map(r => r.label);
  eq('法律名つきの条文', find('民法90条に反する'), ['民法90条']);
  eq('枝番号・項', find('民法121条の2第1項'), ['民法121条の2第1項']);
  eq('漢数字', find('刑法第百九十九条'), ['刑法199条']);
  eq('全角数字', find('憲法２１条'), ['憲法21条']);
  eq('略称（民訴）', find('民訴246条'), ['民訴246条']);
  eq('法律名なしは科目から推測', find('709条の要件', '民法'), ['民法709条']);
  eq('科目が分からなければ拾わない', find('709条の要件', ''), []);
  eq('範囲外の条番号は拾わない', find('民法5000条'), []);
  eq('漢数字の変換', [app('lawrefParseNum')('九十'), app('lawrefParseNum')('百二十一'), app('lawrefParseNum')('千')], [90, 121, 1000]);
}

console.log('\n■ 条文の表示（項・号）');
{
  const html = app('lawrefArticleBodyHtml')({
    caption: '（債権の譲渡性）', title: '第四百六十六条',
    paras: [
      { num: 1, label: '', text: '債権は、譲り渡すことができる。', items: [] },
      { num: 2, label: '２', text: '次に掲げる場合には', items: [{ label: '一', text: '甲<b>', children: [{ label: 'イ', text: '乙', children: [] }] }] }
    ]
  }, 2);
  check('指定した項を強調する', /lawRefParaHit" data-para="2"/.test(html), html);
  check('号を字下げして表示する', html.includes('lawRefItemDepth1') && html.includes('lawRefItemDepth2'), html);
  check('条文の文字はエスケープされる', html.includes('甲&lt;b&gt;'), html);
}

console.log('\n■ 条文タブの並び順');
{
  const cmp = app('lawrefStockCompare');
  const items = [['keiho', '199'], ['minpou', '121', '2'], ['constitution', '21'], ['minpou', '9'], ['minpou', '121'], ['kaishahou', '1']]
    .map(([lid, num, branch]) => ({ lid, num, branch: branch || null, subject: app('lawrefSubjectOf')(lid) }));
  eq('科目順→法律順→条番号→枝番号', items.sort(cmp).map(x => x.lid + x.num + (x.branch ? '-' + x.branch : '')),
    ['constitution21', 'minpou9', 'minpou121', 'minpou121-2', 'keiho199', 'kaishahou1']);
}

console.log('\n■ 書籍の進捗率');
{
  const pct = app('bookEffectiveProgress');
  eq('ページ数から算出', pct({ currentPage: 207, totalPages: 414 }), 50);
  eq('100%で頭打ち', pct({ currentPage: 500, totalPages: 414 }), 100);
  eq('ページ数が無ければスライダーの値', pct({ currentPage: '', totalPages: '', progress: 30 }), 30);
  eq('値が無ければ0', pct({}), 0);
}

console.log('\n■ localStorageキーの同期登録漏れ');
{
  // 他端末と揃える意味が無いため、意図的に同期対象から外しているキー（理由つき）
  const DEVICE_LOCAL_KEYS = {
    ronshoLastImportDiffV1: '直前のWord読み込みの差分表示（端末内の一時表示）',
    ronshoLawCacheV1: 'e-Govから取得した条文のキャッシュ（再取得できる）',
    ronshoPastMatrixEraV1: '過去問マトリクスの令和/平成の表示切替（見た目だけ）',
    ronshoXpMigratedFromLegacyV1: 'XPの移行処理済みフラグ（端末ごとの内部管理）',
    ronshoXpPastExamMigratedV1: 'XPの移行処理済みフラグ（端末ごとの内部管理）'
  };
  const syncCode = read('drive-sync.js');
  const backupCode = read(path.join('js', 'backup.js'));
  const jsDir = path.join(ROOT, 'js');
  const used = new Set();
  fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).forEach(f => {
    for (const m of fs.readFileSync(path.join(jsDir, f), 'utf8').matchAll(/['"`](ronsho[A-Za-z0-9_]+)['"`]/g)) used.add(m[1]);
  });
  const missing = [...used].filter(k => !syncCode.includes("'" + k + "'") && !DEVICE_LOCAL_KEYS[k]);
  eq('js/*.js で使うキーはすべて drive-sync.js に登録済み（または端末固有として明記）', missing, []);
  const staleExceptions = Object.keys(DEVICE_LOCAL_KEYS).filter(k => !used.has(k));
  eq('端末固有キーの一覧に、もう使われていないキーが残っていない', staleExceptions, []);

  // snapshot() の各項目が、applyRemoteData()・競合表示ラベル・バックアップ復元にも揃っているか
  const snapBody = (syncCode.match(/const snapshot = \(\) => \(\{([\s\S]*?)\n  \}\);/) || [])[1] || '';
  const fields = [...snapBody.matchAll(/^\s{4}([A-Za-z]+):/gm)].map(m => m[1]);
  check('snapshot() の項目を読み取れる', fields.length > 20, fields.length + '件');
  const labelsBody = (syncCode.match(/OTHER_FIELD_LABELS = \{([\s\S]*?)\};/) || [])[1] || '';
  // 論証本体・学習記録は専用の競合表示があり、dailyStatsは比較対象外、schemaVersionは形式の印
  const NO_LABEL = ['schemaVersion', 'entries', 'studyLog', 'dailyStats'];
  const NOT_APPLIED = ['schemaVersion'];
  const has = (re, code) => re.test(code);
  eq('applyRemoteData() で全項目を書き戻している',
    fields.filter(f => !NOT_APPLIED.includes(f) && !has(new RegExp('data\\.' + f + '\\b'), syncCode)), []);
  eq('OTHER_FIELD_LABELS に全項目のラベルがある',
    fields.filter(f => !NO_LABEL.includes(f) && !has(new RegExp('^\\s*' + f + ':', 'm'), labelsBody)), []);
  eq('js/backup.js の復元で全項目を扱っている',
    fields.filter(f => !NOT_APPLIED.includes(f) && !has(new RegExp('data\\.' + f + '\\b|^\\s*' + f + ": 'ronsho", 'm'), backupCode)), []);
}

console.log('\n■ オフライン動作（外部スクリプトに頼らない）');
{
  const html = read('index.html');
  const sw = read('sw.js');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  // Googleのログイン等、オンライン前提の機能のために読む外部スクリプトがあればここに理由つきで書く
  const ALLOWED_EXTERNAL = {};
  eq('外部サイトのスクリプトを読み込んでいない', srcs.filter(s => /^https?:/.test(s) && !ALLOWED_EXTERNAL[s]), []);
  const precache = new Set([...(sw.match(/PRECACHE_URLS = \[([\s\S]*?)\];/) || [])[1].matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, '')));
  eq('読み込むスクリプトはすべて Service Worker で事前キャッシュしている',
    srcs.filter(s => !/^https?:/.test(s) && !precache.has(s.replace(/^\.\//, ''))), []);
  eq('事前キャッシュするファイルがすべて実在する',
    [...precache].filter(p => p && !fs.existsSync(path.join(ROOT, p))), []);
}

console.log('');
if (failures > 0) {
  console.log('❌ ' + failures + '件のチェックが失敗しました');
  process.exit(1);
}
console.log('🎉 全チェック合格');
