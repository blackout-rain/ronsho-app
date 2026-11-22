#!/usr/bin/env node
// 出題趣旨で指摘された条文・判例の索引（data/exam/refs.json）を作る。
// data/exam/*.json を作り直したら、続けてこれを実行する：
//   node tools/exam-fetch/build-refs.js
// 読み取りの決まりはアプリと同じ js/lawref.js・js/exam-refs.js をそのまま使う
// （tools/unit-test/run.js でも作り直して、入っている索引と一致するかを確かめる）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

// アプリのスクリプトを読み込むための最小限の入れ物（DOMは使わない）
function loadRefsFunctions() {
  const anything = new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : p === Symbol.iterator ? function* () {} : p === Symbol.toPrimitive ? () => '' : anything),
    apply: () => anything, construct: () => anything, set: () => true
  });
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const ctx = {
    console, Math, Date, JSON, Promise, setTimeout: () => 0, clearTimeout: () => {},
    localStorage: storage, navigator: { onLine: true },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    fetch: () => Promise.reject(new Error('no fetch')), status: anything
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['js/lawref.js', 'js/exam-refs.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}
function readExamFiles(dir) {
  return fs.readdirSync(dir).filter(f => /^(shiho|yobi)-R\d+\.json$/.test(f)).sort().map(f => {
    const m = /^(shiho|yobi)-R(\d+)\.json$/.exec(f);
    return { code: m[1], year: Number(m[2]), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
  });
}
function buildRefs() {
  const ctx = loadRefsFunctions();
  const files = readExamFiles(path.join(ROOT, 'data', 'exam'));
  return JSON.parse(JSON.stringify(ctx.examRefsBuildIndex(files)));
}
module.exports = { buildRefs, loadRefsFunctions };

if (require.main === module) {
  const refs = buildRefs();
  const out = path.join(ROOT, 'data', 'exam', 'refs.json');
  fs.writeFileSync(out, JSON.stringify(refs) + '\n');
  const nA = Object.keys(refs.articles).length, nC = Object.keys(refs.cases).length;
  console.log('refs.json：条文 ' + nA + '件・判例 ' + nC + '件（' + fs.statSync(out).size + 'バイト）');
}
