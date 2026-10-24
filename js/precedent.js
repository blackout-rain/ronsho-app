/* ▼▼▼ 新規追加：判例一覧機能（既存の変数・関数名と一切重複しない名前空間で実装）
   既存の entries / studyLog / manualLog などには一切触れていません。
   保存先も専用のキー 'ronshoPrecedentsV1' のみを使用します。 */
const PRECEDENT_KEY = 'ronshoPrecedentsV1';
let precedents = [];
function loadPrecedents() {
  try {
    const raw = localStorage.getItem(PRECEDENT_KEY);
    precedents = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('判例の読み込みに失敗しました:', e);
    precedents = [];
  }
}
function savePrecedents() {
  try {
    localStorage.setItem(PRECEDENT_KEY, JSON.stringify(precedents));
    if (typeof window !== 'undefined' && typeof window.ronshoSyncNotifyChange === 'function') window.ronshoSyncNotifyChange();
  } catch (e) {
    console.error('判例の保存に失敗しました:', e);
  }
}
loadPrecedents();

// 判例名が未入力の場合は判決日を見出しとして使うため、表示用のタイトルを
// 一箇所にまとめて算出する（一覧・カードの両方から使う）
function precedentDisplayTitle(p) {
  const name = (p.name || '').trim();
  if (name) return name;
  const date = (p.date || '').trim();
  return date || '(タイトル未入力)';
}

let precedentIndex = 0;
let precedentRevealed = false;
let precedentSubjectFilter = 'all';
let precedentEditingId = null;
// カードの表示モード（簡易版／詳細版）
let precedentViewMode = 'simple';

/* 判例の本文欄の定義。詳細版＝百選の紙面の転記、簡易版＝詳細版の要約。
   本文は論証と同じく太字・色付けできるよう、プレーンテキスト（検索・指示文用）
   と装飾付きHTML（key + 'Html'、装飾がある場合のみ）の両方を保存する */
const PRECEDENT_BODY_FIELDS = [
  { key: 'summary', id: 'precedentSummaryInput', label: '事実', section: 'detail', join: true },
  { key: 'holding', id: 'precedentHoldingInput', label: '判旨', section: 'detail', join: true },
  { key: 'commentary', id: 'precedentCommentaryInput', label: '解説', section: 'detail', join: true },
  { key: 'conclusion', id: 'precedentConclusionInput', label: '結論', section: 'detail', join: true },
  { key: 'feature', id: 'precedentFeatureInput', label: '特徴・百選的理由', section: 'detail' },
  { key: 'examMentions', id: 'precedentExamMentionsInput', label: '出題趣旨・採点実感での言及', section: 'detail' },
  { key: 'simpleFacts', id: 'precedentSimpleFactsInput', label: '事実の要約', section: 'simple' },
  { key: 'simpleHolding', id: 'precedentSimpleHoldingInput', label: '判旨の要約', section: 'simple' },
  { key: 'norm', id: 'precedentNormInput', label: '規範', section: 'simple' },
  { key: 'simpleCommentary', id: 'precedentSimpleCommentaryInput', label: '解説の要約', section: 'simple' },
  { key: 'compact', id: 'precedentCompactInput', label: '見直し版', section: 'simple' }
];
function precedentTextToHtml(text) {
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}
// 表示用HTML（装飾付きHTMLがあればそれを、無ければプレーンテキストを使う）
function precedentFieldHtml(p, key) {
  return p[key + 'Html'] || precedentTextToHtml(p[key]);
}
function setPrecedentRichValue(id, text, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html || precedentTextToHtml(text);
}
// 色付けに使える色：論証で使っている色＋判例で使っている色（無ければ基本の2色）
function getPrecedentAllowedColors() {
  const colors = new Set(typeof getExistingBodyColors === 'function' ? getExistingBodyColors() : []);
  precedents.forEach(p => PRECEDENT_BODY_FIELDS.forEach(f => {
    const h = p[f.key + 'Html'];
    if (!h) return;
    for (const m of h.matchAll(/color:\s*(#[0-9A-Fa-f]{3,8})/g)) colors.add(m[1].toLowerCase());
  }));
  if (colors.size === 0) { colors.add('#f92269'); colors.add('#0057e7'); }
  return [...colors];
}
function getPrecedentRichValue(id, allowedColors) {
  const el = document.getElementById(id);
  if (!el) return { text: '', html: '' };
  const html = sanitizeEditedBodyHtml(el, allowedColors).replace(/^(<br>)+|(<br>)+$/g, '');
  const text = precedentTrimPreserveIndent(bodyHtmlToPlainText(html));
  // 太字・色付けが無ければHTMLは保存しない（データを軽く保つ）
  return { text, html: /<(b|span)\b/.test(html) ? html : '' };
}
function renderPrecedentRichToolbar() {
  const bar = document.getElementById('precedentRichToolbar');
  if (!bar) return;
  const swatches = getPrecedentAllowedColors().map(c => '<span class="editColorSwatch" data-color="' + c + '" style="background:' + c + ';" title="' + c + '"></span>').join('');
  bar.innerHTML = '<span class="editBoldBtn" title="太字（Ctrl+B / Cmd+Bで切替）">B</span>' + swatches + '<span class="editColorClearBtn" title="太字・文字色をクリア">色なし</span>';
}

function precedentFilteredList() {
  let list = precedents.slice();
  if (precedentSubjectFilter !== 'all') {
    list = list.filter(p => (p.subject || '未設定') === precedentSubjectFilter);
  }
  // 全文検索（判例名・判決日・科目・各本文欄が対象）
  const q = (precedentSearchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(p => [p.name, p.date, p.subject, p.hyakusen, ...PRECEDENT_BODY_FIELDS.map(f => p[f.key])]
      .some(v => (v || '').toLowerCase().includes(q)));
  }
  return list;
}
let precedentSearchQuery = '';

function renderPrecedentSubjectFilter() {
  const sel = document.getElementById('precedentSubjectFilter');
  if (!sel) return;
  const subjects = [...new Set(precedents.map(p => (p.subject || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const prev = precedentSubjectFilter;
  sel.innerHTML = '<option value="all">科目：すべて（' + precedents.length + '件）</option>'
    + subjects.map(s => {
      const count = precedents.filter(p => (p.subject || '').trim() === s).length;
      return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '（' + count + '件）</option>';
    }).join('');
  sel.value = subjects.includes(prev) || prev === 'all' ? prev : 'all';
  precedentSubjectFilter = sel.value;
}

/* ▼▼▼ 新規追加：AIの要約を貼り付けて自動入力
   ChatGPTやGoogleのAI概要などで作った「判例名（判決日）」の見出し行＋
   「事案」「判旨」「規範」などの箇条書き形式のテキストを解析し、判例名・
   判決日・事案の概要・判旨の各欄に振り分けるだけの補助機能。専用のデータは
   持たず、既存の入力欄に値を流し込むだけなので、保存前に必ず内容を確認・
   修正できる（自動保存はしない） */
const PRECEDENT_PASTE_BASIC_LABELS = ['基本情報'];
const PRECEDENT_PASTE_SUMMARY_LABELS = ['事案の概要', '事案', '事実'];
const PRECEDENT_PASTE_HOLDING_LABELS = ['判旨', '判決要旨', '要旨'];
const PRECEDENT_PASTE_NORM_LABELS = ['規範', '法理'];
const PRECEDENT_PASTE_CONCLUSION_LABELS = ['結論'];
const PRECEDENT_PASTE_FEATURE_LABELS = ['特徴', '百選的理由', 'ポイント'];
const PRECEDENT_PASTE_SUBJECT_LABELS = ['科目', '分野'];
const PRECEDENT_PASTE_EXAM_MENTION_LABELS = ['採点実感', '出題趣旨'];
// 写真から5項目（①事実〜⑤見直し版）を作る形式で追加した見出し
const PRECEDENT_PASTE_COMMENTARY_LABELS = ['解説'];
const PRECEDENT_PASTE_COMPACT_LABELS = ['見直し', 'コンパクト', '要点まとめ'];
const PRECEDENT_PASTE_HYAKUSEN_LABELS = ['百選'];
// 「科目:」のようなラベルが本文中に無いことが多いため、その場合は既存の
// 論証一覧・カレンダー等でも使っている科目名（js/core.jsのSUBJECT_EMOJIの
// キー）が本文中のどこかに出てきていないかを探し、最も早く出てきたものを
// 科目として推測する（見つからなければ空欄のままにする）
const PRECEDENT_PASTE_KNOWN_SUBJECTS = (typeof SUBJECT_EMOJI === 'object' && SUBJECT_EMOJI)
  ? Object.keys(SUBJECT_EMOJI)
  : ['民法', '刑法', '憲法', '商法', '民事訴訟法', '刑事訴訟法', '行政法', '労働法', '実務基礎民事', '実務基礎刑事'];
function inferPrecedentSubject(fullText) {
  let best = '', bestIdx = Infinity;
  PRECEDENT_PASTE_KNOWN_SUBJECTS.forEach(s => {
    const idx = fullText.indexOf(s);
    if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = s; }
  });
  return best;
}
// コピー元サイトの脚注・引用元表記（例："wikipedia+1"）が文末にそのまま
// くっついてくることがあるため、その部分だけ取り除く
function stripPrecedentCitationArtifacts(line) {
  return line.replace(/[A-Za-z][A-Za-z0-9]{1,}\+\d+\s*$/, '').trim();
}
function precedentPasteLabelToField(label) {
  // 簡易版の「事実の要約」「判旨の要約」「解説の要約」は、詳細版の欄より先に判定する
  if (/要約|要点/.test(label)) {
    if (/事実|事案/.test(label)) return { field: 'simpleFacts', prefix: '' };
    if (/判旨/.test(label)) return { field: 'simpleHolding', prefix: '' };
    if (/解説/.test(label)) return { field: 'simpleCommentary', prefix: '' };
  }
  if (PRECEDENT_PASTE_BASIC_LABELS.some(k => label.includes(k))) return { field: 'basic', prefix: '' };
  if (PRECEDENT_PASTE_SUMMARY_LABELS.some(k => label.includes(k))) return { field: 'summary', prefix: '' };
  if (PRECEDENT_PASTE_HOLDING_LABELS.some(k => label.includes(k))) return { field: 'holding', prefix: '' };
  if (PRECEDENT_PASTE_NORM_LABELS.some(k => label.includes(k))) return { field: 'norm', prefix: '' };
  if (PRECEDENT_PASTE_COMMENTARY_LABELS.some(k => label.includes(k))) return { field: 'commentary', prefix: '' };
  if (PRECEDENT_PASTE_COMPACT_LABELS.some(k => label.includes(k))) return { field: 'compact', prefix: '' };
  if (PRECEDENT_PASTE_CONCLUSION_LABELS.some(k => label.includes(k))) return { field: 'conclusion', prefix: '' };
  if (PRECEDENT_PASTE_FEATURE_LABELS.some(k => label.includes(k))) return { field: 'feature', prefix: '' };
  if (PRECEDENT_PASTE_SUBJECT_LABELS.some(k => label.includes(k))) return { field: 'subject', prefix: '' };
  if (PRECEDENT_PASTE_EXAM_MENTION_LABELS.some(k => label.includes(k))) return { field: 'examMentions', prefix: '' };
  // 「特徴（百選的理由）」は上でfeatureに振り分け済みのため、ここに来るのは
  // 「百選：憲法Ⅰ（第8版）81事件」のような掲載情報の行だけ
  if (PRECEDENT_PASTE_HYAKUSEN_LABELS.some(k => label.includes(k))) return { field: 'hyakusen', prefix: '' };
  return null;
}
// 「泉佐野市民会館事件（最判平成7年3月7日）」のように名前と判決日が
// 括弧でひとまとまりになった形式、および「泉佐野市民会館事件・最判平成7年
// 3月7日・民集49巻3号687頁」のように「・」区切りで名前・判決日・出典が
// 並ぶ形式の両方から、判例名と判決日（出典を含む）を取り出す
// 「国・中央労働委員会（根岸病院）事件（東京高判平成19年7月31日〔平成19年(行コ)23号〕）」
// のように名前や出典の中にも括弧が入ることがあるため、行末の閉じ括弧に
// 対応する開き括弧を後ろから数えて探し、最後の括弧書きだけを判決日として扱う
function precedentSplitTrailingParen(line) {
  const trimmed = line.trim();
  if (!/[）)]$/.test(trimmed)) return null;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const c = trimmed[i];
    if (c === '）' || c === ')') depth++;
    else if (c === '（' || c === '(') {
      depth--;
      if (depth === 0) {
        const name = trimmed.slice(0, i).trim();
        const date = trimmed.slice(i + 1, -1).trim();
        if (!name || !date) return null;
        return { name, date };
      }
    }
  }
  return null;
}
function parsePrecedentBasicInfoLine(line) {
  // 「泉佐野市民会館事件（最判平成7年3月7日・民集49巻3号687頁）」のように
  // 括弧内に「・」を含む出典が入ることがあるため、括弧形式を優先して判定し、
  // 括弧が無い場合だけ「・」区切り形式とみなす
  const paren = precedentSplitTrailingParen(line);
  if (paren) return paren;
  if (line.includes('・')) {
    const parts = line.split('・').map(s => s.trim()).filter(Boolean);
    return { name: parts[0] || '', date: parts.slice(1).join('・') };
  }
  return { name: line, date: '' };
}
// 和文の段落は文頭を全角スペース1文字分下げるのが慣習のため、貼り付け
// 内容を自動入力するときに合わせておく。既に全角スペースで始まっている
// 行（貼り付け元で既に字下げ済みの場合）には重ねて付けない
function precedentIndentLine(line) {
  // 「・」などの箇条書きや「Ⅰ」「(1)」で始まる行は字下げしない
  if (/^(?:[・●○■□◆◇▪•*\-]|[①-⑳]|[Ⅰ-Ⅻ]|[(（]?[0-9０-９]+[)）.．、])/.test(line)) return line;
  return line.startsWith('　') ? line : '　' + line;
}
// String.prototype.trim()は全角スペース（U+3000）もJavaScript上「空白文字」
// として先頭・末尾から削ってしまうため、これで事案・判旨・結論欄に保存した
// 段落先頭の字下げ（自動入力・手入力を問わず）が保存時に消えてしまっていた。
// 先頭は半角の空白・改行だけを取り除き、全角スペースの字下げは保持する
function precedentTrimPreserveIndent(s) {
  return s.replace(/^[ \t\r\n]+/, '').replace(/\s+$/, '');
}
function precedentIndentParagraphStart(lines) {
  if (lines.length === 0) return '';
  const arr = lines.slice();
  arr[0] = precedentIndentLine(arr[0]);
  return arr.join('\n');
}
// Claudeアプリなどの返答はMarkdown（「## ①事実」の見出し、「**判旨**：」の
// 太字、```で囲んだコードブロック）で返ってくることが多いため、記号だけを
// 取り除いて通常の「見出し：内容」形式と同じように読めるようにする
function precedentStripMarkdown(line) {
  if (/^```/.test(line)) return '';
  return line.replace(/\*\*/g, '').replace(/^#{1,6}\s*/, '').trim();
}
// 「①事実」「③ 規範」「【④解説】」のように、見出しだけが1行になっている
// 形式を認識する（丸数字・番号・括弧を外した残りが既知の見出しなら切り替える）
// 本文中の短い1行（例：「判旨は妥当」「1. 規範の定立」）を見出しと誤認しない
// よう、丸数字・【】が付いているか、見出し語そのもの（例：「解説」）の場合だけ見出しとみなす
const PRECEDENT_HEADING_EXACT_LABELS = ['事実', '事案', '事案の概要', '判旨', '規範', '解説', '見直し版', '結論', '事実の要約', '判旨の要約', '解説の要約'];
function precedentHeadingOnlyField(line) {
  const m = line.match(/^(【)?\s*([①-⑳]|[0-9０-９]+[.．、)）]?)?\s*([^\s:：【】]{1,12})\s*(】)?$/);
  if (!m) return null;
  const hasMarker = !!(m[1] && m[4]) || /^[①-⑳]$/.test(m[2] || '');
  if (!hasMarker && !PRECEDENT_HEADING_EXACT_LABELS.includes(m[3])) return null;
  const mapped = precedentPasteLabelToField(m[3]);
  return mapped && mapped.field !== 'basic' ? mapped.field : null;
}
// Open Codeなどで複数件まとめて作った場合に、「=====」の行で判例ごとに区切る
function splitPrecedentPasteBlocks(text) {
  return String(text || '').split(/^\s*={3,}\s*$/m).map(b => b.trim()).filter(Boolean);
}
function parsePrecedentPasteText(text) {
  const rawLines = String(text || '').split(/\r?\n/).map(l => precedentStripMarkdown(l.trim())).filter(l => l.length > 0);
  if (rawLines.length === 0) return null;
  const fields = { basic: [], summary: [], holding: [], norm: [], commentary: [], compact: [], hyakusen: [], conclusion: [], feature: [], subject: [], examMentions: [], simpleFacts: [], simpleHolding: [], simpleCommentary: [] };
  let currentField = null;
  // 「【6-1】基本情報」のような番号付き見出し行から始まる形式では、判例名・
  // 判決日は見出しの下の本文（basicフィールド）から取り出すため、1行目を
  // 見出し無しの「判例名（判決日）」として扱わない。見出しが無い旧形式の
  // 場合だけ、1行目をそのまま判例名・判決日の見出し行として扱う
  const firstLineIsSectionHeader = /^【[^】]*】/.test(rawLines[0]);
  let legacyName = '', legacyDate = '';
  let startIdx = 0;
  if (!firstLineIsSectionHeader) {
    const legacy = parsePrecedentBasicInfoLine(rawLines[0]);
    legacyName = legacy.name;
    legacyDate = legacy.date;
    startIdx = 1;
  }
  for (let i = startIdx; i < rawLines.length; i++) {
    const line = stripPrecedentCitationArtifacts(rawLines[i]);
    if (!line) continue;
    // 「【6-2】事案（3〜4行）」のような番号付き見出し行。見出し自体には
    // 内容が無く、次の行から本文が続く形式のため、見出し行だけを認識して
    // 対象フィールドを切り替える（末尾の「（3〜4行）」等の注記は無視する）
    const headingOnly = precedentHeadingOnlyField(line);
    if (headingOnly) {
      currentField = headingOnly;
      continue;
    }
    const sectionHeaderMatch = line.match(/^【[^】]*】\s*(.+)$/);
    if (sectionHeaderMatch) {
      const headerLabel = sectionHeaderMatch[1].replace(/[（(][^）)]*[）)]\s*$/, '').trim();
      const mapped = precedentPasteLabelToField(headerLabel);
      currentField = mapped ? mapped.field : null;
      continue;
    }
    // 箇条書き記号（*・-など）が付いている行はそれを取り除いてからラベルを
    // 探すが、コピー元によっては記号が付かずに貼り付けられることもあるため、
    // 記号の有無にかかわらず「ラベル：内容」の形になっていれば認識する
    const bulletMatch = line.match(/^[*・･\-•▪]\s*(.+)$/);
    const bulletBody = bulletMatch ? bulletMatch[1] : line;
    const labelMatch = bulletBody.match(/^([^\s:：]{1,12})\s*[:：]\s*([\s\S]*)$/);
    if (labelMatch) {
      const mapped = precedentPasteLabelToField(labelMatch[1]);
      if (mapped) {
        currentField = mapped.field;
        const content = (mapped.prefix ? mapped.prefix + ' ' : '') + labelMatch[2].trim();
        if (content) fields[currentField].push(content);
        continue;
      }
    }
    // ラベルの無い続きの行は、直前のフィールドの続きとして扱う
    if (currentField) fields[currentField].push(line);
  }
  let name = legacyName, date = legacyDate;
  if (fields.basic.length > 0) {
    const basicInfo = parsePrecedentBasicInfoLine(fields.basic[0]);
    name = basicInfo.name;
    date = basicInfo.date;
  }
  // 「科目:」のような明示的なラベルがあればそれを優先し、無ければ本文全体
  // から科目名を推測する
  const explicitSubject = fields.subject.join('\n').trim();
  const subject = explicitSubject || inferPrecedentSubject(rawLines.join('\n'));
  return {
    name,
    date,
    subject,
    // 事案・判旨・結論は複数行にまたがっていても1つの段落として貼り付け
    // られることが多いため、段落先頭（1行目）だけを全角スペース1文字分
    // 字下げする（和文の段落インデントの慣習に合わせる）
    summary: precedentIndentParagraphStart(fields.summary),
    holding: precedentIndentParagraphStart(fields.holding),
    conclusion: precedentIndentParagraphStart(fields.conclusion),
    // 特徴・出題趣旨での言及は箇条書き（1行＝1項目）のため、字下げしない
    norm: precedentIndentParagraphStart(fields.norm),
    commentary: precedentIndentParagraphStart(fields.commentary),
    // 見直し版は箇条書き（1行＝1項目）で作るため、字下げしない
    compact: fields.compact.join('\n'),
    simpleFacts: precedentIndentParagraphStart(fields.simpleFacts),
    simpleHolding: precedentIndentParagraphStart(fields.simpleHolding),
    simpleCommentary: precedentIndentParagraphStart(fields.simpleCommentary),
    hyakusen: fields.hyakusen.join(' '),
    feature: fields.feature.join('\n'),
    examMentions: fields.examMentions.join('\n')
  };
}
function initPrecedentPasteFeature() {
  const parseBtn = document.getElementById('precedentPasteParseBtn');
  const pasteInput = document.getElementById('precedentPasteInput');
  if (!parseBtn || !pasteInput) return;
  parseBtn.addEventListener('click', () => {
    const blocks = splitPrecedentPasteBlocks(pasteInput.value);
    if (blocks.length > 1) {
      importPrecedentPasteBlocks(blocks);
      return;
    }
    const parsed = parsePrecedentPasteText(pasteInput.value);
    if (!parsed) {
      alert('貼り付けたテキストから判例名・判決日などを読み取れませんでした。「判例名（判決日）」の見出し行があるか確認してください。');
      return;
    }
    // 簡易版だけを貼り付けた場合など、読み取れなかった項目は入力済みの内容を残す
    if (parsed.name) document.getElementById('precedentNameInput').value = parsed.name;
    if (parsed.date) document.getElementById('precedentDateInput').value = parsed.date;
    if (parsed.subject) document.getElementById('precedentSubjectInput').value = parsed.subject;
    if (parsed.hyakusen) document.getElementById('precedentHyakusenInput').value = parsed.hyakusen;
    PRECEDENT_BODY_FIELDS.forEach(f => { if (parsed[f.key]) setPrecedentRichValue(f.id, parsed[f.key]); });
    status.textContent = '📋 貼り付けた内容から自動入力しました。内容を確認してから保存してください。';
  });
  const promptCopyBtn = document.getElementById('precedentPromptCopyBtn');
  if (promptCopyBtn) promptCopyBtn.addEventListener('click', () => copyPrecedentText(PRECEDENT_PHOTO_PROMPT, '📋 指示文をコピーしました。Claudeアプリに貼り付けて、百選の写真と一緒に送ってください。'));
  const simplePromptCopyBtn = document.getElementById('precedentSimplePromptCopyBtn');
  if (simplePromptCopyBtn) simplePromptCopyBtn.addEventListener('click', () => {
    const promptText = buildPrecedentSimplePrompt();
    if (!promptText) {
      alert('先に詳細版（事実・判旨・解説のいずれか）を入力してください。簡易版は詳細版の内容だけをもとに作ります。');
      return;
    }
    copyPrecedentText(promptText, '📋 簡易版用の指示文（詳細版の本文入り）をコピーしました。Claudeアプリに貼り付けて送ってください。');
  });
  PRECEDENT_BODY_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    el.addEventListener('paste', (e) => handlePrecedentRichPaste(e, !!f.join));
    el.addEventListener('keydown', (e) => { if (typeof handleBodyEditorKeydown === 'function') handleBodyEditorKeydown(e); });
  });
  const toolbar = document.getElementById('precedentRichToolbar');
  if (toolbar) {
    // ボタンを押したときに本文欄の選択範囲が外れないようにする
    toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    toolbar.addEventListener('click', (e) => {
      if (e.target.closest('.editBoldBtn')) applyBodyEditorBold();
      else if (e.target.closest('.editColorSwatch')) applyBodyEditorColor(e.target.closest('.editColorSwatch').dataset.color);
      else if (e.target.closest('.editColorClearBtn')) document.execCommand('removeFormat');
    });
  }
}

/* iPhoneの「テキスト認識表示」などで紙面から文字をコピーすると、紙面の
   行の終わりごとに改行が入るため、文章欄への貼り付け時につなげる。
   見直し版・特徴など箇条書きで書く欄は対象外 */
// 段落・項目の始まりとして改行を残す行頭（箇条書き記号・丸数字・ローマ数字・番号）
const PRECEDENT_LINE_START_KEEP_RE = /^(?:[・●○■□◆◇▪•*\-]|[①-⑳]|[Ⅰ-Ⅻ]|[(（]?[0-9０-９]+[)）.．、]|[(（][ア-ンa-z][)）])/;
function joinPrecedentWrappedLines(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  // 紙面の1行の長さ（最長の行）を基準に、それより短く「。」で終わる行を
  // 段落の終わりとみなす。行末にたまたま「。」が来た満杯の行はつなげる
  const fullLen = Math.max(0, ...lines.map(l => l.length));
  const endsParagraph = (lastLine) => /[。．][」』）)]*$/.test(lastLine) && lastLine.length < fullLen * 0.85;
  const paragraphs = [];
  let current = '';
  let lastLine = '';
  lines.forEach(line => {
    if (!line) {
      // 空行は段落の区切りとして扱う
      if (current) { paragraphs.push(current); current = ''; }
      lastLine = '';
      return;
    }
    if (current && (endsParagraph(lastLine) || PRECEDENT_LINE_START_KEEP_RE.test(line))) {
      paragraphs.push(current);
      current = line;
    } else {
      current += line;
    }
    lastLine = line;
  });
  if (current) paragraphs.push(current);
  // 文字認識で日本語の文字の間に入った余計な半角スペースを取り除く
  // 和文の段落は文頭を全角スペース1文字分下げる（箇条書き・Ⅰなどで始まる段落は除く）。
  // 文字認識で日本語の文字の前後に入った余計な半角スペースは取り除く
  return paragraphs
    .map(p => p.replace(/([^\x00-\x7F])[ \t]+/g, '$1').replace(/[ \t]+(?=[^\x00-\x7F])/g, ''))
    .map(p => PRECEDENT_LINE_START_KEEP_RE.test(p) ? p : precedentIndentLine(p))
    .join('\n');
}
// 本文欄への貼り付けは、コピー元の書式を持ち込まないよう常にプレーンテキストにする。
// 詳細版の文章欄では、紙面の行の終わりで入った改行もつなげる
function handlePrecedentRichPaste(e, joinLines) {
  const clip = e.clipboardData || window.clipboardData;
  if (!clip) return;
  const raw = clip.getData('text');
  if (!raw) return;
  e.preventDefault();
  let text = joinLines && /\n/.test(raw) ? joinPrecedentWrappedLines(raw) : raw.replace(/\r\n?/g, '\n');
  // 文の途中に貼り付けた場合は、先頭に字下げを付けない
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const before = r.startContainer.nodeType === 3 ? r.startContainer.nodeValue.slice(0, r.startOffset) : '';
    if (before && !/\n$/.test(before)) text = text.replace(/^　/, '');
  }
  document.execCommand('insertHTML', false, precedentTextToHtml(text));
}
// 複数件をまとめて貼り付けた場合は、フォームを経由せず確認ダイアログの後に
// まとめて登録する（1件ずつ直したい場合は登録後に✏️から編集できる）
function importPrecedentPasteBlocks(blocks) {
  const parsedList = blocks.map(b => parsePrecedentPasteText(b)).filter(p => p && (p.name || p.date));
  if (parsedList.length === 0) {
    alert('貼り付けたテキストから判例を読み取れませんでした。判例ごとに「判例名（判決日）」の見出し行があるか確認してください。');
    return;
  }
  const skipped = blocks.length - parsedList.length;
  const names = parsedList.slice(0, 10).map(p => '・' + (p.name || p.date)).join('\n') + (parsedList.length > 10 ? '\n…ほか' + (parsedList.length - 10) + '件' : '');
  if (!confirm(parsedList.length + '件の判例をまとめて登録しますか？' + (skipped ? '（読み取れなかった' + skipped + '件は除きます）' : '') + '\n\n' + names)) return;
  const now = new Date().toISOString();
  parsedList.forEach(p => {
    precedents.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      ...p,
      createdAt: now
    });
  });
  savePrecedents();
  const pasteInputEl = document.getElementById('precedentPasteInput');
  if (pasteInputEl) pasteInputEl.value = '';
  precedentRevealed = false;
  renderPrecedentPage();
  status.textContent = '⚖️ ' + parsedList.length + '件の判例をまとめて登録しました。';
}

/* 写真から詳細版（百選の紙面の転記）を作るための指示文。Claudeアプリ（Proプランの
   範囲内）やOpen Codeに貼り付けて使う。出力形式はparsePrecedentPasteText()がそのまま
   読める形に揃えてある。私的な復習用に限り、データは公開リポジトリには置かない */
const PRECEDENT_PHOTO_PROMPT = [
  'あなたは司法試験受験生の学習を手伝うアシスタントです。',
  '私が自分で購入した判例百選のページの写真を送ります。私個人の復習ノートに保存するためのもので、他人と共有・公開はしません。写真を読み取り、次の形式だけで出力してください（前置き・後書き・Markdownの記号は不要です）。',
  '',
  '事件番号　見出し－事件名（裁判所・判決日〔事件番号〕）',
  '（例：152　義務的団交事項－根岸病院事件（東京高判平成19年7月31日〔平成19年(行コ)23号〕））',
  '科目：（憲法・行政法・民法・商法・民事訴訟法・刑法・刑事訴訟法・労働法のいずれか）',
  '百選：（書名と版が写真から分かれば「労働判例百選（第10版）152事件」のように書く。分からなければ「152事件」のように事件番号だけ書き、推測や注記は書かない）',
  '事実：',
  '（紙面の「事実」欄を一字一句そのまま書き写す。要約・言い換え・修正・省略をしない。段落の区切りも紙面どおり）',
  '判旨：',
  '（紙面の「判旨」欄を一字一句そのまま書き写す。「Ⅰ」「Ⅱ」などの区分や「 」もそのまま）',
  '解説：',
  '（紙面の「解説」欄を一字一句そのまま書き写す。要約・言い換え・修正・省略をしない）',
  '',
  'ルール：',
  '・書き写すだけで、自分の言葉に直さない。誤字に見える箇所も紙面どおりにする',
  '・写真の端で切れている、または写っていない部分は推測で補わず、その箇所に「（読み取り不可）」とだけ書く',
  '・事実・判旨・解説が複数の写真にまたがっている場合は、写真の順につなげて1つの欄にまとめる',
  '・複数の判例をまとめて送った場合は、判例ごとに「=====」だけの行で区切る'
].join('\n');
// 簡易版は必ず詳細版だけを情報源にするため、編集中の詳細版の本文を指示文に埋め込む
function buildPrecedentSimplePrompt() {
  const allowed = getPrecedentAllowedColors();
  const detail = PRECEDENT_BODY_FIELDS.filter(f => f.section === 'detail')
    .map(f => ({ label: f.label, text: getPrecedentRichValue(f.id, new Set(allowed)).text }))
    .filter(x => x.text);
  if (!detail.some(x => ['事実', '判旨', '解説'].includes(x.label))) return '';
  const name = document.getElementById('precedentNameInput').value.trim();
  const date = document.getElementById('precedentDateInput').value.trim();
  return [
    'あなたは司法試験受験生の学習を手伝うアシスタントです。',
    '下の【詳細版】は、私が判例百選の紙面を書き写した個人用の復習ノートです。これを要約して【簡易版】を作ってください。',
    '',
    'ルール：',
    '・情報源は下の【詳細版】の文章だけにする。詳細版に書かれていないこと（他の判例・学説・一般知識など）は補わない',
    '・詳細版の内容と食い違うことを書かない',
    '・次の形式だけで出力する（前置き・後書き・Markdownの記号は不要）',
    '',
    '【簡易版】',
    '事実の要約：',
    '（当事者・時系列・争点が分かるように3〜5行）',
    '判旨の要約：',
    '（結論と理由づけの骨格を3〜5行。キーワードになる判旨の文言はそのまま残す）',
    '規範：',
    '（答案にそのまま書ける形の規範・判断枠組み。考慮要素があれば「・」で列挙）',
    '解説の要約：',
    '（判例の位置づけ・射程・注意点を「・」で3〜5項目）',
    '見直し版：',
    '・（試験直前に30秒で読める3〜5行の箇条書き。事案のキーワード→規範→結論）',
    '',
    '【詳細版】',
    (name || date) ? name + (date ? '（' + date + '）' : '') : '',
    ...detail.map(x => x.label + '：\n' + x.text)
  ].join('\n');
}
function copyPrecedentText(text, doneMessage) {
  const done = () => { status.textContent = doneMessage; };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) done(); else prompt('コピーできなかったため、下の文章を手動でコピーしてください。', text);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}
/* ▲▲▲ 新規追加：AIの要約を貼り付けて自動入力 ここまで ▲▲▲ */

function resetPrecedentForm() {
  precedentEditingId = null;
  document.getElementById('precedentNameInput').value = '';
  document.getElementById('precedentDateInput').value = '';
  document.getElementById('precedentSubjectInput').value = '';
  document.getElementById('precedentHyakusenInput').value = '';
  PRECEDENT_BODY_FIELDS.forEach(f => setPrecedentRichValue(f.id, ''));
  const pasteInputEl = document.getElementById('precedentPasteInput');
  if (pasteInputEl) pasteInputEl.value = '';
  document.getElementById('precedentSaveBtn').textContent = '保存する';
  document.getElementById('precedentCancelEditBtn').textContent = 'キャンセル';
}

function openPrecedentFormForEdit(p) {
  const form = document.getElementById('precedentForm');
  setPrecedentFormOpen(true);
  precedentEditingId = p.id;
  document.getElementById('precedentNameInput').value = p.name || '';
  document.getElementById('precedentDateInput').value = p.date || '';
  document.getElementById('precedentSubjectInput').value = p.subject || '';
  document.getElementById('precedentHyakusenInput').value = p.hyakusen || '';
  PRECEDENT_BODY_FIELDS.forEach(f => setPrecedentRichValue(f.id, p[f.key], p[f.key + 'Html']));
  renderPrecedentRichToolbar();
  document.getElementById('precedentSaveBtn').textContent = '更新する';
  document.getElementById('precedentCancelEditBtn').textContent = '編集をやめる';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// カードの科目・判決日・百選・タイトル部分（閲覧画面とプレビューで共通）
function buildPrecedentHeaderHtml(p) {
  return '<div class="quizMeta">' + escapeHtml(p.subject || '未設定') + (p.date && p.name ? ' ｜ ' + escapeHtml(p.date) : '') + (p.hyakusen ? ' ｜ 百選 ' + escapeHtml(p.hyakusen) : '') + '</div>'
    + '<div class="quizTitle">' + escapeHtml(precedentDisplayTitle(p)) + '</div>';
}
// 簡易版／詳細版のタブと本文（閲覧画面とプレビューで共通）
function buildPrecedentViewBodyHtml(p) {
  let html = '';
  const hasSimple = PRECEDENT_BODY_FIELDS.some(f => f.section === 'simple' && p[f.key]);
  html += '<div class="precedentViewTabs">'
    + '<span class="precedentViewTab' + (precedentViewMode === 'simple' ? ' active' : '') + '" data-mode="simple">📝 簡易版</span>'
    + '<span class="precedentViewTab' + (precedentViewMode === 'detail' ? ' active' : '') + '" data-mode="detail">📖 詳細版</span>'
    + '</div>';
  if (precedentViewMode === 'simple' && !hasSimple) {
    html += '<div class="quizEmpty">簡易版はまだありません。✏️で編集画面を開き、「詳細版から簡易版を作る指示文をコピー」から作れます。</div>';
    return html;
  }
  // 見直し版は試験直前に流し読みする用のため、簡易版の一番上に出す
  const order = precedentViewMode === 'simple'
    ? ['compact', 'simpleFacts', 'simpleHolding', 'norm', 'simpleCommentary']
    : ['summary', 'holding', 'commentary', 'conclusion', 'feature', 'examMentions'];
  order.forEach(key => {
    const f = PRECEDENT_BODY_FIELDS.find(x => x.key === key);
    // 事実・判旨は詳細版の基本項目なので未入力でも枠を出し、それ以外は入力済みのときだけ表示する
    if (!p[key] && !(key === 'summary' || key === 'holding')) return;
    html += '<div class="quizBody"><strong>【' + f.label + '】</strong><br>' + (p[key] ? precedentFieldHtml(p, key) : '（未入力）') + '</div>';
  });
  return html;
}
// 編集フォームの入力内容を、保存するときと同じ形の判例データにまとめる
function collectPrecedentFormValues() {
  const values = {
    name: document.getElementById('precedentNameInput').value.trim(),
    date: document.getElementById('precedentDateInput').value.trim(),
    subject: document.getElementById('precedentSubjectInput').value.trim(),
    hyakusen: document.getElementById('precedentHyakusenInput').value.trim()
  };
  const allowedColors = new Set(getPrecedentAllowedColors());
  PRECEDENT_BODY_FIELDS.forEach(f => {
    const v = getPrecedentRichValue(f.id, allowedColors);
    values[f.key] = v.text;
    // 装飾が無くなった欄は古いHTMLが残らないよう、いったん空で上書きする（保存時に削除）
    values[f.key + 'Html'] = v.html;
  });
  return values;
}
// 更新前に、閲覧画面でどう表示されるかを確認する
function renderPrecedentPreview() {
  const area = document.getElementById('precedentPreviewArea');
  if (!area) return;
  const p = collectPrecedentFormValues();
  area.innerHTML = '<div class="precedentPreviewLabel">👁 プレビュー（まだ保存されていません）</div>'
    + '<div class="quizCard">' + buildPrecedentHeaderHtml(p) + buildPrecedentViewBodyHtml(p) + '</div>';
  area.querySelectorAll('.precedentViewTab').forEach(tab => tab.addEventListener('click', () => {
    precedentViewMode = tab.dataset.mode;
    renderPrecedentPreview();
  }));
}
// 編集フォームの開閉。編集中は下の閲覧画面を隠し、見ている内容が混ざらないようにする
function setPrecedentFormOpen(open) {
  ['precedentPasteBlock', 'precedentForm', 'precedentFormBody', 'precedentFormActions'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('pastLogFormOpen', open);
  });
  ['precedentProgress', 'precedentArea'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = open ? 'none' : '';
  });
  const preview = document.getElementById('precedentPreviewArea');
  if (preview) preview.innerHTML = '';
  const addToggleBtn = document.getElementById('precedentAddToggleBtn');
  if (addToggleBtn) addToggleBtn.textContent = open ? '－ 閉じる' : '＋ 判例を追加';
  if (open) renderPrecedentRichToolbar();
}

function renderPrecedentPage() {
  renderPrecedentSubjectFilter();
  const progressEl = document.getElementById('precedentProgress');
  const area = document.getElementById('precedentArea');
  if (!area) return;
  const list = precedentFilteredList();
  if (precedentIndex >= list.length) precedentIndex = Math.max(0, list.length - 1);

  if (precedents.length === 0) {
    if (progressEl) progressEl.textContent = '';
    area.innerHTML = '<div class="quizEmpty">まだ判例が登録されていません。「＋ 判例を追加」から登録してください。</div>';
    return;
  }
  if (list.length === 0) {
    if (progressEl) progressEl.textContent = '';
    area.innerHTML = '<div class="quizEmpty">この科目に該当する判例はありません。</div>';
    return;
  }
  if (progressEl) progressEl.textContent = (precedentIndex + 1) + ' / ' + list.length + '件';

  const p = list[precedentIndex];
  let html = '<div class="quizCard">';
  html += '<div class="quizCardTools">'
    + '<span class="quizEditBtn" id="precedentEditBtn" title="内容を編集">✏️</span>'
    + '<span class="quizDeleteBtn" id="precedentDeleteBtn" title="この判例を削除">🗑️</span>'
    + '</div>';
  html += '<div class="quizNavRow">'
    + '<button type="button" class="quizNavBtn" id="precedentPrevBtn"' + (precedentIndex === 0 ? ' disabled' : '') + '>◀ 前の判例</button>'
    + '<button type="button" class="quizNavBtn" id="precedentNextBtn"' + (precedentIndex >= list.length - 1 ? ' disabled' : '') + '>次の判例 ▶</button>'
    + '</div>';
  html += buildPrecedentHeaderHtml(p);
  if (!precedentRevealed) {
    html += '<div class="quizShowBtn" id="precedentShowBtn">📖 内容を表示</div>';
  } else {
    html += buildPrecedentViewBodyHtml(p);
  }
  html += '</div>';
  area.innerHTML = html;

  area.querySelectorAll('.precedentViewTab').forEach(tab => tab.addEventListener('click', () => {
    precedentViewMode = tab.dataset.mode;
    renderPrecedentPage();
  }));
  const showBtn = document.getElementById('precedentShowBtn');
  if (showBtn) showBtn.addEventListener('click', () => { precedentRevealed = true; renderPrecedentPage(); });
  const prevBtn = document.getElementById('precedentPrevBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (precedentIndex <= 0) return;
    precedentIndex--;
    precedentRevealed = false;
    renderPrecedentPage();
  });
  const nextBtn = document.getElementById('precedentNextBtn');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (precedentIndex >= list.length - 1) return;
    precedentIndex++;
    precedentRevealed = false;
    renderPrecedentPage();
  });
  const editBtn = document.getElementById('precedentEditBtn');
  if (editBtn) editBtn.addEventListener('click', () => openPrecedentFormForEdit(p));
  const deleteBtn = document.getElementById('precedentDeleteBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    if (!confirm('「' + precedentDisplayTitle(p) + '」を削除しますか？（元に戻せません）')) return;
    precedents = precedents.filter(x => x.id !== p.id);
    savePrecedents();
    precedentRevealed = false;
    renderPrecedentPage();
    status.textContent = '🗑️ 「' + precedentDisplayTitle(p) + '」を削除しました。';
  });
}

function initPrecedentFeature() {
  const addToggleBtn = document.getElementById('precedentAddToggleBtn');
  const form = document.getElementById('precedentForm');
  const saveBtn = document.getElementById('precedentSaveBtn');
  const cancelEditBtn = document.getElementById('precedentCancelEditBtn');
  const subjectFilterSel = document.getElementById('precedentSubjectFilter');
  if (!addToggleBtn || !form || !saveBtn) return;

  addToggleBtn.addEventListener('click', () => {
    const open = !form.classList.contains('pastLogFormOpen');
    setPrecedentFormOpen(open);
    if (!open) resetPrecedentForm();
  });

  saveBtn.addEventListener('click', () => {
    const values = collectPrecedentFormValues();
    const { name, date } = values;
    if (!date && !name) {
      alert('判例名か判決日のどちらかは入力してください。');
      return;
    }
    if (precedentEditingId) {
      const idx = precedents.findIndex(p => p.id === precedentEditingId);
      if (idx !== -1) {
        precedents[idx] = { ...precedents[idx], ...values };
        // 装飾を外した欄の空のHTMLは残さない
        PRECEDENT_BODY_FIELDS.forEach(f => { if (!precedents[idx][f.key + 'Html']) delete precedents[idx][f.key + 'Html']; });
      }
      status.textContent = '✏️ 判例を更新しました。';
    } else {
      precedents.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        ...values,
        createdAt: new Date().toISOString()
      });
      const added = precedents[precedents.length - 1];
      PRECEDENT_BODY_FIELDS.forEach(f => { if (!added[f.key + 'Html']) delete added[f.key + 'Html']; });
      status.textContent = '⚖️ 判例を追加しました。';
    }
    savePrecedents();
    resetPrecedentForm();
    setPrecedentFormOpen(false);
    precedentRevealed = false;
    renderPrecedentPage();
  });

  cancelEditBtn.addEventListener('click', () => {
    resetPrecedentForm();
    setPrecedentFormOpen(false);
    renderPrecedentPage();
  });
  const previewBtn = document.getElementById('precedentPreviewBtn');
  if (previewBtn) previewBtn.addEventListener('click', () => {
    renderPrecedentPreview();
    const preview = document.getElementById('precedentPreviewArea');
    if (preview) preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (subjectFilterSel) subjectFilterSel.addEventListener('change', () => {
    precedentSubjectFilter = subjectFilterSel.value;
    precedentIndex = 0;
    precedentRevealed = false;
    renderPrecedentPage();
  });

  const searchInput = document.getElementById('precedentSearchInput');
  if (searchInput) searchInput.addEventListener('input', () => {
    precedentSearchQuery = searchInput.value;
    precedentIndex = 0;
    precedentRevealed = false;
    renderPrecedentPage();
  });

  renderPrecedentPage();
}
initPrecedentFeature();
initPrecedentPasteFeature();
/* ▲▲▲ 新規追加：判例一覧機能 ここまで ▲▲▲ */
