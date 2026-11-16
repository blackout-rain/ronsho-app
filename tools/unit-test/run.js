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

// e-Govの法令XMLを読むための、テスト用の小さなXML読み取り器。
// アプリの解析処理が使う firstChild / nextSibling / nodeType / tagName / nodeValue / getAttribute だけを用意する
function parseXmlLite(xml) {
  const decode = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const mk = (tagName, attrs) => ({ nodeType: 1, tagName, attrs, children: [], getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; } });
  const root = { nodeType: 9, children: [] };
  const stack = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([A-Za-z0-9_]+)\s*>|<([A-Za-z0-9_]+)((?:\s+[A-Za-z0-9_:]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1]) { stack.pop(); continue; }
    if (m[2]) {
      const attrs = {};
      for (const a of (m[3] || '').matchAll(/([A-Za-z0-9_:]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const el = mk(m[2], attrs);
      top.children.push(el);
      if (!m[4]) stack.push(el);
      continue;
    }
    if (m[5] !== undefined) top.children.push({ nodeType: 3, nodeValue: decode(m[5]) });
  }
  const link = (n) => {
    (n.children || []).forEach((c, i, arr) => { c.nextSibling = arr[i + 1] || null; link(c); });
    n.firstChild = (n.children && n.children[0]) || null;
  };
  link(root);
  root.documentElement = root.children.find(c => c.nodeType === 1);
  return root;
}
const SAMPLE_LAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DataRoot>
  <Result><Code>0</Code><Message/></Result>
  <ApplData>
    <LawFullText>
      <Law Era="Meiji" Num="089">
        <LawNum>明治二十九年法律第八十九号</LawNum>
        <LawBody>
          <LawTitle>見本法</LawTitle>
          <Preamble>
            <Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>前文の文。</Sentence></ParagraphSentence></Paragraph>
          </Preamble>
          <MainProvision>
            <Part Num="1">
              <PartTitle>第一編　総則</PartTitle>
              <Chapter Num="1">
                <ChapterTitle>第一章　通則</ChapterTitle>
                <Article Num="1">
                  <ArticleCaption>（失<Ruby>踪<Rt>そう</Rt></Ruby>の宣告）</ArticleCaption>
                  <ArticleTitle>第一条</ArticleTitle>
                  <Paragraph Num="1">
                    <ParagraphNum/>
                    <ParagraphSentence>
                      <Sentence Num="1">第一文。</Sentence>
                      <Sentence Num="2">第二文&amp;。</Sentence>
                    </ParagraphSentence>
                    <Item Num="1">
                      <ItemTitle>一</ItemTitle>
                      <ItemSentence>
                        <Column Num="1"><Sentence>法人</Sentence></Column>
                        <Column Num="2"><Sentence>法律上の人をいう。</Sentence></Column>
                      </ItemSentence>
                    </Item>
                  </Paragraph>
                  <Paragraph Num="2">
                    <ParagraphNum>２</ParagraphNum>
                    <ParagraphSentence><Sentence>読み替える。</Sentence></ParagraphSentence>
                    <TableStruct><Table><TableRow><TableColumn><Sentence>上欄</Sentence></TableColumn><TableColumn><Sentence>下欄</Sentence></TableColumn></TableRow></Table></TableStruct>
                  </Paragraph>
                </Article>
                <Article Num="2_2">
                  <ArticleTitle>第二条の二</ArticleTitle>
                  <Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>枝番号の条。</Sentence></ParagraphSentence></Paragraph>
                </Article>
              </Chapter>
              <Chapter Num="2">
                <ChapterTitle>第二章　人</ChapterTitle>
                <Section Num="1">
                  <SectionTitle>第一節　権利能力</SectionTitle>
                  <Article Num="3">
                    <ArticleTitle>第三条</ArticleTitle>
                    <Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>私権の享有は、出生に始まる。</Sentence></ParagraphSentence></Paragraph>
                  </Article>
                </Section>
                <Section Num="2">
                  <SectionTitle>第二節　削除</SectionTitle>
                  <Article Num="38:84">
                    <ArticleTitle>第三十八条から第八十四条まで</ArticleTitle>
                    <Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>削除</Sentence></ParagraphSentence></Paragraph>
                  </Article>
                </Section>
              </Chapter>
            </Part>
          </MainProvision>
          <SupplProvision>
            <Article Num="1"><ArticleTitle>第一条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>附則の文。</Sentence></ParagraphSentence></Paragraph></Article>
          </SupplProvision>
        </LawBody>
      </Law>
    </LawFullText>
  </ApplData>
</DataRoot>`;

console.log('\n■ 全条ダウンロード：法令XMLの読み取り');
{
  const rec = app('lawfullParseDoc')(parseXmlLite(SAMPLE_LAW_XML), 'minpou');
  check('読み取れる', !!rec);
  eq('法律名・法令番号', [rec.lawTitle, rec.lawNum], ['見本法', '明治二十九年法律第八十九号']);
  eq('条の数（前文・附則は数えない）', rec.count, 4);
  eq('並び（見出しと条）', rec.items.map(it => it.h ? 'H' + it.h + ':' + it.t : it.k),
    ['preamble', 'H1:第一編　総則', 'H2:第一章　通則', '1', '2-2', 'H2:第二章　人', 'H3:第一節　権利能力', '3', 'H3:第二節　削除', '38:84']);
  const a1 = rec.items[3];
  eq('ルビの読みを本文に混ぜない', a1.caption, '（失踪の宣告）');
  eq('複数の文は整形用の改行・空白を入れずにつなぐ', a1.paras[0].text, '第一文。第二文&。');
  eq('号の欄は全角空白で区切る', [a1.paras[0].items[0].label, a1.paras[0].items[0].text], ['一', '法人　法律上の人をいう。']);
  eq('表を読む', a1.paras[1].tables, [[['上欄', '下欄']]]);
  eq('範囲削除の条は範囲を持つ', [rec.items[9].num, rec.items[9].to], [38, 84]);
  const bad = SAMPLE_LAW_XML.replace('<Code>0</Code>', '<Code>1</Code>');
  eq('エラー応答は読み取らない', app('lawfullParseDoc')(parseXmlLite(bad), 'minpou'), null);
  eq('条番号の属性', ['90', '121_2', '32_3_2', '618:620', 'x'].map(n => app('lawfullParseArticleNum')(n)),
    [{ k: '90', num: 90 }, { k: '121-2', num: 121 }, { k: '32-3-2', num: 32 }, { k: '618:620', num: 618, to: 620 }, null]);

  const find = app('lawfullFindIn');
  eq('条番号で探す', [find(rec, 1, null), find(rec, 2, 2), find(rec, 3, null)], [3, 4, 7]);
  eq('範囲削除の条にも当たる', [find(rec, 38, null), find(rec, 50, null), find(rec, 84, null)], [9, 9, 9]);
  eq('無い条は null', [find(rec, 2, null), find(rec, 85, null), find(rec, 3, 2)], [null, null, null]);

  const sectionOf = app('lawfullSectionOf');
  eq('条を含むいちばん細かい区切り', sectionOf(rec, 7), { start: 6, end: 8 });
  eq('前文は最初の見出しの手前まで', sectionOf(rec, 0), { start: 0, end: 1 });
  eq('編の見出しからは編の終わりまで', app('lawfullSectionRange')(rec, 1), { start: 1, end: 10 });
  eq('次の区切り', app('lawfullNextSection')(rec, { start: 2, end: 5 }), { start: 6, end: 8 });
  eq('前の区切り', app('lawfullPrevSection')(rec, { start: 6, end: 8 }), { start: 2, end: 5 });
  eq('最後の次は無い', app('lawfullNextSection')(rec, { start: 8, end: 10 }), null);
  eq('見出しの道筋', app('lawfullBreadcrumb')(rec, 6), ['第一編　総則', '第二章　人', '第一節　権利能力']);
  eq('条文内検索（空白区切りはすべて含む）', [app('lawfullSearch')(rec, '出生'), app('lawfullSearch')(rec, '法人 第一文'), app('lawfullSearch')(rec, '附則')], [[7], [3], []]);
  eq('条番号の入力', ['709', '709条', '第七百九条', '121の2', '121条の2', '１２１の２', 'あ'].map(t => app('lawfullParseJump')(t)),
    [{ num: 709, branch: null }, { num: 709, branch: null }, { num: 709, branch: null }, { num: 121, branch: 2 }, { num: 121, branch: 2 }, { num: 121, branch: 2 }, null]);
  const html = app('lawrefArticleBodyHtml')(a1, null);
  check('表を表示する', html.includes('<table class="lawRefTable"><tr><td>上欄</td><td>下欄</td></tr></table>'), html);
  check('検索語の強調はタグの中を壊さない', app('lawReadHighlight')('<div class="lawRefPara">法人</div>', ['法人', 'class']) === '<div class="lawRefPara"><mark>法人</mark></div>');
  eq('全条ダウンロードの対象（民事再生法・破産法を除く17法）', [app('LAWFULL_LIDS.length'), app('LAWFULL_LIDS.includes("hasan")'), app('LAWFULL_LIDS.includes("minsaisei")')], [17, false, false]);
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
    ronshoLawFullDB: '全条ダウンロードの保存先（IndexedDBの名前。約10MBあり、各端末で再ダウンロードできる）',
    ronshoPastMatrixEraV1: '過去問マトリクスの令和/平成の表示切替（見た目だけ）',
    ronshoSpeechVoiceV1: '読み上げの声（端末に入っている声の一覧が端末ごとに違い、他の端末では同じ声が無いことが多い）',
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

console.log('\n■ バックアップ：端末への保存のしかた');
{
  const bk = loadApp(['js/core.js', 'js/backup.js']);
  const prefers = bk('backupPrefersShareSheet');
  const share = { share: () => {}, canShare: () => true };
  const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
  eq('WindowsのChromeは共有シートを使わない（v31.0までの不具合）', prefers(Object.assign({ userAgent: WIN_CHROME, maxTouchPoints: 0 }, share)), false);
  eq('Androidも普通のダウンロード', prefers(Object.assign({ userAgent: ANDROID, maxTouchPoints: 5 }, share)), false);
  eq('Macは普通のダウンロード', prefers(Object.assign({ userAgent: MAC_UA, maxTouchPoints: 0 }, share)), false);
  eq('iPhoneは共有シート', prefers(Object.assign({ userAgent: IPHONE, maxTouchPoints: 5 }, share)), true);
  eq('iPad（Macと同じUA・タッチ対応）は共有シート', prefers(Object.assign({ userAgent: MAC_UA, maxTouchPoints: 5 }, share)), true);
  eq('共有に対応していないiPhoneは普通のダウンロード', prefers({ userAgent: IPHONE, maxTouchPoints: 5 }), false);
}

console.log('\n■ 読み上げ：声の選択・画面オフ対策');
{
  const sp = loadApp(['js/core.js', 'js/speech.js']);
  const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', maxTouchPoints: 5 };
  const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
  const MAC = { userAgent: IPAD.userAgent, maxTouchPoints: 0 };
  const WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 0 };
  const needs = sp('speechNeedsKeepAlive');
  eq('iPad（Macと同じUA＋タッチ）では一時停止→再開の延命をしない', needs(IPAD), false);
  eq('iPhoneでも延命をしない', needs(IPHONE), false);
  eq('MacのSafariは今までどおり', needs(MAC), true);
  eq('パソコンのChromeは今までどおり延命する（約15秒で止まる不具合への対策）', needs(WIN), true);

  const voices = [
    { name: 'Kyoko', lang: 'ja-JP', voiceURI: 'com.apple.voice.compact.ja-JP.Kyoko', default: false },
    { name: 'O-Ren', lang: 'ja_JP', voiceURI: 'com.apple.voice.enhanced.ja-JP.O-ren', default: true },
    { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha', default: false }
  ];
  eq('日本語の声だけを選択肢にする（ja-JP・ja_JP）', sp('speechJapaneseVoices')(voices).map(v => v.name), ['Kyoko', 'O-Ren']);
  const find = sp('findSpeechVoice');
  eq('保存した声をvoiceURIで見つける', (find(voices, 'com.apple.voice.compact.ja-JP.Kyoko') || {}).name, 'Kyoko');
  eq('名前でも見つける', (find(voices, 'O-Ren') || {}).name, 'O-Ren');
  eq('日本語以外の声は選ばない', find(voices, 'Samantha'), null);
  eq('おまかせ（空）なら声を決めない', find(voices, ''), null);

  sp('speechSynthesis').getVoices = () => voices;
  sp("saveSpeechVoiceUri('com.apple.voice.compact.ja-JP.Kyoko')");
  const u1 = {};
  sp('applySpeechVoice')(u1);
  eq('選んだ声を読み上げに当てる', [u1.voice && u1.voice.name, u1.lang], ['Kyoko', 'ja-JP']);
  sp("saveSpeechVoiceUri('com.apple.voice.removed')");
  const u2 = {};
  sp('applySpeechVoice')(u2);
  eq('選んだ声が端末から無くなっていたら標準の日本語の声で読む', [u2.voice, u2.lang], [undefined, 'ja-JP']);
  eq('無くなった声でも選択は消さない（声が戻れば使える）', sp('loadSpeechVoiceUri()'), 'com.apple.voice.removed');
  sp("saveSpeechVoiceUri('')");
  eq('おまかせに戻すと保存を消す', sp("localStorage.getItem('ronshoSpeechVoiceV1')"), null);

  // 画面を点け直したときの「止まっているか」の判定
  const stalled = sp('speechLooksStalled');
  sp('speechIsPlaying = true; speechGapTimer = null;');
  eq('読み上げ中なのに何も話していなければ止まっている', stalled({ speaking: false, pending: false, paused: false }), true);
  eq('一時停止状態のまま固まっていても止まっている', stalled({ speaking: true, pending: false, paused: true }), true);
  eq('話している最中なら止まっていない', stalled({ speaking: true, pending: false, paused: false }), false);
  eq('順番待ちがあれば止まっていない', stalled({ speaking: false, pending: true, paused: false }), false);
  sp('speechGapTimer = 5;');
  eq('タイトルと本文の間（ま）を置いている最中は止まっていない', stalled({ speaking: false, pending: false, paused: false }), false);
  sp('speechIsPlaying = false; speechGapTimer = null;');
  eq('一時停止・停止した後は読み直さない', stalled({ speaking: false, pending: false, paused: true }), false);

  // 間（ま）の待ち時間が終わったら「待っている最中」の印を消す
  sp('setTimeout = (fn) => { globalThis.__gapFn = fn; return 9; }; clearTimeout = () => {}; globalThis.__ran = 0;');
  sp('scheduleSpeechGap(() => { globalThis.__ran++; }, 700)');
  eq('間を置いている間は印が付く', sp('speechGapTimer'), 9);
  sp('globalThis.__gapFn()');
  eq('待ち終わったら印を消して次を読む', [sp('speechGapTimer'), sp('globalThis.__ran')], [null, 1]);
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

async function runAsyncChecks() {
  console.log('\n■ バックアップ：端末への保存の結果');
  const bk = loadApp(['js/core.js', 'js/backup.js']);
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  bk('File = function () {}; Blob = function () {}; URL = { createObjectURL: () => { globalThis.__downloads = (globalThis.__downloads || 0) + 1; return "blob:x"; }, revokeObjectURL: () => {} };');
  const save = bk('saveBackupFileLocally');
  const downloads = () => bk('globalThis.__downloads || 0');
  let shared = 0;
  // Windows：共有シートが使えても、普通のダウンロードで保存する
  bk('navigator.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0"; navigator.maxTouchPoints = 0;');
  bk('navigator').share = () => { shared++; return Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); };
  bk('navigator').canShare = () => true;
  eq('Windowsでは保存できる', await save('{}', 'a.json'), 'saved');
  eq('Windowsでは共有シートを呼ばない', shared, 0);
  eq('Windowsではダウンロードを始める', downloads(), 1);
  // iPhone：共有シート
  bk('navigator.userAgent = ' + JSON.stringify(IPHONE) + '; navigator.maxTouchPoints = 5;');
  bk('navigator').share = () => { shared++; return Promise.resolve(); };
  eq('iPhoneで共有できたら保存', await save('{}', 'a.json'), 'saved');
  bk('navigator').share = () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }));
  eq('iPhoneで共有シートを閉じたらキャンセル', await save('{}', 'a.json'), 'cancelled');
  bk('navigator').share = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  eq('iPhoneで共有が拒否されたら失敗（再試行ボタンを出す）', await save('{}', 'a.json'), 'failed');
  eq('iPhoneでは画面が遷移するダウンロードに切り替えない', downloads(), 1);
}

runAsyncChecks().catch(e => check('非同期のチェックを実行できる', false, e && e.stack)).then(() => {
  console.log('');
  if (failures > 0) {
    console.log('❌ ' + failures + '件のチェックが失敗しました');
    process.exit(1);
  }
  console.log('🎉 全チェック合格');
});
