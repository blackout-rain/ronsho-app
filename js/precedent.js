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

function precedentFilteredList() {
  let list = precedents.slice();
  if (precedentSubjectFilter !== 'all') {
    list = list.filter(p => (p.subject || '未設定') === precedentSubjectFilter);
  }
  // 全文検索（判例名・判決日・科目・各本文欄が対象）
  const q = (precedentSearchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(p => [p.name, p.date, p.subject, p.hyakusen, p.summary, p.holding, p.norm, p.commentary, p.compact, p.conclusion, p.feature, p.examMentions]
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
const PRECEDENT_HEADING_EXACT_LABELS = ['事実', '事案', '事案の概要', '判旨', '規範', '解説', '見直し版', '結論'];
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
  const fields = { basic: [], summary: [], holding: [], norm: [], commentary: [], compact: [], hyakusen: [], conclusion: [], feature: [], subject: [], examMentions: [] };
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
    document.getElementById('precedentNameInput').value = parsed.name;
    document.getElementById('precedentDateInput').value = parsed.date;
    if (parsed.subject) document.getElementById('precedentSubjectInput').value = parsed.subject;
    if (parsed.summary) document.getElementById('precedentSummaryInput').value = parsed.summary;
    if (parsed.holding) document.getElementById('precedentHoldingInput').value = parsed.holding;
    if (parsed.norm) document.getElementById('precedentNormInput').value = parsed.norm;
    if (parsed.commentary) document.getElementById('precedentCommentaryInput').value = parsed.commentary;
    if (parsed.compact) document.getElementById('precedentCompactInput').value = parsed.compact;
    if (parsed.hyakusen) document.getElementById('precedentHyakusenInput').value = parsed.hyakusen;
    if (parsed.conclusion) document.getElementById('precedentConclusionInput').value = parsed.conclusion;
    if (parsed.feature) document.getElementById('precedentFeatureInput').value = parsed.feature;
    if (parsed.examMentions) document.getElementById('precedentExamMentionsInput').value = parsed.examMentions;
    status.textContent = '📋 貼り付けた内容から自動入力しました。内容を確認してから保存してください。';
  });
  const promptCopyBtn = document.getElementById('precedentPromptCopyBtn');
  if (promptCopyBtn) promptCopyBtn.addEventListener('click', () => copyPrecedentPromptText());
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

/* 写真から5項目を作るための指示文。Claudeアプリ（Proプランの範囲内）や
   Open Codeに貼り付けて使う。出力形式はparsePrecedentPasteText()がそのまま
   読める形に揃えてある。著作権に配慮し、解説は丸写しせず要約させる */
const PRECEDENT_PHOTO_PROMPT = [
  'あなたは司法試験受験生の学習を手伝うアシスタントです。',
  '私が自分で購入した判例百選のページの写真を送ります。私個人の復習ノートに保存するためのもので、他人と共有・公開はしません。写真を読み取り、次の形式だけで出力してください（前置き・後書き・Markdownの記号は不要です）。',
  '',
  '事件番号　見出し－事件名（裁判所・判決日〔事件番号〕）',
  '（例：152　義務的団交事項－根岸病院事件（東京高判平成19年7月31日〔平成19年(行コ)23号〕））',
  '科目：（憲法・行政法・民法・商法・民事訴訟法・刑法・刑事訴訟法・労働法のいずれか）',
  '百選：（書名と版が写真から分かれば「労働判例百選（第10版）152事件」のように書く。分からなければ「152事件」のように事件番号だけ書き、推測や注記は書かない）',
  '①事実：',
  '（紙面の「事実」欄を一字一句そのまま書き写す。要約・言い換え・修正・省略をしない。段落の区切りも紙面どおり）',
  '②判旨：',
  '（紙面の「判旨」欄を一字一句そのまま書き写す。「Ⅰ」「Ⅱ」などの区分や「 」もそのまま）',
  '③規範：',
  '（判旨から、答案にそのまま書ける形の規範・判断枠組みを抜き出す。考慮要素があれば列挙）',
  '④解説：',
  '（紙面の「解説」欄を一字一句そのまま書き写す。要約・言い換え・修正・省略をしない）',
  '⑤見直し版：',
  '・（試験直前に30秒で読める3〜5行の箇条書き。事案のキーワード→規範→結論）',
  '',
  'ルール：',
  '・①②④は書き写すだけで、自分の言葉に直さない。誤字に見える箇所も紙面どおりにする',
  '・写真の端で切れている、または写っていない部分は推測で補わず、その箇所に「（読み取り不可）」とだけ書く',
  '・事実・判旨・解説が複数の写真にまたがっている場合は、写真の順につなげて1つの欄にまとめる',
  '・複数の判例をまとめて送った場合は、判例ごとに「=====」だけの行で区切る'
].join('\n');
function copyPrecedentPromptText() {
  const done = () => { status.textContent = '📋 指示文をコピーしました。Claudeアプリに貼り付けて、百選の写真と一緒に送ってください。'; };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = PRECEDENT_PHOTO_PROMPT;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (ok) done(); else prompt('コピーできなかったため、下の文章を手動でコピーしてください。', PRECEDENT_PHOTO_PROMPT);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(PRECEDENT_PHOTO_PROMPT).then(done, fallback);
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
  document.getElementById('precedentSummaryInput').value = '';
  document.getElementById('precedentHoldingInput').value = '';
  document.getElementById('precedentNormInput').value = '';
  document.getElementById('precedentCommentaryInput').value = '';
  document.getElementById('precedentCompactInput').value = '';
  document.getElementById('precedentHyakusenInput').value = '';
  document.getElementById('precedentConclusionInput').value = '';
  document.getElementById('precedentFeatureInput').value = '';
  document.getElementById('precedentExamMentionsInput').value = '';
  const pasteInputEl = document.getElementById('precedentPasteInput');
  if (pasteInputEl) pasteInputEl.value = '';
  document.getElementById('precedentSaveBtn').textContent = '保存する';
  document.getElementById('precedentCancelEditBtn').style.display = 'none';
}

function openPrecedentFormForEdit(p) {
  const form = document.getElementById('precedentForm');
  const addToggleBtn = document.getElementById('precedentAddToggleBtn');
  const pasteBlock = document.getElementById('precedentPasteBlock');
  if (form && !form.classList.contains('pastLogFormOpen')) {
    if (pasteBlock) pasteBlock.classList.add('pastLogFormOpen');
    form.classList.add('pastLogFormOpen');
    document.getElementById('precedentFormBody').classList.add('pastLogFormOpen');
    document.getElementById('precedentFormActions').classList.add('pastLogFormOpen');
    if (addToggleBtn) addToggleBtn.textContent = '－ 閉じる';
  }
  precedentEditingId = p.id;
  document.getElementById('precedentNameInput').value = p.name || '';
  document.getElementById('precedentDateInput').value = p.date || '';
  document.getElementById('precedentSubjectInput').value = p.subject || '';
  document.getElementById('precedentSummaryInput').value = p.summary || '';
  document.getElementById('precedentHoldingInput').value = p.holding || '';
  document.getElementById('precedentNormInput').value = p.norm || '';
  document.getElementById('precedentCommentaryInput').value = p.commentary || '';
  document.getElementById('precedentCompactInput').value = p.compact || '';
  document.getElementById('precedentHyakusenInput').value = p.hyakusen || '';
  document.getElementById('precedentConclusionInput').value = p.conclusion || '';
  document.getElementById('precedentFeatureInput').value = p.feature || '';
  document.getElementById('precedentExamMentionsInput').value = p.examMentions || '';
  document.getElementById('precedentSaveBtn').textContent = '更新する';
  document.getElementById('precedentCancelEditBtn').style.display = 'inline-block';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  html += '<div class="quizMeta">' + escapeHtml(p.subject || '未設定') + (p.date && p.name ? ' ｜ ' + escapeHtml(p.date) : '') + (p.hyakusen ? ' ｜ 百選 ' + escapeHtml(p.hyakusen) : '') + '</div>';
  html += '<div class="quizTitle">' + escapeHtml(precedentDisplayTitle(p)) + '</div>';
  if (!precedentRevealed) {
    html += '<div class="quizShowBtn" id="precedentShowBtn">📖 内容を表示</div>';
  } else {
    // 見直し版は試験直前に流し読みする用のため、入力済みなら一番上に出す
    if (p.compact) html += '<div class="quizBody"><strong>【⑤見直し版】</strong><br>' + escapeHtml(p.compact).replace(/\n/g, '<br>') + '</div>';
    html += '<div class="quizBody"><strong>【①事実】</strong><br>' + (escapeHtml(p.summary || '（未入力）').replace(/\n/g, '<br>')) + '</div>';
    html += '<div class="quizBody"><strong>【②判旨】</strong><br>' + (escapeHtml(p.holding || '（未入力）').replace(/\n/g, '<br>')) + '</div>';
    // 規範・解説は5項目形式で追加した欄のため、既存の判例では入力済みのときだけ表示する
    if (p.norm) html += '<div class="quizBody"><strong>【③規範】</strong><br>' + escapeHtml(p.norm).replace(/\n/g, '<br>') + '</div>';
    if (p.commentary) html += '<div class="quizBody"><strong>【④解説】</strong><br>' + escapeHtml(p.commentary).replace(/\n/g, '<br>') + '</div>';
    // 結論・特徴（百選的理由）は任意項目のため、入力済みのときだけ表示する
    // （既存の判例には無い項目なので、常に表示すると「（未入力）」だらけになってしまう）
    if (p.conclusion) html += '<div class="quizBody"><strong>【結論】</strong><br>' + escapeHtml(p.conclusion).replace(/\n/g, '<br>') + '</div>';
    if (p.feature) html += '<div class="quizBody"><strong>【特徴・百選的理由】</strong><br>' + escapeHtml(p.feature).replace(/\n/g, '<br>') + '</div>';
    if (p.examMentions) html += '<div class="quizBody"><strong>【出題趣旨・採点実感での言及】</strong><br>' + escapeHtml(p.examMentions).replace(/\n/g, '<br>') + '</div>';
  }
  html += '</div>';
  area.innerHTML = html;

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
  const formBody = document.getElementById('precedentFormBody');
  const formActions = document.getElementById('precedentFormActions');
  const pasteBlock = document.getElementById('precedentPasteBlock');
  const saveBtn = document.getElementById('precedentSaveBtn');
  const cancelEditBtn = document.getElementById('precedentCancelEditBtn');
  const subjectFilterSel = document.getElementById('precedentSubjectFilter');
  if (!addToggleBtn || !form || !saveBtn) return;

  addToggleBtn.addEventListener('click', () => {
    const open = form.classList.toggle('pastLogFormOpen');
    if (pasteBlock) pasteBlock.classList.toggle('pastLogFormOpen', open);
    formBody.classList.toggle('pastLogFormOpen', open);
    formActions.classList.toggle('pastLogFormOpen', open);
    addToggleBtn.textContent = open ? '－ 閉じる' : '＋ 判例を追加';
    if (!open) resetPrecedentForm();
  });

  saveBtn.addEventListener('click', () => {
    const name = document.getElementById('precedentNameInput').value.trim();
    const date = document.getElementById('precedentDateInput').value.trim();
    const subject = document.getElementById('precedentSubjectInput').value.trim();
    const summary = precedentTrimPreserveIndent(document.getElementById('precedentSummaryInput').value);
    const holding = precedentTrimPreserveIndent(document.getElementById('precedentHoldingInput').value);
    const norm = precedentTrimPreserveIndent(document.getElementById('precedentNormInput').value);
    const commentary = precedentTrimPreserveIndent(document.getElementById('precedentCommentaryInput').value);
    const compact = document.getElementById('precedentCompactInput').value.trim();
    const hyakusen = document.getElementById('precedentHyakusenInput').value.trim();
    const conclusion = precedentTrimPreserveIndent(document.getElementById('precedentConclusionInput').value);
    const feature = document.getElementById('precedentFeatureInput').value.trim();
    const examMentions = document.getElementById('precedentExamMentionsInput').value.trim();
    if (!date && !name) {
      alert('判例名か判決日のどちらかは入力してください。');
      return;
    }
    if (precedentEditingId) {
      const idx = precedents.findIndex(p => p.id === precedentEditingId);
      if (idx !== -1) {
        precedents[idx] = { ...precedents[idx], name, date, subject, hyakusen, summary, holding, norm, commentary, compact, conclusion, feature, examMentions };
      }
      status.textContent = '✏️ 判例を更新しました。';
    } else {
      precedents.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        name, date, subject, hyakusen, summary, holding, norm, commentary, compact, conclusion, feature, examMentions,
        createdAt: new Date().toISOString()
      });
      status.textContent = '⚖️ 判例を追加しました。';
    }
    savePrecedents();
    resetPrecedentForm();
    form.classList.remove('pastLogFormOpen');
    if (pasteBlock) pasteBlock.classList.remove('pastLogFormOpen');
    formBody.classList.remove('pastLogFormOpen');
    formActions.classList.remove('pastLogFormOpen');
    addToggleBtn.textContent = '＋ 判例を追加';
    precedentRevealed = false;
    renderPrecedentPage();
  });

  cancelEditBtn.addEventListener('click', () => {
    resetPrecedentForm();
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
