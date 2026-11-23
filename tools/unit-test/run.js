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
    ronshoLawCacheV1: 'e-Govから取得した条文のキャッシュ（再取得できる。開いた回数・☆は ronshoLawHistoryV1 で同期する）',
    ronshoLawHistoryDeviceV1: '開いた回数を端末ごとに数えるための、この端末の名札（端末ごとに違うことに意味がある）',
    ronshoLawHistoryMigratedV1: 'v34.0までの「開いた条文」（この端末のキャッシュ）を記録に移したかの印（端末ごとの内部管理）',
    ronshoLawFullDB: '全条ダウンロードの保存先（IndexedDBの名前。約10MBあり、各端末で再ダウンロードできる）',
    ronshoPastMatrixEraV1: '過去問マトリクスの令和/平成の表示切替（見た目だけ）',
    ronshoSpeechVoiceV1: '読み上げの声（端末に入っている声の一覧が端末ごとに違い、他の端末では同じ声が無いことが多い）',
    ronshoXpMigratedFromLegacyV1: 'XPの移行処理済みフラグ（端末ごとの内部管理）',
    ronshoXpPastExamMigratedV1: 'XPの移行処理済みフラグ（端末ごとの内部管理）',
    ronshoExamDocsDB: '過去問の資料（問題・出題趣旨・採点実感）の控えの保存先（IndexedDBの名前。約4MBあり、各端末で取り直せる）',
    ronshoExamPracticeV1: '「時間を計って解く」の解答中の状態（その端末で解いている最中だけのもの）',
    ronshoExamDocsViewV1: '過去問の資料の並べ方・色分け・マーカーの色と「文をタップで引く」の表示の好み（3列表示は画面の広さで選ぶもの。引いたマーカーそのものは ronshoExamMarksV1 で同期する）'
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

  // 読み上げ中だけ、音の種類を「再生（playback）」にする（iPadOS 17以降）
  sp('navigator.audioSession = { type: "auto" };');
  sp('document.getElementById("speechBackgroundChk").checked = false; startSpeechBackgroundAudio();');
  eq('「画面オフでも続ける」を外していれば音の種類は変えない', sp('navigator.audioSession.type'), 'auto');
  sp('document.getElementById("speechBackgroundChk").checked = true;');
  sp('startSpeechBackgroundAudio()');
  eq('読み上げを始めると音の種類を「再生」にする', sp('navigator.audioSession.type'), 'playback');
  sp('stopSpeechBackgroundAudio()');
  eq('止めたら標準（auto）に戻す（ほかのアプリの音楽を止めっぱなしにしない）', sp('navigator.audioSession.type'), 'auto');
  sp('delete navigator.audioSession;');
  sp('startSpeechBackgroundAudio(); stopSpeechBackgroundAudio();');
  check('audioSession が無い端末でもエラーにならない', true);

  // 見張り役：止まっていたら再開・読み直し（1つの論証につき2回まで）
  sp('globalThis.__speak = 0; speakCurrentEntry = () => { globalThis.__speak++; };');
  sp('globalThis.__synth = { speaking: false, pending: false, paused: false, resumed: 0, resume() { this.resumed++; } }; speechSynthesis = globalThis.__synth;');
  sp('speechIsPlaying = true; speechGapTimer = null; speechStallRetries = 0;');
  sp('speechWatchdogTick()');
  eq('止まっていたら今の論証を読み直す', sp('globalThis.__speak'), 1);
  sp('speechWatchdogTick(); speechWatchdogTick(); speechWatchdogTick();');
  eq('読み直しは1つの論証につき2回まで（冒頭を何度も繰り返さない）', sp('globalThis.__speak'), 2);
  sp('__synth.paused = true; speechWatchdogTick();');
  eq('一時停止状態で固まっていたら再開する', [sp('__synth.resumed'), sp('globalThis.__speak')], [1, 2]);
  sp('__synth.paused = false; __synth.speaking = true; speechWatchdogTick();');
  eq('話している最中は何もしない', [sp('__synth.resumed'), sp('globalThis.__speak')], [1, 2]);
  sp('__synth.speaking = false; speechGapTimer = 5; speechWatchdogTick(); speechGapTimer = null;');
  eq('間（ま）を置いている最中は何もしない', sp('globalThis.__speak'), 2);
  sp('document.getElementById = () => ({ value: "none" }); speechQueue = [{}, {}]; speechIndex = 0; advanceSpeechAfterEntry(); speechGapTimer = null;');
  eq('論証を最後まで読んだら読み直しの回数を戻す', sp('speechStallRetries'), 0);
  sp('speechIsPlaying = false; speechWatchdogTick();');
  eq('停止・一時停止の後は読み直さない', sp('globalThis.__speak'), 2);
}

console.log('\n■ 読み上げ：画面を真っ黒にするモード');
{
  const sp = loadApp(['js/core.js', 'js/speech.js']);
  const tap = sp('speechDarkTapAction');
  eq('1回目のタップでは戻らず案内を出す', tap(10000, 0), 'hint');
  eq('3秒以内にもう一度タップすると戻る', tap(12500, 10000), 'close');
  eq('3秒を過ぎてからのタップは1回目として数える（うっかり触っても戻らない）', tap(13500, 10000), 'hint');

  // 液晶のiPadは黒を映してもライトが点いたままなので、明るさを下げる方法を案内する
  const hint = sp('speechDarkHintText');
  const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', maxTouchPoints: 5 };
  const WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0', maxTouchPoints: 0 };
  const okIpad = hint(true, IPAD);
  check('iPadではコントロールセンターで明るさを下げる案内を出す', /コントロールセンター/.test(okIpad) && /明るさ/.test(okIpad) && /2回タップ/.test(okIpad), okIpad);
  const okWin = hint(true, WIN);
  check('パソコンではコントロールセンターの話をせず、明るさだけ案内する', !/コントロールセンター/.test(okWin) && /明るさ/.test(okWin), okWin);
  const ng = hint(false, IPAD);
  check('自動ロックを止められなかったときも、明るさの案内を出す', /自動ロック/.test(ng) && /明るさ/.test(ng) && /2回タップ/.test(ng), ng);
  check('端末が分からなくても案内を作れる', /明るさ/.test(hint(true, null)));
}

console.log('\n■ 読み上げ：真っ黒の間は電池を使う仕事を止める');
{
  const sp = loadApp(['js/core.js', 'js/speech.js']);
  // 真っ黒の画面の出し入れを確かめるための小さな画面
  sp(`
    globalThis.__els = {};
    globalThis.__getEl = (id) => {
      if (!__els[id]) {
        const cls = new Set();
        __els[id] = { id, innerHTML: '', textContent: '', checked: true, style: {}, addEventListener: () => {},
          classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle: () => {} } };
      }
      return __els[id];
    };
    globalThis.__htmlCls = new Set();
    globalThis.__meta = { attrs: { content: '#0057e7' }, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
    globalThis.__events = [];
    globalThis.Event = function (type) { this.type = type; };
    globalThis.document = {
      getElementById: __getEl,
      querySelector: (sel) => sel === 'meta[name="theme-color"]' ? __meta : null,
      documentElement: { classList: { add: c => __htmlCls.add(c), remove: c => __htmlCls.delete(c), contains: c => __htmlCls.has(c) } },
      dispatchEvent: (e) => { __events.push(e.type); },
      addEventListener: () => {}
    };
    globalThis.__play = 0; globalThis.__pause = 0;
    speechSilentAudio = { play: () => { __play++; return Promise.resolve(); }, pause: () => { __pause++; } };
    delete navigator.wakeLock;
    navigator.audioSession = { type: 'playback' };
    speechQueue = [];
    speechIsPlaying = true;
  `);
  sp('openSpeechDarkScreen()');
  eq('真っ黒にしても音の種類（audioSession）は「再生」のまま', sp('navigator.audioSession.type'), 'playback');
  eq('真っ黒の間は Safari の上の帯の色（theme-color）も黒にする', sp('__meta.attrs.content'), '#000000');
  check('真っ黒の間はページ全体に印を付ける（背景も黒・同期チェックを止める目印）', sp('__htmlCls.has("speechDarkActive")'));
  // v31.5 で真っ黒にするときに無音の音声を止めたら、iPadで読み上げが止まった。触らないこと
  eq('真っ黒にしても無音の音声は止めない（読み上げが止まるため）', sp('__pause'), 0);
  sp('__getEl("speechCurrentCard").innerHTML = "前の表示"; renderSpeechCurrentCard();');
  eq('真っ黒の間は見えない画面を描き直さない', sp('__getEl("speechCurrentCard").innerHTML'), '前の表示');
  sp('closeSpeechDarkScreen()');
  eq('戻ったら theme-color を元の色に戻す', sp('__meta.attrs.content'), '#0057e7');
  check('戻ったらページの印を外す', !sp('__htmlCls.has("speechDarkActive")'));
  eq('戻っても無音の音声を流し直さない（音の種類を変えない）', [sp('__play'), sp('__pause'), sp('navigator.audioSession.type')], [0, 0, 'playback']);
  check('戻ったら止めていた画面を1回描き直す', /speechEmpty/.test(sp('__getEl("speechCurrentCard").innerHTML')), sp('__getEl("speechCurrentCard").innerHTML'));
  eq('戻ったら同期チェックを1回行うよう知らせる', sp('__events'), ['ronsho:speechDarkClosed']);
  sp('__getEl("speechCurrentCard").innerHTML = "x"; closeSpeechDarkScreen();');
  eq('もう一度戻す操作をしても、描き直しは重ねない', sp('__getEl("speechCurrentCard").innerHTML'), 'x');
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


console.log('\n■ 過去問の資料：データ（data/exam/*.json）');
{
  const crypto = require('crypto');
  const index = JSON.parse(read(path.join('data', 'exam', 'index.json')));
  check('一覧に年度がある', Array.isArray(index.years) && index.years.length >= 16, (index.years || []).length + '件');
  const bad = [];
  const files = {};
  index.years.forEach(y => {
    const rel = path.join('data', 'exam', y.file);
    if (!fs.existsSync(path.join(ROOT, rel))) { bad.push(y.file + ' が無い'); return; }
    const body = read(rel);
    files[y.file] = JSON.parse(body);
    const rev = crypto.createHash('sha1').update(body, 'utf8').digest('hex').slice(0, 12);
    if (rev !== y.rev) bad.push(y.file + ' の rev が中身と合わない（build.py で作り直す）');
  });
  eq('一覧のファイルが全部あり、rev が中身と合う', bad, []);
  const problems = [];
  Object.keys(files).forEach(f => {
    const d = files[f];
    Object.keys(d.subjects).forEach(subj => {
      Object.keys(d.subjects[subj]).forEach(kind => {
        const doc = d.subjects[subj][kind];
        const where = f + ' ' + subj + ' ' + kind;
        if (!Array.isArray(doc.paras) || doc.paras.length === 0) problems.push(where + '：文が空');
        if (!/^https:\/\/www\.moj\.go\.jp\//.test(doc.page || '') || !/^https:\/\/www\.moj\.go\.jp\/content\/\d+\.pdf$/.test(doc.pdf || '')) problems.push(where + '：出典のURLが無い');
        (doc.paras || []).forEach(p => {
          if (/^[-－]\s*[0-9０-９]+\s*[-－]$/.test(p)) problems.push(where + '：ページ番号が残っている「' + p + '」');
          if (/司法試験の採点実感（/.test(p)) problems.push(where + '：別の科目の採点実感の見出しが混ざっている');
        });
      });
    });
  });
  eq('どの資料にも文と出典があり、ページ番号・別の科目の見出しが混ざっていない', problems.slice(0, 5), []);
  // 司法試験の令和元〜7年は、8科目すべてに問題・出題趣旨・採点実感がそろう
  const missing = [];
  for (let y = 1; y <= 7; y++) {
    const d = files['shiho-R' + y + '.json'];
    ['憲法', '行政法', '民法', '商法', '民事訴訟法', '刑法', '刑事訴訟法', '労働法'].forEach(s => {
      ['mondai', 'shushi', 'jikkan'].forEach(k => { if (!(d && d.subjects[s] && d.subjects[s][k])) missing.push('R' + y + s + k); });
    });
  }
  eq('司法試験 令和元〜7年：8科目×3種類がそろう', missing, []);
  const yobiMissing = [];
  for (let y = 1; y <= 7; y++) {
    const d = files['yobi-R' + y + '.json'];
    const subs = ['憲法', '行政法', '民法', '商法', '民事訴訟法', '刑法', '刑事訴訟法', '実務基礎民事', '実務基礎刑事'].concat(y >= 4 ? ['労働法'] : []);
    subs.forEach(s => ['mondai', 'shushi'].forEach(k => { if (!(d && d.subjects[s] && d.subjects[s][k])) yobiMissing.push('R' + y + s + k); }));
  }
  eq('予備試験 令和元〜7年：問題・出題趣旨がそろう（労働法は令和4年から）', yobiMissing, []);
  const yobiJikkan = Object.keys(files).filter(f => f.startsWith('yobi')).filter(f => Object.values(files[f].subjects).some(x => x.jikkan));
  eq('予備試験には採点実感が無い（公表されていない）', yobiJikkan, []);
  // 段落が行の途中の断片で切れていない（v32.3。PDFの1行が「 」【 などの前後で別の行として抜き出され、段落が切れていた）
  const broken = [];
  Object.keys(files).forEach(f => Object.keys(files[f].subjects).forEach(subj => Object.keys(files[f].subjects[subj]).forEach(kind => {
    files[f].subjects[subj][kind].paras.forEach((p, i, a) => {
      if (/[、，]$/.test(p)) broken.push(f + ' ' + subj + ' ' + kind + '：読点で終わる段落「…' + p.slice(-12) + '」');
      if (/^[）」』】〕］〉》、。，．)]/.test(p)) broken.push(f + ' ' + subj + ' ' + kind + '：閉じ括弧・句読点で始まる段落「' + p.slice(0, 12) + '…」');
    });
  })));
  eq('読点で終わる段落・閉じ括弧で始まる段落が無い（文の途中で段落が切れていない）', broken.slice(0, 5), []);
  const jikou = files['shiho-R8.json'].subjects['民法'].shushi.paras;
  check('令和8年 民法 出題趣旨の「時効取得と登記」の文が切れずにつながる',
    jikou.some(p => p.includes('この点は、「時効取得と登記」として古くから論じられている問題であり')) && jikou.some(p => p.includes('という。）であるかによって問題を区別する')));
  const r7 = files['shiho-R7.json'];
  check('問題文の段落が文の途中で切れていない（令和7年 憲法の1段落目）', /。$/.test(r7.subjects['憲法'].mondai.paras[1]), r7.subjects['憲法'].mondai.paras[1]);
  check('ぶら下げの箇条書き（○…）を1段落にまとめる', r7.subjects['行政法'].jikkan.paras.some(p => /^○　行政事件訴訟法.*判断した。$/.test(p)));
}

console.log('\n■ 過去問の資料：表示・色分け・読んだ印・論証とのつながり・解答');
{
  const ex = loadApp(['js/core.js', 'js/past-exam.js', 'js/lawref.js', 'js/exam-docs.js']);
  const cls = ex('examDocsClassifySentence');
  eq('注意点の文を赤にする', [cls('判例の理解が不十分な答案が散見された。'), cls('結論のみを示す答案が少なくなかった。'), cls('事実を書き写しただけの答案もあった。')], ['bad', 'bad', 'bad']);
  eq('良い例の文を緑にする', [cls('判断枠組みを正確に示した答案は高く評価できた。'), cls('多くの答案がよく書けていた。')], ['good', 'good']);
  eq('どちらでもない文は色なし', cls('以下は、考査委員の意見をまとめたものである。'), '');
  eq('採点方針の説明（「的確に行うことができるかを問う」）は緑にしない', cls('基礎的な理解を確認し、その応用を的確に行うことができるか否かを問うこととした。'), '');
  eq('「的確に」でも答案の話なら緑', cls('事案を的確に分析している答案が多かった。'), 'good');
  eq('良い点と注意点が両方ある文は注意点を優先', cls('一般論はよく書けていたが、あてはめは不十分であった。'), 'bad');
  eq('「。」で文に分ける', ex('examDocsSplitSentences')('一つ目。二つ目。三つ目'), ['一つ目。', '二つ目。', '三つ目']);
  const isH = ex('examDocsIsHeading');
  eq('見出しを見分ける', [isH('〔第１問〕（配点：１００）'), isH('［労働法］'), isH('１　出題の趣旨'), isH('⑵　設問１⑵'), isH('本問は、表現の自由を問うものである。')], [true, true, true, true, false]);
  const body = ex('examDocsBodyHtml');
  const paras = ['〔設問１〕', '答案はよく書けていた。', '検討が不十分な答案が多かった。', '<script>alert(1)</script>'];
  const hlHtml = body(paras, { hl: true, filter: 'all' });
  check('文の中のタグはエスケープする', !/<script/.test(hlHtml) && /&lt;script&gt;/.test(hlHtml), hlHtml);
  check('色分けすると良い例・注意点に印が付く', /class="examHlGood"/.test(hlHtml) && /class="examHlBad"/.test(hlHtml), hlHtml);
  const badOnly = body(paras, { hl: true, filter: 'bad' });
  check('「注意点だけ」でも見出しは残し、良い例は隠す', /設問１/.test(badOnly) && /不十分/.test(badOnly) && !/よく書けて/.test(badOnly), badOnly);
  eq('色分けの数を数える', ex('examDocsCountMarks')(paras), { good: 1, bad: 1 });
  // 条文リンクは法律名つきだけ（科目を渡さない）。「本件条例第３２条」のような架空の法令に付けないため
  const refs = ex('lawrefFindRefs')('民法第４１５条の請求と、本件条例第３２条の勧告。行訴法第９条第１項', null);
  eq('法律名つきの参照だけをリンクにする', refs.map(r => r.label), ['民法415条', '行訴法9条第1項']);

  // 読んだ印
  const setRead = ex('examDocsSetRead');
  let map = {};
  map = setRead(map, '新司法試験', 7, '民法', 'mondai', true, '2026-01-02');
  map = setRead(map, '新司法試験', 7, '民法', 'jikkan', true, '2026-01-03');
  eq('読んだ印は種類ごとに日付で持つ', map, { '新司法試験|7|民法': { m: '2026-01-02', j: '2026-01-03' } });
  const isRead = ex('examDocsIsRead');
  eq('読んだかどうかを引ける', [isRead(map, '新司法試験', 7, '民法', 'mondai'), isRead(map, '新司法試験', 7, '民法', 'shushi'), isRead(map, '予備試験', 7, '民法', 'mondai')], [true, false, false]);
  const before = JSON.stringify(map);
  const map2 = setRead(map, '新司法試験', 7, '民法', 'mondai', false);
  const map3 = setRead(map2, '新司法試験', 7, '民法', 'jikkan', false);
  eq('印を外すと消え、全部外すと項目ごと消える（元の map は変えない）', [map3, JSON.stringify(map) === before], [{}, true]);
  eq('年度の進み具合（公表されている資料のうち読んだ数）', ex('examDocsYearProgress')(map, '新司法試験', 7, { subjects: { 民法: ['mondai', 'shushi', 'jikkan'], 憲法: ['mondai'] } }), { total: 4, done: 2 });
  ex('saveExamRead')(map);
  eq('読んだ印を保存して読み戻せる', ex('loadExamRead()'), map);
  ex('localStorage.setItem("ronshoExamReadV1", "[壊れた")');
  eq('壊れた値でも空として読む', ex('loadExamRead()'), {});

  // 論証の「出題年」
  const tok = ex('examDocsParseYearToken');
  eq('出題年の区切りから令和の年と試験を読む', [tok('R5|#2fff2e'), tok('R元|#00ccff'), tok('Ｒ７|'), tok('H30|#2fff2e')].map(t => t && [t.year, t.examType]), [[5, '新司法試験'], [1, '予備試験'], [7, null], null]);
  const list = [
    { title: 'A', subject: '民法', year: 'R5|#2fff2e;H30|#2fff2e' },
    { title: 'B', subject: '民法', year: 'R5|#00ccff' },
    { title: 'C', subject: '民法', year: 'R5|' },
    { title: 'D', subject: '刑法', year: 'R5|#2fff2e' },
    { title: 'E', subject: '民法', year: 'R15|#2fff2e' }
  ];
  eq('同じ年度・科目の論証（色の無い年度はどちらの試験にも出す）', ex('examDocsRelatedEntries')(list, '新司法試験', 5, '民法').map(e => e.title), ['A', 'C']);
  eq('予備試験なら水色と色なし', ex('examDocsRelatedEntries')(list, '予備試験', 5, '民法').map(e => e.title), ['B', 'C']);
  const links = ex('examDocsYearLinksHtml')({ subject: '民法', year: 'R5|#2fff2e;H30|#2fff2e;R6|red"><b>' }, '新司法試験');
  check('令和の年度だけ資料へのリンクにする', (links.match(/examYearLink/g) || []).length === 2 && /data-year="5"/.test(links) && !/data-year="30"/.test(links), links);
  check('年度のリンクに不正な色・タグを埋め込まない', !/<b>|red"/.test(links), links);

  // 解答の時間
  const fmt = ex('examDocsFormatRemaining');
  eq('残り時間の表示', [fmt(3909000), fmt(59000), fmt(-180000)], ['1:05:09', '0:00:59', '-0:03:00']);
  const mins = ex('examDocsDefaultMinutes');
  eq('試験時間の目安', [mins('新司法試験', '民法'), mins('新司法試験', '労働法'), mins('予備試験', '刑法'), mins('予備試験', '実務基礎民事')], [120, 180, 70, 90]);
  // 書き終えたら：解答ログに次の回数で1件足し、問題を読んだ印にし、解答中を終える
  ex('localStorage.setItem("ronshoPastExamLogs_v1", JSON.stringify([{ examType: "新司法試験", subject: "民法", year: "令和7年", round: 1, date: "2025-01-01", memo: "" }]))');
  ex('localStorage.setItem("ronshoExamReadV1", "{}")');
  ex('saveExamPractice({ examType: "新司法試験", year: 7, subject: "民法", startedAt: Date.now() - 30 * 60000, minutes: 120 })');
  const msg = ex('examDocsFinishPractice()');
  const logs = ex('loadPastExamLogs()');
  const added = logs.filter(l => l.subject === '民法' && l.year === '令和7年' && l.round === 2);
  check('書き終えたら解答ログに2回目を足す', added.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(added[0].date), JSON.stringify(logs));
  check('記録した回数と時間を知らせる', /2回目/.test(msg) && /30分/.test(msg), msg);
  eq('書き終えたら問題を読んだ印にする', ex('examDocsIsRead(loadExamRead(), "新司法試験", 7, "民法", "mondai")'), true);
  eq('書き終えたら解答中を終える', ex('loadExamPractice()'), null);
  eq('解答中でなければ何もしない', ex('examDocsFinishPractice()'), '');
  ex('localStorage.setItem("ronshoExamPracticeV1", "{壊れた")');
  eq('壊れた解答中の値は無視する', ex('loadExamPractice()'), null);
  // v34.0 でマーカーの色（黄）と「文をタップで引く」（オフ）を表示の好みに足した
  eq('表示の好みの既定値（解く時間は40分・マーカーは黄・文タップはオフ）', ex('loadExamDocsView()'), { layout: 'tabs', hl: true, filter: 'all', minutes: 40, mkColor: 'y', mkTap: false });
  // 解く時間：40分・45分・その他（入力する）（v32.2）
  eq('解く時間の選択肢は40分と45分', ex('EXAM_DOCS_MINUTE_PRESETS'), [40, 45]);
  eq('まだ選んでいなければ40分', ex('examDocsPracticeMinutes()'), 40);
  const parseMin = ex('examDocsParseMinutes');
  eq('入力した時間の読み取り（全角の数字も可）', [parseMin('50'), parseMin('５５'), parseMin(' 90分 '), parseMin('600')], [50, 55, 90, 600]);
  eq('時間として使えない入力は null（0・空・文字・601以上）', [parseMin('0'), parseMin(''), parseMin('あ'), parseMin('601'), parseMin(null)], [null, null, null, null, null]);
  ex('examDocsSaveMinutes(55)');
  eq('「その他」で入れた時間を次回も使う', ex('examDocsPracticeMinutes()'), 55);
  ex('localStorage.setItem("ronshoExamDocsViewV1", JSON.stringify({ minutes: 9999 }))');
  eq('範囲外の保存値は40分に戻す', ex('examDocsPracticeMinutes()'), 40);
  ex('localStorage.setItem("ronshoExamDocsViewV1", JSON.stringify({ minutes: 1.5 }))');
  eq('小数の保存値は40分に戻す', ex('examDocsPracticeMinutes()'), 40);
  ex('localStorage.removeItem("ronshoExamDocsViewV1")');
  {
    const css = read('style.css');
    check('1列で読むときは幅をおさえて中央に置く', /\.examDocReadCol \{[^}]*max-width: 700px[^}]*margin: 0 auto/.test(css));
    check('3列で並べるときは幅をおさえない（読む列の中に入れない）', /if \(!side\) html = '<div class="examDocReadCol">'/.test(read('js/exam-docs.js')));
  }
  eq('ファイル名', [ex('examDocsFileName("新司法試験", 7)'), ex('examDocsFileName("予備試験", 1)')], ['shiho-R7.json', 'yobi-R1.json']);
  eq('科目があるか（予備試験の労働法は令和4年から、実務基礎は予備試験だけ）',
    [ex('examDocsSubjectApplies("予備試験", "労働法", 3)'), ex('examDocsSubjectApplies("予備試験", "労働法", 4)'), ex('examDocsSubjectApplies("新司法試験", "実務基礎民事", 7)')], [false, true, false]);
}

async function runAsyncChecks() {
  console.log('\n■ 読み上げ：画面が自動で消えないようにする（Wake Lock）');
  {
    const sp = loadApp(['js/core.js', 'js/speech.js']);
    sp('globalThis.__req = 0; globalThis.__rel = 0; navigator.wakeLock = { request: () => { globalThis.__req++; return Promise.resolve({ release: () => { globalThis.__rel++; return Promise.resolve(); }, addEventListener: () => {} }); } };');
    sp('speechIsPlaying = true;');
    const both = await Promise.all([sp('acquireSpeechWakeLock()'), sp('acquireSpeechWakeLock()')]);
    eq('取れたら true を返す', both, [true, true]);
    eq('取得中に重ねて呼ばれても1回しか取らない', sp('globalThis.__req'), 1);
    eq('取れた後に呼ばれても取り直さない', [await sp('acquireSpeechWakeLock()'), sp('globalThis.__req')], [true, 1]);
    sp('releaseSpeechWakeLock(); speechIsPlaying = false; speechDarkOpen = false;');
    const pending = sp('acquireSpeechWakeLock()');
    eq('取得を待つ間に止められていたら、すぐ手放す', [await pending, sp('globalThis.__rel'), sp('speechWakeLock')], [false, 2, null]);
    sp('navigator.wakeLock = { request: () => Promise.reject(new Error("NotAllowedError")) }; speechIsPlaying = true;');
    eq('取れなかったら false を返す（真っ黒の画面に自動ロックの設定を案内する）', await sp('acquireSpeechWakeLock()'), false);
    sp('delete navigator.wakeLock;');
    eq('Wake Lock に対応していない端末でも false を返す', await sp('acquireSpeechWakeLock()'), false);
  }

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

console.log('\n■ iPad：マスの長押し・過去問ログのはみ出し（v32.1）');
{
  const css = read('style.css'), js = read('js/exam-docs.js');
  // 実機のiPadでは pointercancel が長押しの途中で出て長押しが途切れたため、指は touch イベントで見る
  check('指の長押しは touchstart で測る', /wrap\.addEventListener\('touchstart'/.test(js));
  check('指の長押しは touchcancel では取り消さない（iPadが出すことがある）', !/addEventListener\('touchcancel'/.test(js) && !/'touchcancel'/.test(js));
  check('指の pointer イベントは長押しに使わない（二重に動かさない）', (js.match(/pointerType === 'touch'\) return;/g) || []).length >= 3);
  check('スクロールしたら長押しを取り消す', /addEventListener\('scroll', cancel, true\)/.test(js));
  check('マスは Safari 用の -webkit-user-select: none（文字選択・拡大鏡が出ない）', /\.pastMatrixCell \{[^}]*-webkit-user-select: none/.test(css));
  // 一覧(約550px)とログ(約480px)を左右に並べるのは幅が足りるときだけ。iPadの縦向きではログがはみ出していた
  const m = css.match(/@media \(max-width: (\d+)px\) \{ \.pastCombinedGrid \{ grid-template-columns: 1fr; \} \}/);
  check('過去問ログは1100px以下で縦に積む（iPadの縦向き・小さめの横向き）', !!m && Number(m[1]) >= 1100, m ? m[1] + 'px' : '見つからない');
  check('ログ欄は幅が足りなくても画面の外に出さず、その中で横にスクロールする', /\.pastLogCol \{[^}]*overflow-x: auto/.test(css));
}

console.log('\n■ 過去問の資料：段落の頭の字下げ・マーカー（v34.0）');
{
  const mk = loadApp(['js/core.js', 'js/past-exam.js', 'js/lawref.js', 'js/exam-docs.js', 'js/exam-refs.js', 'js/exam-marks.js']);
  const ind = mk('examDocsParaIndent');
  eq('ふつうの文で始まる段落は1字下げる', [ind('本問は，表現の自由を問うものである。'), ind('「優秀」に該当する答案は，出題趣旨を理解していた。'), ind('Ａは，Ｂに対し，代金の支払を求めた。'), ind('一応の水準の答案は少なかった。'), ind('フェイク・ニュース規制法（案）')], [true, true, true, true, true]);
  eq('番号・記号・括弧・話し手で始まる段落は下げない', [
    ind('（１）　設問１について'), ind('(ｱ)　原告適格'), ind('ア　設問１の全体的な採点実感'), ind('イ　答案の例'), ind('１　出題の趣旨と採点の方針について述べる。'), ind('1.　総論'),
    ind('⑴　違法性の承継について'), ind('②について検討する。'), ind('・　本件事業認定の違法を主張できるか。'), ind('○　総論'), ind('〇　農地法（抜粋）'), ind('※　配点は別紙'),
    ind('一　虚偽表現　虚偽の事実をいう。'), ind('二～六　（略）'), ind('ロ～ホ　（略）'), ind('第１　設問１'), ind('【事例】'), ind('〔設問１〕について'),
    ind('弁護士Ｄ：Ａさんは，違法であると考えている。'), ind('甲：規制①が検討された背景には'), ind('Ｘ：そうです。'), ind('　すでに空白で始まる段落'), ind('')
  ], new Array(23).fill(false));
  check('見出しは下げない', !ind('〔第１問〕（配点：１００）'));
  const ph = mk('examDocsParaHtml');
  check('下げる段落に examDocIndent を付ける', /^<p class="examDocIndent" data-pi="3">/.test(ph('本問は易しい。', false, 3)));
  check('番号で始まる段落には付けない', /^<p data-pi="0">/.test(ph('１　総論について述べる。', false, 0)));
  const css = read('style.css');
  check('字下げは1字（text-indent: 1em）', /\.examDocBody p\.examDocIndent \{ text-indent: 1em; \}/.test(css));

  // マーカーの範囲の計算
  const paras = ['本問は易しい。答案は不十分であった。　', '二つ目の段落です。', '三つ目。'];
  const apply = (list, p, s, e, c) => JSON.parse(JSON.stringify(mk('examMarksApply')(paras, list, p, s, e, c)));
  let L = apply([], 0, 0, 7, 'y');
  eq('引くと、段落・位置・色・文を持つ', L, [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }]);
  eq('前後の空白は含めない', apply([], 0, 7, 19, 'b'), [{ p: 0, s: 7, e: 18, c: 'b', t: '答案は不十分であった。' }]);
  eq('同じ色で重なる・隣り合うものは1つにまとめる', apply(apply(L, 0, 5, 10, 'y'), 0, 10, 12, 'y'), [{ p: 0, s: 0, e: 12, c: 'y', t: '本問は易しい。答案は不十' }]);
  eq('違う色を重ねると、重なったところだけ新しい色にする', apply(L, 0, 2, 4, 'p'), [{ p: 0, s: 0, e: 2, c: 'y', t: '本問' }, { p: 0, s: 2, e: 4, c: 'p', t: 'は易' }, { p: 0, s: 4, e: 7, c: 'y', t: 'しい。' }]);
  eq('消すと、その範囲だけ消える（両側は残る）', apply(L, 0, 2, 4, null), [{ p: 0, s: 0, e: 2, c: 'y', t: '本問' }, { p: 0, s: 4, e: 7, c: 'y', t: 'しい。' }]);
  eq('全部消すと空になる', apply(L, 0, 0, 7, null), []);
  eq('ほかの段落のマーカーには触れない', apply(apply(L, 1, 0, 3, 'b'), 1, 0, 9, null), L);
  check('元の配列は変えない', JSON.stringify(L) === JSON.stringify([{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }]));
  // 資料を作り直して文がずれたとき
  const res = mk('examMarksResolve');
  const moved = JSON.parse(JSON.stringify(res(['はじめに。本問は易しい。', 'x'], [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }])));
  eq('位置がずれても、同じ段落で文を探し直す', moved, [{ i: 0, c: 'y', t: '本問は易しい。', p: 0, s: 5, e: 12 }]);
  eq('段落の番号がずれても、ほかの段落から探す', JSON.parse(JSON.stringify(res(['前書き', '本問は易しい。'], [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }])))[0].p, 1);
  eq('見つからない・壊れた値は p: null（描かない）', JSON.parse(JSON.stringify(res(paras, [{ p: 0, s: 0, e: 3, c: 'y', t: '無い文' }, { p: 0, s: 3, e: 1, c: 'y', t: '' }, { p: 0, s: 0, e: 2, c: 'z', t: '本問' }]))).map(r => r.p), [null, null, null]);
  eq('見失ったマーカーは、ほかを引いても消さずに残す', apply([{ p: 0, s: 0, e: 3, c: 'y', t: '無い文' }], 2, 0, 4, 'b'), [{ p: 0, s: 0, e: 3, c: 'y', t: '無い文' }, { p: 2, s: 0, e: 4, c: 'b', t: '三つ目。' }]);
  // 文をタップ
  const at = mk('examMarksSentenceAt');
  eq('タップした字を含む文（。まで）', [at(paras[0], 0), at(paras[0], 6), at(paras[0], 7), at(paras[0], 17)].map(r => r && [r.s, r.e]), [[0, 7], [0, 7], [7, 18], [7, 18]]);
  const tog = (list, p, off, c) => JSON.parse(JSON.stringify(mk('examMarksToggleSentence')(paras, list, p, off, c)));
  const t1 = tog([], 0, 9, 'p');
  eq('文をタップすると、その文全体に引く', t1.list, [{ p: 0, s: 7, e: 18, c: 'p', t: '答案は不十分であった。' }]);
  eq('同じ色の文をもう一度タップすると消す', tog(t1.list, 0, 12, 'p').list, []);
  eq('違う色の文をタップすると、今の色に塗り替える', tog(t1.list, 0, 12, 'b').list, [{ p: 0, s: 7, e: 18, c: 'b', t: '答案は不十分であった。' }]);
  eq('文の一部だけ引いてあれば、文全体に広げる', tog(apply([], 0, 1, 3, 'y'), 0, 0, 'y').list, [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }]);
  // 描く
  const by = mk('examMarksByPara')(res(paras, apply(apply([], 0, 0, 7, 'y'), 0, 10, 12, 'b')));
  const html = ph(paras[0], true, 0, by[0]);
  check('マーカーを mark で描き、番号（data-mi）を付ける', /<mark class="examMark examMark-y" data-mi="0">本問は易しい。<\/mark>/.test(html) && /<mark class="examMark examMark-b" data-mi="1">不十<\/mark>/.test(html), html);
  check('採点実感の色分けの中にマーカーを入れても、文はそのまま', /<span class="examHlBad">答案は<mark[^>]*>不十<\/mark>分であった。<\/span>　<\/p>/.test(html), html);
  const esc = ph('<b>強調</b>です。', false, 0, [{ s: 0, e: 3, c: 'p', i: 0 }]);
  check('マーカーの中の文もエスケープする', /<mark class="examMark examMark-p" data-mi="0">&lt;b&gt;<\/mark>強調&lt;\/b&gt;です。/.test(esc), esc);
  eq('重なった値は描くときに切り詰める', JSON.parse(JSON.stringify(mk('examMarksByPara')([{ i: 0, p: 0, s: 0, e: 5, c: 'y' }, { i: 1, p: 0, s: 3, e: 8, c: 'b' }]))), { 0: [{ s: 0, e: 5, c: 'y', i: 0 }, { s: 5, e: 8, c: 'b', i: 1 }] });
  // 保存と、資料ごとの取り出し
  mk('saveExamMarks')({ '新司法試験|7|民法|shushi': [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }] });
  eq('保存して資料ごとに取り出せる', JSON.parse(JSON.stringify(mk('examMarksForDoc("新司法試験", 7, "民法", "shushi", ' + JSON.stringify(paras) + ')'))), { 0: [{ s: 0, e: 7, c: 'y', i: 0 }] });
  eq('ほかの資料には出ない', mk('examMarksForDoc("新司法試験", 7, "民法", "jikkan", ' + JSON.stringify(paras) + ')'), null);
  mk('localStorage.setItem("ronshoExamMarksV1", "[壊れた")');
  eq('壊れた値でも空として読む', JSON.parse(JSON.stringify(mk('loadExamMarks()'))), {});
  check('本文の文字の位置は、判例の印（百選○・⚖️）を数えない', /querySelectorAll\('\.examCaseBadge'\)/.test(read('js/exam-marks.js')));
  // 同期・バックアップ
  const sync = read('drive-sync.js'), bk = read('js/backup.js'), idx = read('index.html'), sw = read('sw.js');
  check('マーカーは同期の対象（snapshot・applyRemoteData・競合の表示）', /examMarks: read\(EXAM_MARKS_KEY, \{\}\)/.test(sync) && /write\(EXAM_MARKS_KEY,/.test(sync) && /examMarks: '🖍/.test(sync));
  check('マーカーは手動バックアップから戻せる', /data\.examMarks[\s\S]{0,120}ronshoExamMarksV1/.test(bk));
  check('index.html で exam-marks.js を exam-docs.js の後に読み、オフライン用にも入れる', idx.indexOf('js/exam-marks.js') > idx.indexOf('js/exam-docs.js') && sw.includes("'./js/exam-marks.js'"));
  // 一覧
  mk('saveExamMarks')({ '新司法試験|7|民法|shushi': [{ p: 0, s: 0, e: 7, c: 'y', t: '本問は易しい。' }], '新司法試験|7|民法|mondai': [{ p: 1, s: 0, e: 3, c: 'b', t: '二つ目' }] });
  mk('examDocsState.examType = "新司法試験"; examDocsState.year = 7; examDocsState.subject = "民法"; examDocsState.mkListOpen = true;');
  const subj = { mondai: { paras: paras }, shushi: { paras: paras } };
  const listHtml = mk('examMarksListHtml')(mk('examDocsState'), subj, false);
  check('引いたところの一覧に件数と文を出す', /引いたところ（2件）/.test(listHtml) && /二つ目/.test(listHtml) && /本問は易しい。/.test(listHtml) && listHtml.indexOf('二つ目') < listHtml.indexOf('本問は易しい'), listHtml);
  const lockedHtml = mk('examMarksListHtml')(mk('examDocsState'), subj, true);
  check('解いている間は、出題趣旨・採点実感のマーカーの文を一覧に出さない', /二つ目/.test(lockedHtml) && !/本問は易しい/.test(lockedHtml) && /解き終えるまで隠しています/.test(lockedHtml), lockedHtml);
}

console.log('\n■ 出題趣旨の条文・判例：読み取り・索引・照合（v33.0）');
{
  const rf = loadApp(['js/core.js', 'js/past-exam.js', 'js/precedent.js', 'js/lawref.js', 'js/exam-docs.js', 'js/exam-refs.js']);
  const find = t => rf('examRefsFindCases')(t).map(c => [c.text, c.key, c.rep]);
  eq('略称（最大判）と判例集', find('薬事法事件判決（最大判昭和５０年４月３０日民集２９巻４号５７２頁）が参考になる'),
    [['最大判昭和５０年４月３０日民集２９巻４号５７２頁', '最|1975-04-30', '民集29-4-572']]);
  eq('「最高裁判所…第二小法廷決定・民集」の書き方', find('判例（最高裁判所平成１１年１１月１２日第二小法廷決定・民集５３巻８号１７８７頁ほか）'),
    [['最高裁判所平成１１年１１月１２日第二小法廷決定・民集５３巻８号１７８７頁', '最|1999-11-12', '民集53-8-1787']]);
  eq('判決日が先の書き方（「昭和４４年１２月１８日最高裁判決」）', find('前掲昭和４４年１２月１８日最高裁判決参照'), [['昭和４４年１２月１８日最高裁判決', '最|1969-12-18', '']]);
  eq('大審院・民録（輯）', find('大判明治３７年６月２２日民録１０輯８６１頁'), [['大判明治３７年６月２２日民録１０輯８６１頁', '大|1904-06-22', '民録10-861']]);
  eq('「前掲」は裁判所名に入れない・高裁', find('前掲東京高決平成１７年３月２３日を踏まえ'), [['東京高決平成１７年３月２３日', '高|2005-03-23', '']]);
  eq('支部の地裁・判例時報の言い換え', find('千葉地佐倉支決昭和５６年９月１日判例時報１０２１号１３４頁').map(x => [x[1], x[2]]), [['地|1981-09-01', '判時1021-134']]);
  eq('半角・「・」区切り・元年', find('最判平元・3・7').map(x => x[1]), ['最|1989-03-07']);
  eq('判例でない日付（令和２年４月１日に施行）は拾わない', find('令和２年４月１日に施行された民法（債権関係）'), []);
  const compat = rf('examRefsRepCompatible');
  eq('判例集の食い違いだけを別の判例とみなす', [compat('民集29-4-572', ''), compat('民集29-4-572', '民集29-4-572'), compat('民集31-2-234', '民集31-2-280'), compat('民集23-11-2150', '刑集23-11-1490')], [true, true, false, true]);
  const arts = rf('examRefsFindArticles')('民法第４２４条の５と、同法第１７８条。会社法第８３１条第１項、旧民法第１条、法第３条、本件条例第３２条')
    .map(a => a.lid + a.num + (a.branch ? '-' + a.branch : ''));
  eq('条文：法律名つき・「同法」は直前の法律、旧法・法律名なし・条例は数えない', arts, ['minpou424-5', 'minpou178', 'kaishahou831']);
  // 索引づくり：出題趣旨だけを数え、同じ段落の重なりは1回
  const idx = rf('examRefsBuildIndex')([{ code: 'shiho', year: 5, data: { subjects: { 民法: {
    shushi: { paras: ['民法第７０９条と民法第７０９条。最判昭和４４年９月１２日判例時報５７２号２５頁', '同じ判例（最判昭和４４年９月１２日）'] },
    jikkan: { paras: ['民法第１条（最判平成元年１月１日）'] } } } } }]);
  eq('索引：条文は段落ごとに1回・採点実感は数えない', idx.articles, { 'minpou|709': [['shiho', 5, '民法', 0]] });
  eq('索引：判例の指摘に判例集を添える', idx.cases['最|1969-09-12'].m, [['shiho', 5, '民法', 0, '判時572-25'], ['shiho', 5, '民法', 1, '']]);
  check('索引：採点実感だけの判例は入れない', !idx.cases['最|1989-01-01']);
  // 入っている data/exam/refs.json が、今の資料・今の読み取り方で作り直したものと一致するか
  const rebuilt = require(path.join(ROOT, 'tools', 'exam-fetch', 'build-refs.js')).buildRefs();
  const stored = JSON.parse(read('data/exam/refs.json'));
  eq('data/exam/refs.json は最新（資料を作り直したら node tools/exam-fetch/build-refs.js）', JSON.stringify(stored) === JSON.stringify(rebuilt), true);
  check('索引に主な条文・判例が入っている', stored.articles['minpou|95'] && stored.articles['kaishahou|831'] && stored.cases['最|1975-04-30'],
    Object.keys(stored.articles).length + '条・' + Object.keys(stored.cases).length + '件');
  // 百選の目次の取り込み（例は架空の書名・判例名）
  const parsed = rf('parseHyakusenToc')('テスト判例百選Ⅰ（第9版）\n1　テスト一事件（最大判昭和50年4月30日民集29巻4号572頁）\n2 テスト二事件（最判平成元年3月7日）\n3　判決日のない行\n\nもう一冊の判例百選（第2版）\n10-2　テスト三事件（東京高判平成17年3月23日）', '');
  eq('目次：書名ごとに分け、番号・判例名・判決日を読む', parsed.books.map(b => [b.title, b.items.map(i => [i.no, i.name, i.date])]),
    [['テスト判例百選Ⅰ（第9版）', [['1', 'テスト一事件', '最大判昭和50年4月30日民集29巻4号572頁'], ['2', 'テスト二事件', '最判平成元年3月7日']]],
     ['もう一冊の判例百選（第2版）', [['10-2', 'テスト三事件', '東京高判平成17年3月23日']]]]);
  eq('目次：判決日が読めない行は数えて知らせる', parsed.skipped, 1);
  eq('目次：書名の行が無ければ書名の欄の値を使う', rf('parseHyakusenToc')('5　テスト事件（最判昭和44年9月12日）', '手入力の書名').books.map(b => b.title), ['手入力の書名']);
  const merged = rf('mergeHyakusenToc')([{ id: 'a', title: 'テスト判例百選Ⅰ（第9版）', items: [] }, { id: 'b', title: '別の本', items: [] }], parsed.books, '2026-11-22');
  eq('目次：同じ書名は入れ替え、新しい書名は足す', merged.map(b => [b.id === 'a' || b.id === 'b' ? b.id : 'new', b.title, b.items.length]),
    [['a', 'テスト判例百選Ⅰ（第9版）', 2], ['b', '別の本', 0], ['new', 'もう一冊の判例百選（第2版）', 1]]);
  eq('書名から科目', ['憲法判例百選Ⅰ', '会社法判例百選', '民事訴訟法判例百選', '刑法判例百選Ⅱ', '行政判例百選Ⅰ', '労働判例百選', '家族法判例百選'].map(rf('hyakusenSubjectOf')),
    ['憲法', '商法', '民事訴訟法', '刑法', '行政法', '労働法', '民法']);
  // 照合：判例タブの判例（判決日の欄）と、取り込んだ目次
  rf('localStorage').setItem('ronshoHyakusenTocV1', JSON.stringify(parsed.books.map((b, i) => Object.assign({ id: 't' + i }, b))));
  rf('precedents = [{ id: "p1", name: "登録した判例", date: "最高裁昭和50年4月30日大法廷判決", subject: "憲法" }, { id: "p2", name: "別の日", date: "最判昭和51年1月1日" }]');
  const m1 = rf('examRefsMatchCase')('最|1975-04-30', '民集29-4-572');
  eq('照合：判決日で判例タブと目次の両方に当たる', [m1.precedents.map(p => p.id), m1.toc.map(t => t.book + ' ' + t.no)], [['p1'], ['テスト判例百選Ⅰ（第9版） 1']]);
  eq('照合：判例集が食い違えば当てない', rf('examRefsMatchCase')('最|1975-04-30', '民集30-1-1').toc.length, 0);
  eq('照合：判例タブの判例を変えたら照合も変わる', (rf('precedents.push({ id: "p3", date: "最決平成元年3月7日" })'), rf('examRefsMatchCase')('最|1989-03-07', '').precedents.map(p => p.id)), ['p3']);
  // 資料の本文：判例の引用に下線と「百選○」、タグの中は触らない
  const linked = rf('examRefsLinkifyCasesHtml')('<p data-pi="3">判例（最大判昭和５０年４月３０日民集２９巻４号５７２頁）と最判平成２年１月１日。</p>');
  check('資料：百選にある判例は下線＋「百選1」', /<span class="examCaseRef hit" data-act="caseRef" data-ck="最\|1975-04-30" data-rep="民集29-4-572"[^>]*>最大判昭和５０年４月３０日民集２９巻４号５７２頁<span class="examCaseBadge">百選1<\/span><\/span>/.test(linked), linked);
  check('資料：どこにも無い判例は下線だけ（印なし）', /<span class="examCaseRef" data-act="caseRef" data-ck="最\|1990-01-01"/.test(linked) && /data-pi="3"/.test(linked), linked);
  const body = rf('examDocsBodyHtml')(['最判平成２年１月１日', '〔設問１〕'], { hl: false, filter: 'all', cases: true });
  // v34.0 から、ふつうの文で始まる段落には字下げの印（examDocIndent）が付く
  check('資料：段落に番号（data-pi）を付ける', /<p class="examDocIndent" data-pi="0">/.test(body) && /<p class="examDocH" data-pi="1">/.test(body), body);
  check('資料：問題文には判例の下線を付けない（cases を渡さない）', !/examCaseRef/.test(rf('examDocsBodyHtml')(['最判平成２年１月１日'], { hl: false, filter: 'all' })));
  check('資料：絞り込んでも段落の番号は元のまま', /data-pi="2"/.test(rf('examDocsBodyHtml')(['〔設問〕', 'よく書けていた答案があった。', '検討が不十分な答案が多かった。'], { hl: true, filter: 'bad' })));
  // 指摘のボタン：年度・科目ごとにまとめ、新しい年度から
  const chips = rf('examRefsMentionChipsHtml')([['shiho', 3, '民法', 4], ['yobi', 5, '民法', 2], ['shiho', 3, '民法', 9], ['shiho', 5, '民法', 1]]);
  eq('指摘のボタン：年度・科目ごと（同じ資料の2回目は×2）', [...chips.matchAll(/🎯 ([^<]+)/g)].map(x => x[1]), ['司法R5 民法', '予備R5 民法', '司法R3 民法']);
  check('指摘のボタン：最初の段落へ飛ぶ・×2', /data-exam="新司法試験" data-year="3" data-subj="民法" data-pi="4"/.test(chips) && /×2/.test(chips), chips);
  eq('指摘の数は資料の数で数える', rf('examRefsDocCount')([['shiho', 3, '民法', 4], ['shiho', 3, '民法', 9], ['yobi', 3, '民法', 1]]), 2);
  // 一覧：既定は百選の目次・判例タブにあるものだけ
  const refsSample = { cases: {
    '最|1975-04-30': { t: '最大判昭和５０年４月３０日', m: [['shiho', 2, '憲法', 1, ''], ['yobi', 4, '憲法', 3, '民集29-4-572']] },
    '最|1980-01-01': { t: '最判昭和５５年１月１日', m: [['shiho', 2, '民法', 1, '']] } }, articles: { 'minpou|709': [['shiho', 1, '民法', 0], ['shiho', 2, '民法', 0]], 'keiho|199': [['shiho', 1, '刑法', 0]] } };
  const rows = rf('examRefsCaseRows')(refsSample, false);
  // 科目は目次の書名 → 判例タブの科目 → 指摘の多い科目の順（ここでは書名に科目が無いので判例タブの「憲法」）
  eq('判例の一覧：百選・判例タブにあるものだけ', rows.map(r => [r.key, r.count, r.subject]), [['最|1975-04-30', 2, '憲法']]);
  eq('判例の一覧：「無い判例も出す」で全部', rf('examRefsCaseRows')(refsSample, true).length, 2);
  eq('条文の一覧：指摘の多い順', rf('examRefsArticleRows')(refsSample).map(r => [r.label, r.count, r.subject]), [['民法709条', 2, '民法'], ['刑法199条', 1, '刑法']]);
  // 画面のつながり（ソースの確認）
  const lawJs = read('js/lawref.js'), html = read('index.html'), sw = read('sw.js'), prJs = read('js/precedent.js'), edJs = read('js/exam-docs.js');
  check('条文タブに「🎯 出題趣旨の条文」', /data-mode="exam">🎯 出題趣旨の条文/.test(html) && /id="lawExamArea"/.test(html));
  check('判例タブに「🎯 出題趣旨の判例」', /id="precedentExamToggleBtn"/.test(html) && /id="precedentExamPane"/.test(html));
  check('条文ポップアップ・その場に展開・全条を読むに指摘を出す', (lawJs.match(/lawrefAppendExamMentions\(/g) || []).length >= 3 && /examRefsMentionsDetailsHtml\(examRefsArticleMentions\(lawReadExamRefs/.test(lawJs));
  check('判例のカードに出題趣旨での指摘', /renderPrecedentExamRefs\(p\)/.test(prJs));
  check('出題趣旨の一覧から開くと、その段落へ送る', /p\[data-pi="' \+ pi \+ '"\]/.test(edJs) && /focusPara: Number\(chip\.dataset\.pi\)/.test(read('js/exam-refs.js')));
  check('索引とスクリプトをオフライン用に先に取っておく', /'\.\/js\/exam-refs\.js'/.test(sw) && /'\.\/data\/exam\/refs\.json'/.test(sw));
  check('index.html で exam-refs.js を exam-docs.js の後に読む', html.indexOf('js/exam-refs.js') > html.indexOf('js/exam-docs.js'));
  check('百選の目次はアプリに入れない（取り込んだものだけ使う）', !fs.existsSync(path.join(ROOT, 'data', 'hyakusen')) && !/百選[^\n]{0,30}\d+事件/.test(read('data/exam/refs.json')));
}

console.log('\n■ 開いた条文の回数・お気に入り（v34.1）');
{
  // 時刻はすべて引数で固定する（どの日に実行しても同じ結果になるように）
  const T = 1700000000000;
  const lw = loadApp(['js/core.js', 'js/lawref.js']);
  lw('localStorage.clear()');
  let notified = 0;
  lw('window').ronshoSyncNotifyChange = () => { notified++; };
  const hist = () => JSON.parse(lw("localStorage.getItem('ronshoLawHistoryV1')") || '{}');
  const dev = lw('lawHistoryDeviceId()');
  check('端末の名札を作り、次も同じものを使う', /^[a-z0-9]{6,32}$/.test(dev) && lw('lawHistoryDeviceId()') === dev);
  lw('lawHistoryRecordOpen("minpou", 709, null, ' + T + ')');
  lw('lawHistoryRecordOpen("minpou", 709, null, ' + (T + 1000) + ')');
  lw('lawHistoryRecordOpen("keiho", 199, null, ' + (T + 2000) + ')');
  lw('lawHistoryRecordOpen("minpou", 121, 2, ' + (T + 3000) + ')');
  const h1 = hist();
  eq('開いた回数を端末ごとに数える', h1['minpou|709'].c[dev], { n: 2, at: T + 1000 });
  eq('枝番号つきの条文も記録する', Object.keys(h1).sort(), ['keiho|199', 'minpou|121-2', 'minpou|709']);
  check('記録が変わるたびに同期に知らせる', notified === 4, notified + '回');
  check('条文の文は記録に入れない（番号と回数だけ）', !/paras|caption|text/.test(JSON.stringify(h1)));
  eq('ほかの端末の回数も足す', lw('lawHistoryCount')({ c: { a: { n: 2, at: T }, b: { n: 3, at: T + 5 } } }), 5);
  eq('最後に開いた時刻は全端末の中でいちばん新しいもの', lw('lawHistoryLastAt')({ c: { a: { n: 2, at: T }, b: { n: 3, at: T + 5 } } }), T + 5);
  eq('消した時刻より前に開いた回数は数えない', lw('lawHistoryCount')({ c: { a: { n: 2, at: T }, b: { n: 3, at: T + 5 } }, del: T + 1 }), 3);
  // 一覧（条番号順のまま。文はこの端末の控えにあれば添える）
  lw('localStorage.setItem("ronshoLawCacheV1", JSON.stringify({ "minpou|709": { at: 1, caption: "（不法行為による損害賠償）", paras: [{ text: "故意又は過失によって…" }] } }))');
  const list = lw('lawrefStockList()');
  eq('一覧は科目→法律→条番号の順', list.map(x => x.key), ['minpou|121-2', 'minpou|709', 'keiho|199']);
  const m709 = list.find(x => x.key === 'minpou|709');
  check('一覧に回数と最後に開いた時刻がつく', m709.count === 2 && m709.lastAt === T + 1000);
  check('文の控えがあれば見出しを添え、無ければ「文がない」とわかる', m709.hasText && m709.caption === '（不法行為による損害賠償）' && list.find(x => x.key === 'keiho|199').hasText === false);
  // ☆
  check('☆を付ける', lw('lawHistoryToggleFav("keiho|199", ' + (T + 4000) + ')') === true && hist()['keiho|199'].fav === true);
  check('☆の変えた時刻を残す（同期で新しい方を採るため）', hist()['keiho|199'].favAt === T + 4000);
  check('☆を外す', lw('lawHistoryToggleFav("keiho|199", ' + (T + 5000) + ')') === false && !hist()['keiho|199'].fav && hist()['keiho|199'].favAt === T + 5000);
  lw('lawHistoryToggleFav("keiho|199", ' + (T + 6000) + ')');
  // 削除
  lw('lawHistoryDelete("minpou|709", ' + (T + 7000) + ')');
  check('削除すると一覧から消え、印（del）だけ残る', !lw('lawrefStockList()').some(x => x.key === 'minpou|709') && hist()['minpou|709'].del === T + 7000 && !!hist()['minpou|709'].c);
  lw('lawHistoryRecordOpen("minpou", 709, null, ' + (T + 8000) + ')');
  eq('削除した後にまた開くと、1回目から数え直す', lw('lawHistoryCount')(hist()['minpou|709']), 1);
  lw('lawHistoryRecordOpen("minpou", 90, null, ' + (T + 8200) + ')');
  lw('lawHistoryDelete("minpou|90", ' + (T + 8500) + ')');
  check('削除の前提：消えている', lw('lawHistoryCount')(hist()['minpou|90']) === 0);
  lw('lawHistoryRecordOpen("minpou", 90, null, ' + (T + 100) + ')');
  check('時計が戻っていても、削除の後に開いた分は数える', lw('lawHistoryCount')(hist()['minpou|90']) === 1 && hist()['minpou|90'].c[dev].at > T + 8500);
  // すべて削除（☆は残す）
  const removed = lw('lawHistoryClearUnfav(' + (T + 9000) + ')');
  eq('すべて削除は☆以外を消す', [...removed].sort(), ['minpou|121-2', 'minpou|709', 'minpou|90']);
  eq('☆の条文は残る（開いた回数が0でも出る）', lw('lawrefStockList()').map(x => x.key + ':' + x.fav), ['keiho|199:true']);
  const favDel = lw('lawHistoryLoad()');
  lw('lawHistoryRemove')(favDel, 'keiho|199', T + 9500);
  check('☆の条文を一覧から削除すると☆も外れる', !favDel['keiho|199'].fav && favDel['keiho|199'].favAt === T + 9500);

  // v34.0までの「開いた条文」（この端末のキャッシュ）を、1回だけ記録に移す
  const mg = loadApp(['js/core.js', 'js/lawref.js']);
  mg('localStorage.clear()');
  mg('localStorage.setItem("ronshoLawCacheV1", JSON.stringify({ "minpou|1": { at: 100 }, "keiho|38": { at: 200 }, "kaishahou|429": { at: 300 } }))');
  mg('localStorage.setItem("ronshoLawHistoryV1", JSON.stringify({ "keiho|38": { del: 500 } }))');
  check('移すのは1回目だけ', mg('lawHistoryMigrateFromCache()') === true && mg('lawHistoryMigrateFromCache()') === false);
  const mh = JSON.parse(mg("localStorage.getItem('ronshoLawHistoryV1')"));
  const mdev = mg('lawHistoryDeviceId()');
  eq('キャッシュの条文を「1回開いた」として記録する', [mh['minpou|1'].c[mdev], mh['kaishahou|429'].c[mdev]], [{ n: 1, at: 100 }, { n: 1, at: 300 }]);
  check('ほかの端末で削除された条文は戻さない', !mh['keiho|38'].c);
  check('移した印は端末ごと（同期しない）', mg("localStorage.getItem('ronshoLawHistoryMigratedV1')") === '1');

  // 画面のつながり（ソースの確認）
  const lawJs = read('js/lawref.js');
  const html = read('index.html');
  check('ポップアップで条文が出たら数える', /body\.innerHTML = lawrefArticleBodyHtml\(data, para\);[\s\S]{0,80}lawHistoryNoteOpened\(lid, num, branch\)/.test(lawJs));
  check('その場に展開で条文が出たら数える', /lawRefInlineBody'\)\.innerHTML = lawrefArticleBodyHtml\(data, para\);\s*lawHistoryNoteOpened\(lid, num, branch\)/.test(lawJs));
  check('取得に失敗したときは数えない', !/catch\(err => \{[^}]*lawHistoryNoteOpened/.test(lawJs));
  check('開いた条文の画面に「お気に入りだけ」のボタン', /id="lawStockFavOnlyBtn"/.test(html));
  check('一覧のカードに☆のボタン', /lawStockFavBtn/.test(lawJs) && /aria-pressed/.test(lawJs));
  check('同期で記録が変わったら一覧だけ描き直す（全条を読むは描き直さない）', /function renderLawHistoryIfShown\(\) \{\s*if \(lawStockMode === 'stock'\) renderLawStockPage\(\);/.test(lawJs)
    && /renderLawHistoryIfShown/.test(read('drive-sync.js')));
}

runAsyncChecks().catch(e => check('非同期のチェックを実行できる', false, e && e.stack)).then(() => {
  console.log('');
  if (failures > 0) {
    console.log('❌ ' + failures + '件のチェックが失敗しました');
    process.exit(1);
  }
  console.log('🎉 全チェック合格');
});
