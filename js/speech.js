/* ▼▼▼ 新規追加：論証の読み上げ機能（既存の変数・関数名と一切重複しない名前空間で実装） ▼▼▼
   既存の entries / studyLog などには一切触れていません。ブラウザ標準の音声合成（Web Speech API）を使用します。 */
let speechQueue = [];
let speechIndex = 0;
let speechIsPlaying = false;
let speechGapTimer = null;
// 読み上げを始める準備中（無音の音声が流れ始めるのを待っている間）か。この間は止まって
// いるとは見なさない
let speechPreparing = false;
let speechPrepareId = 0;
// 今読んでいる部分（'title' か 'body'）。読み直すときはこの部分の頭から読む
let speechPart = 'title';
// ほかのアプリの音で止めたとき、▶で続きから読む部分（無ければ null＝タイトルから）
let speechResumePart = null;
// 話しかけ（発話）の組の番号。自分で止めた・次へ進んだ後に、古い発話から遅れて届いた
// 「終わった」「切られた」の知らせを無視するために使う
let speechRunId = 0;
// ▶を押した時刻と、その直後に声が切られたときの読み直しの回数
let speechStartedAt = 0;
let speechInterruptRetries = 0;
// ▶を押してからこの時間のうちに声が切られたのは、音の種類の切り替えのせい（自分のせい）と
// 見なしてすぐ読み直す。それより後に切られたのは、ほかのアプリ（作業用BGMなど）が音を
// 使い始めたせいと見なして、読み直さずに止める（読み直すとBGMを止めてしまうため）
const SPEECH_START_WINDOW_MS = 5000;
const SPEECH_INTERRUPT_RETRY_MS = 500;
const SPEECH_MAX_INTERRUPT_RETRIES = 3;
// 無音の音声が流れ始めてから、話し始めるまでに置く間（音の切り替えが落ち着くのを待つ）
const SPEECH_AUDIO_SETTLE_MS = 350;
// 画面を真っ黒にしている最中か（下の「画面を真っ黒にするモード」で使う。ほかの関数からも見るため先に宣言する）
let speechDarkOpen = false;
// 真っ黒の間は見えない読み上げ画面を描き直さず、戻ったときに1回だけ描き直す
let speechDarkCardStale = false;
const SPEECH_TITLE_BODY_PAUSE_MS = 700;
const SPEECH_ENTRY_PAUSE_MS = 1400;
// 「読み上げ」タブを開いたときに最初から選ばれている内容を、設定画面
// (js/settings.js)から変更できるようにする（drive-sync.jsで同期対象）
const SPEECH_DEFAULT_RATE_KEY = 'ronshoSpeechDefaultRateV1';
const SPEECH_RATE_OPTIONS = ['0.75', '1', '1.15', '1.25', '1.5', '2'];
function loadSpeechDefaultRate() {
  const raw = localStorage.getItem(SPEECH_DEFAULT_RATE_KEY);
  return SPEECH_RATE_OPTIONS.includes(raw) ? raw : '1.5';
}
function saveSpeechDefaultRate(rate) {
  localStorage.setItem(SPEECH_DEFAULT_RATE_KEY, String(rate));
}
const SPEECH_DEFAULT_IMPORTANCE_KEY = 'ronshoSpeechDefaultImportanceV1';
const SPEECH_IMPORTANCE_OPTIONS = ['all', '2', '1', '0'];
function loadSpeechDefaultImportance() {
  const raw = localStorage.getItem(SPEECH_DEFAULT_IMPORTANCE_KEY);
  return SPEECH_IMPORTANCE_OPTIONS.includes(raw) ? raw : 'all';
}
function saveSpeechDefaultImportance(v) {
  localStorage.setItem(SPEECH_DEFAULT_IMPORTANCE_KEY, String(v));
}
const SPEECH_DEFAULT_LOOP_KEY = 'ronshoSpeechDefaultLoopV1';
const SPEECH_LOOP_OPTIONS = ['none', 'one', 'all'];
function loadSpeechDefaultLoop() {
  const raw = localStorage.getItem(SPEECH_DEFAULT_LOOP_KEY);
  return SPEECH_LOOP_OPTIONS.includes(raw) ? raw : 'all';
}
function saveSpeechDefaultLoop(v) {
  localStorage.setItem(SPEECH_DEFAULT_LOOP_KEY, String(v));
}
const SPEECH_DEFAULT_INCLUDE_MEMORIZED_KEY = 'ronshoSpeechDefaultIncludeMemorizedV1';
function loadSpeechDefaultIncludeMemorized() {
  return localStorage.getItem(SPEECH_DEFAULT_INCLUDE_MEMORIZED_KEY) === '1';
}
function saveSpeechDefaultIncludeMemorized(v) {
  localStorage.setItem(SPEECH_DEFAULT_INCLUDE_MEMORIZED_KEY, v ? '1' : '0');
}
(() => {
  const rateSel = document.getElementById('speechRateSelect');
  if (rateSel) rateSel.value = loadSpeechDefaultRate();
  const importanceSel = document.getElementById('speechImportanceSelect');
  if (importanceSel) importanceSel.value = loadSpeechDefaultImportance();
  const loopSel = document.getElementById('speechLoopSelect');
  if (loopSel) loopSel.value = loadSpeechDefaultLoop();
  const includeMemorizedChk = document.getElementById('speechIncludeMemorizedChk');
  if (includeMemorizedChk) includeMemorizedChk.checked = loadSpeechDefaultIncludeMemorized();
})();
function clearSpeechGapTimer() {
  if (speechGapTimer) {
    clearTimeout(speechGapTimer);
    speechGapTimer = null;
  }
}
// 間（ま）を置いてから次を読む。待ち時間が終わったら speechGapTimer を空に戻し、
// 「いま間を置いている最中か」を画面復帰時の判定（recoverStalledSpeech）で使う
function scheduleSpeechGap(fn, ms) {
  clearSpeechGapTimer();
  speechGapTimer = setTimeout(() => {
    speechGapTimer = null;
    fn();
  }, ms);
}
// 一定時間ごとの「一時停止→再開」は、パソコンのChromeが約15秒で読み上げを
// 打ち切ってしまう不具合への対策。iPhone・iPadでは必要が無いうえ、画面を消して
// いる間にこれが動くと再開されずに止まったり、再開後に別の声に切り替わったり
// することがあるため、iPhone・iPadでは行わない
function speechIsAppleMobile(nav) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13以降のSafariはMacと同じUAを名乗るため、タッチ対応かどうかで見分ける
  return /Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1;
}
function speechNeedsKeepAlive(nav) {
  return !speechIsAppleMobile(nav);
}
let speechKeepAliveTimer = null;
// 見張り役：読み上げ中なのに止まっていたら（画面オフで端末に止められた等）、
// 一時停止状態なら再開し、何も話していなければ今の論証を頭から読み直す。
// 読み直しは1つの論証につき2回まで（端末が止め続ける場合に、同じ論証の
// 冒頭を何度も繰り返さないため）。論証を最後まで読むと回数を戻す
const SPEECH_WATCHDOG_MS = 3000;
const SPEECH_MAX_STALL_RETRIES = 2;
let speechWatchdogTimer = null;
let speechStallRetries = 0;
// 一時停止のまま固まっていたら、まず再開を試し、それでも次の見回りで固まっていたら
// 今の部分（タイトル・本文）の頭から読み直す（iPadでは、ほかの音に割り込まれた後に
// 再開を押しても声が戻らないことがあるため）
let speechResumeTried = false;
function speechWatchdogTick() {
  const synth = window.speechSynthesis;
  if (!speechLooksStalled(synth)) {
    speechResumeTried = false;
    return;
  }
  if (speechOtherAudioTookOver()) {
    // ほかのアプリ（作業用BGMなど）が音を使い始めた。読み直すとその音を止めてしまうので、止める
    pauseSpeechByOtherAudio();
    return;
  }
  if (synth.paused && !speechResumeTried) {
    speechResumeTried = true;
    try { synth.resume(); } catch (e) {}
    return;
  }
  speechResumeTried = false;
  if (speechStallRetries >= SPEECH_MAX_STALL_RETRIES) return;
  speechStallRetries++;
  speakCurrentEntry(speechPart);
}
function startSpeechKeepAlive() {
  stopSpeechKeepAlive();
  speechWatchdogTimer = setInterval(speechWatchdogTick, SPEECH_WATCHDOG_MS);
  if (!speechNeedsKeepAlive(typeof navigator !== 'undefined' ? navigator : null)) return;
  speechKeepAliveTimer = setInterval(() => {
    if (!speechIsPlaying) return;
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 10000);
}
function stopSpeechKeepAlive() {
  if (speechKeepAliveTimer) {
    clearInterval(speechKeepAliveTimer);
    speechKeepAliveTimer = null;
  }
  if (speechWatchdogTimer) {
    clearInterval(speechWatchdogTimer);
    speechWatchdogTimer = null;
  }
}

const SPEECH_DICT_KEY = 'ronshoSpeechDictV1';
const SPEECH_DICT_DEFAULT = [
  { word: '瑕疵', reading: 'かし' },
  { word: '相殺', reading: 'そうさい' },
  { word: '幇助', reading: 'ほうじょ' },
  { word: '教唆', reading: 'きょうさ' },
  { word: '心裡留保', reading: 'しんりりゅうほ' },
  { word: '表見代理', reading: 'ひょうけんだいり' },
  { word: '既判力', reading: 'きはんりょく' },
  { word: '不当利得', reading: 'ふとうりとく' },
  { word: '詐害行為', reading: 'さがいこうい' },
  { word: '帰責事由', reading: 'きせきじゆう' }
];
let speechDict = [];
function loadSpeechDict() {
  try {
    const raw = localStorage.getItem(SPEECH_DICT_KEY);
    speechDict = raw ? JSON.parse(raw) : SPEECH_DICT_DEFAULT.slice();
  } catch (e) {
    speechDict = SPEECH_DICT_DEFAULT.slice();
  }
}
function saveSpeechDict() {
  localStorage.setItem(SPEECH_DICT_KEY, JSON.stringify(speechDict));
  if (typeof window !== 'undefined' && typeof window.ronshoSyncNotifyChange === 'function') window.ronshoSyncNotifyChange();
}
loadSpeechDict();
function isKanjiChar(ch) {
  return /[一-鿿々〆〤]/.test(ch);
}
// 連続する漢字のかたまり（例:「金曜日」）を、登録済みの単語だけで
// 過不足なく端から端まで埋められる場合に限って分割する。「金」だけが
// 単独で登録されているからといって「金曜日」の頭だけをそれに置き換えて
// しまうと、別の場所の「お金」（かね）と読みを共有してしまい、片方を
// 直すともう片方も変わってしまう（同じ漢字でも組み合わせで読みが
// 変わることに対応できない）ため、埋めきれない場合はそのかたまり
// 全体を1つの未登録語として扱う
function tileKanjiRun(text, start, end, sortedDict) {
  const segs = [];
  let i = start;
  while (i < end) {
    const matched = sortedDict.find(d => i + d.word.length <= end && text.startsWith(d.word, i));
    if (!matched) return null;
    segs.push(matched);
    i += matched.word.length;
  }
  return segs;
}
function applySpeechDict(text) {
  if (!text) return '';
  const sorted = [...speechDict].filter(d => d.word).sort((a, b) => b.word.length - a.word.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (isKanjiChar(text[i])) {
      let j = i + 1;
      while (j < text.length && isKanjiChar(text[j])) j++;
      const tiled = tileKanjiRun(text, i, j, sorted);
      if (tiled) {
        tiled.forEach(d => { out += d.reading; });
      } else {
        out += text.slice(i, j);
      }
      i = j;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}
let speechDictListVisible = false;
function renderSpeechDictToggle() {
  const btn = document.getElementById('speechDictToggleBtn');
  if (!btn) return;
  btn.textContent = (speechDictListVisible ? '▼ 登録一覧を隠す' : '▶ 登録一覧を表示する') + '（' + speechDict.length + '件）';
}
function renderSpeechDictList() {
  const wrap = document.getElementById('speechDictListWrap');
  if (!wrap) return;
  wrap.style.display = speechDictListVisible ? '' : 'none';
  renderSpeechDictToggle();
  if (speechDict.length === 0) {
    wrap.innerHTML = '<div class="speechDictEmpty">登録された読み方はありません。</div>';
    return;
  }
  wrap.innerHTML = speechDict.map((d, idx) =>
    '<div class="speechDictRow" data-idx="' + idx + '">'
    + '<span class="speechDictWord">' + escapeHtml(d.word) + '</span>'
    + '<span class="speechDictArrow">→</span>'
    + '<span class="speechDictReading">' + escapeHtml(d.reading) + '</span>'
    + '<span class="speechDictDeleteBtn" data-idx="' + idx + '">🗑</span>'
    + '</div>'
  ).join('');
}
document.getElementById('speechDictAddBtn').addEventListener('click', () => {
  const wordInput = document.getElementById('speechDictWordInput');
  const readingInput = document.getElementById('speechDictReadingInput');
  const word = wordInput.value.trim();
  const reading = readingInput.value.trim();
  if (!word || !reading) {
    alert('表記と読みの両方を入力してください。');
    return;
  }
  const existingIdx = speechDict.findIndex(d => d.word === word);
  if (existingIdx !== -1) speechDict[existingIdx].reading = reading;
  else speechDict.push({ word, reading });
  saveSpeechDict();
  wordInput.value = '';
  readingInput.value = '';
  renderSpeechDictList();
});
document.getElementById('speechDictListWrap').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.speechDictDeleteBtn');
  if (!deleteBtn) return;
  const idx = Number(deleteBtn.dataset.idx);
  speechDict.splice(idx, 1);
  saveSpeechDict();
  renderSpeechDictList();
});
document.getElementById('speechDictToggleBtn').addEventListener('click', () => {
  speechDictListVisible = !speechDictListVisible;
  renderSpeechDictList();
});
renderSpeechDictList();

// 読み上げ用に、音声合成が「えー」のような意味の無い音として読んでしまう
// 記号を整える。仮名の直後以外にある長音記号「ー」（例：見出しの前後に
// 置いた「ーーー」や、漢字・記号の直後の「ー」）は、直前の母音を伸ばす
// 音として発音されてしまうため取り除き、区切り線として使われがちな
// ダッシュ類は読点に置き換えて短い間にする
// 画面では見えないが音声合成が雑音のように読んでしまう文字（Wordなどから
// 貼り付けた際に混ざるゼロ幅文字・ソフトハイフン・制御文字・私用領域の記号など）
const SPEECH_INVISIBLE_CHAR_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFF\uE000-\uF8FF]/g;
function normalizeSpeechText(text) {
  if (!text) return '';
  return text
    .replace(SPEECH_INVISIBLE_CHAR_RE, '')
    .replace(/[―—─━‐－]+/g, '、')
    .replace(/(^|[^ぁ-ゖァ-ヺー])ー+/gm, '$1');
}
function speechTextFor(text) {
  return applySpeechDict(normalizeSpeechText(text));
}
// 画面を消した（ロックした）ときも読み上げが止まりにくいよう、読み上げ中は
// 無音の音声をループ再生してページを「音声再生中」の状態に保ち、ロック画面の
// 再生コントロール（Media Session）にも対応させる。ブラウザの音声合成そのものは
// 画面オフで止められることがあるため、端末によっては効かない
let speechSilentAudio = null;
function buildSilentWavUrl() {
  const sampleRate = 8000;
  const samples = sampleRate; // 1秒
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const writeStr = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + samples, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  writeStr(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function speechBackgroundEnabled() {
  const chk = document.getElementById('speechBackgroundChk');
  return !chk || chk.checked;
}
// iPadOS・iOS 17以降のSafariは、ページの音の種類を指定できる（navigator.audioSession）。
// 標準（auto）のままだと、ホーム画面に追加したアプリでは画面を消すと音が止められる
// ことがあるため、読み上げ中だけ「再生（playback）」＝音楽アプリと同じ扱いにする。
// この間は、ほかのアプリの音楽は止まる。読み上げを止めたら標準に戻す
function setSpeechAudioSession(type) {
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = type;
  } catch (e) {}
}
// 無音の音声を流し始める（音の種類を「再生」に切り替える）と、iPadではその切り替えの間に
// ほかのアプリ（作業用BGMなど）の音が止められ、同時に話し始めた読み上げの声が切られる
// ことがある。そこで、止まっていた無音の音声を流し始めたときは「流れ始めた」約束を返し、
// 読み上げはそれを待ってから話し始める（待つ必要が無いときは null）
const SPEECH_AUDIO_READY_MAX_MS = 1500;
// 無音の音声が本当に流れ始めたか（'playing' の知らせが来たか）。来ていたのに止まっていたら、
// ほかのアプリが音を使い始めたしるし（speechOtherAudioTookOver）
let speechSilentAudioConfirmed = false;
function onSpeechSilentAudioPlaying() {
  speechSilentAudioConfirmed = true;
}
function onSpeechSilentAudioPaused() {
  if (!speechOtherAudioTookOver()) return;
  pauseSpeechByOtherAudio();
}
function speechOtherAudioTookOver() {
  return !!(speechIsPlaying && speechSilentAudio && speechSilentAudioConfirmed && speechSilentAudio.paused === true);
}
function startSpeechBackgroundAudio() {
  if (!speechBackgroundEnabled()) return null;
  setSpeechAudioSession('playback');
  let ready = null;
  try {
    if (!speechSilentAudio) {
      speechSilentAudio = new Audio(buildSilentWavUrl());
      speechSilentAudio.loop = true;
      speechSilentAudio.setAttribute('playsinline', '');
      try {
        speechSilentAudio.addEventListener('playing', onSpeechSilentAudioPlaying);
        speechSilentAudio.addEventListener('pause', onSpeechSilentAudioPaused);
      } catch (e) {}
    }
    const wasPlaying = speechSilentAudio.paused === false;
    if (!wasPlaying) speechSilentAudioConfirmed = false;
    const p = speechSilentAudio.play();
    if (p && p.then) {
      const settled = p.then(() => {}, () => {});
      if (!wasPlaying) {
        ready = Promise.race([settled, new Promise(resolve => setTimeout(resolve, SPEECH_AUDIO_READY_MAX_MS))]);
      }
    }
  } catch (e) {}
  setupSpeechMediaSession();
  return ready;
}
function stopSpeechBackgroundAudio() {
  speechSilentAudioConfirmed = false;
  if (speechSilentAudio) speechSilentAudio.pause();
  setSpeechAudioSession('auto');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}
let speechMediaSessionReady = false;
function setupSpeechMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const e = speechQueue[speechIndex];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: e ? e.title : '論証の読み上げ',
      artist: e ? (e.subject || '') : '',
      album: '論証集アプリ'
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch (err) {}
  if (speechMediaSessionReady) return;
  speechMediaSessionReady = true;
  const handlers = {
    play: () => startSpeech(),
    pause: () => pauseSpeech(),
    stop: () => stopSpeech(),
    nexttrack: () => speechStep(1),
    previoustrack: () => speechStep(-1)
  };
  Object.keys(handlers).forEach(action => {
    try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch (err) {}
  });
}
function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
// ▼ 声の選択：端末に入っている日本語の声から選んで固定できるようにする。
// 「おまかせ」のままだと端末の標準の声で読むため、OSの更新などで標準の声が
// 変わると読み上げの声も変わってしまう。声の一覧は端末ごとに違うので、
// 選んだ声はこの端末にだけ保存する（同期しない）
const SPEECH_VOICE_KEY = 'ronshoSpeechVoiceV1';
function loadSpeechVoiceUri() {
  try { return localStorage.getItem(SPEECH_VOICE_KEY) || ''; } catch (e) { return ''; }
}
function saveSpeechVoiceUri(uri) {
  try {
    if (uri) localStorage.setItem(SPEECH_VOICE_KEY, uri);
    else localStorage.removeItem(SPEECH_VOICE_KEY);
  } catch (e) {}
}
function speechJapaneseVoices(voices) {
  return (voices || []).filter(v => v && /^ja([-_]|$)/i.test(String(v.lang || '')));
}
function findSpeechVoice(voices, uri) {
  if (!uri) return null;
  const list = speechJapaneseVoices(voices);
  return list.find(v => v.voiceURI === uri) || list.find(v => v.name === uri) || null;
}
// iPhone・iPadでは、同じ名前の声（例：Kyoko）が「軽量」「高音質」など音質違いで
// 別々に入っていたり、同じ声が書き方の違うvoiceURIで2回届いたりして、選択肢に同じ
// 名前が並んでしまう。名前と音質が同じものは1つにまとめ、名前が同じで音質が違うものは
// 名前のあとに音質を書いて見分けられるようにする
function speechVoiceQuality(v) {
  const s = String((v && v.voiceURI) || '') + ' ' + String((v && v.name) || '');
  if (/premium/i.test(s)) return 'プレミアム';
  if (/enhanced/i.test(s)) return '高音質';
  if (/compact/i.test(s)) return '軽量';
  return '';
}
function speechVoiceLabelNote(notes) {
  const list = notes.filter(Boolean);
  return list.length ? '（' + list.join('・') + '）' : '';
}
function speechVoiceOptions(voices, savedUri) {
  const groups = [];
  const byKey = {};
  speechJapaneseVoices(voices).forEach(v => {
    const name = String(v.name || v.voiceURI || '');
    const uri = String(v.voiceURI || v.name || '');
    if (!uri) return;
    const quality = speechVoiceQuality(v);
    const key = name + '|' + quality;
    let g = byKey[key];
    if (!g) {
      g = byKey[key] = { name, quality, uri, isDefault: false };
      groups.push(g);
    } else if (savedUri && uri === savedUri) {
      // まとめた声のうち、選んであった方を残す（選択欄がその声を指せるように）
      g.uri = uri;
    }
    if (v.default) g.isDefault = true;
  });
  const nameCount = {};
  groups.forEach(g => { nameCount[g.name] = (nameCount[g.name] || 0) + 1; });
  return groups.map(g => ({
    uri: g.uri,
    label: g.name + speechVoiceLabelNote([nameCount[g.name] > 1 ? g.quality : '', g.isDefault ? '標準' : ''])
  }));
}
function speechAvailableVoices() {
  try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
}
function applySpeechVoice(utterance) {
  const v = findSpeechVoice(speechAvailableVoices(), loadSpeechVoiceUri());
  utterance.lang = 'ja-JP';
  if (!v) return;
  // 声を当てられなくても、標準の日本語の声で読み上げは続ける
  try {
    utterance.voice = v;
    utterance.lang = String(v.lang).replace('_', '-');
  } catch (e) {}
}
function renderSpeechVoiceSelect() {
  const sel = document.getElementById('speechVoiceSelect');
  if (!sel || !speechSupported()) return;
  const voices = speechJapaneseVoices(speechAvailableVoices());
  const saved = loadSpeechVoiceUri();
  let html = '<option value="">おまかせ（端末の標準の声）</option>';
  speechVoiceOptions(voices, saved).forEach(o => {
    html += '<option value="' + escapeHtml(o.uri) + '">' + escapeHtml(o.label) + '</option>';
  });
  const found = findSpeechVoice(voices, saved);
  if (saved && !found && voices.length > 0) {
    // 選んでいた声がこの端末から無くなった（OSの更新で消えた等）。選択は消さずに知らせる
    html += '<option value="' + escapeHtml(saved) + '">⚠ 選んでいた声が見つかりません（標準の声で読みます）</option>';
  }
  sel.innerHTML = html;
  // 一覧がまだ届いていないときは、該当する選択肢が無いので「おまかせ」表示になる
  sel.value = found ? found.voiceURI : saved;
}
(() => {
  const sel = document.getElementById('speechVoiceSelect');
  if (!sel || !speechSupported()) return;
  sel.addEventListener('change', () => {
    saveSpeechVoiceUri(sel.value);
    if (speechIsPlaying) renderSpeechStatus('🔊 次に読む部分（本文・次の論証）から、選んだ声で読みます。');
  });
  // iPhone・iPadでは、声の一覧がページを開いた直後には空のことがあるため、
  // 一覧が届いたとき・選択欄を触ったときにも作り直す
  sel.addEventListener('focus', renderSpeechVoiceSelect);
  try { window.speechSynthesis.addEventListener('voiceschanged', renderSpeechVoiceSelect); } catch (e) {}
  renderSpeechVoiceSelect();
  const testBtn = document.getElementById('speechVoiceTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      if (speechIsPlaying) {
        renderSpeechStatus('読み上げ中は試し聞きできません。一時停止か停止をしてから押してください。');
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('この声で論証を読み上げます。');
      applySpeechVoice(u);
      const rateSel = document.getElementById('speechRateSelect');
      u.rate = rateSel ? Number(rateSel.value) || 1 : 1;
      window.speechSynthesis.speak(u);
    });
  }
})();
// ▲ 声の選択 ここまで
let speechWakeLock = null;
// 読み上げ中は画面が自動で消えないようにする（画面が消えるとiPadでは読み上げが
// 止まるため）。取得中に重ねて呼ばれても二重に取らないよう、取得中の約束を使い回す。
// 戻り値の約束は、取れたら true・取れなかったら false になる
let speechWakeLockPromise = null;
function acquireSpeechWakeLock() {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return Promise.resolve(false);
  if (speechWakeLock) return Promise.resolve(true);
  if (!speechWakeLockPromise) {
    let p;
    try { p = Promise.resolve(navigator.wakeLock.request('screen')); } catch (e) { p = Promise.reject(e); }
    speechWakeLockPromise = p.then(lock => {
      speechWakeLockPromise = null;
      if (!speechIsPlaying && !speechDarkOpen) {
        // 取得を待つ間に読み上げが止められていたら、すぐ手放す
        try { lock.release().catch(() => {}); } catch (e) {}
        return false;
      }
      speechWakeLock = lock;
      lock.addEventListener('release', () => { if (speechWakeLock === lock) speechWakeLock = null; });
      return true;
    }, () => {
      speechWakeLockPromise = null;
      speechWakeLock = null;
      return false;
    });
  }
  return speechWakeLockPromise;
}
function releaseSpeechWakeLock() {
  if (speechWakeLock) {
    speechWakeLock.release().catch(() => {});
    speechWakeLock = null;
  }
}
// ▼ 画面を真っ黒にするモード：iPadでは画面を消すと（SafariでもiPadの仕組み上）
// 読み上げが止められるため、画面は点けたまま全体を真っ黒にして画面オフの代わりにする。
// うっかり触って戻らないよう、2回タップ（3秒以内）で戻る
const SPEECH_DARK_DOUBLE_TAP_MS = 3000;
let speechDarkLastTapAt = 0;
let speechDarkHintTimer = null;
function speechDarkTapAction(now, lastTapAt) {
  return lastTapAt > 0 && now - lastTapAt <= SPEECH_DARK_DOUBLE_TAP_MS ? 'close' : 'hint';
}
// iPad mini などの液晶の画面は、黒を映しても後ろのライトが点いたままなので、
// 真っ黒にするだけでは電池はあまり持たない。ウェブアプリからは明るさを変えられない
// ため、明るさを下げる方法を案内する
function speechDarkHintText(wakeLockOk, nav) {
  const brightness = speechIsAppleMobile(nav)
    ? '電池を長持ちさせるには、画面の右上から下へなぞって\nコントロールセンターを出し、明るさ（☀）をいちばん下にしてください。'
    : '電池を長持ちさせるには、画面の明るさをいちばん下にしてください。';
  const head = wakeLockOk
    ? '🌑 画面を暗くしました。読み上げは続きます。'
    : '⚠ 画面が自動で消えるのを止められませんでした。\niPadの「設定 → 画面表示と明るさ → 自動ロック」を「なし」にしてください。';
  return head + '\n\n' + brightness + '\n\n2回タップで戻ります';
}
const SPEECH_DARK_HINT_MS = 10000;
const SPEECH_DARK_HINT_WARN_MS = 15000;
// 真っ黒の間は、Safariの上の帯（theme-color の色で塗られる）も黒くする
let speechDarkSavedThemeColor = null;
function setSpeechDarkThemeColor(on) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta || !meta.setAttribute) return;
  if (on) {
    if (speechDarkSavedThemeColor === null) speechDarkSavedThemeColor = meta.getAttribute('content') || '';
    meta.setAttribute('content', '#000000');
  } else if (speechDarkSavedThemeColor !== null) {
    meta.setAttribute('content', speechDarkSavedThemeColor);
    speechDarkSavedThemeColor = null;
  }
}
function showSpeechDarkHint(text, ms) {
  const hint = document.getElementById('speechDarkHint');
  if (!hint) return;
  hint.textContent = text;
  hint.style.opacity = '1';
  if (speechDarkHintTimer) clearTimeout(speechDarkHintTimer);
  speechDarkHintTimer = setTimeout(() => { hint.style.opacity = '0'; }, ms);
}
function openSpeechDarkScreen() {
  const ov = document.getElementById('speechDarkOverlay');
  if (!ov) return;
  speechDarkOpen = true;
  speechDarkLastTapAt = 0;
  ov.classList.add('show');
  document.documentElement.classList.add('speechDarkActive');
  setSpeechDarkThemeColor(true);
  // 無音の音声・音の種類（audioSession）には触らない。v31.5 で真っ黒にするときに止めたら、
  // iPadで読み上げが止まってしまった（読み上げ中に音の種類が変わると切られるため）
  if (!speechIsPlaying) startSpeech();
  acquireSpeechWakeLock().then(ok => {
    if (!speechDarkOpen) return;
    showSpeechDarkHint(speechDarkHintText(ok, typeof navigator !== 'undefined' ? navigator : null), ok ? SPEECH_DARK_HINT_MS : SPEECH_DARK_HINT_WARN_MS);
  });
}
function closeSpeechDarkScreen() {
  const ov = document.getElementById('speechDarkOverlay');
  speechDarkOpen = false;
  speechDarkLastTapAt = 0;
  if (ov) ov.classList.remove('show');
  document.documentElement.classList.remove('speechDarkActive');
  setSpeechDarkThemeColor(false);
  if (!speechIsPlaying) releaseSpeechWakeLock();
  if (speechDarkCardStale) {
    speechDarkCardStale = false;
    renderSpeechCurrentCard();
  }
  // 真っ黒の間に止めていたクラウド同期の定期チェックを、ここで1回だけ行う（drive-sync.js）
  try { document.dispatchEvent(new Event('ronsho:speechDarkClosed')); } catch (e) {}
}
(() => {
  const ov = document.getElementById('speechDarkOverlay');
  const btn = document.getElementById('speechDarkBtn');
  if (!ov || !btn) return;
  btn.addEventListener('click', openSpeechDarkScreen);
  ov.addEventListener('click', () => {
    const now = Date.now();
    if (speechDarkTapAction(now, speechDarkLastTapAt) === 'close') {
      closeSpeechDarkScreen();
      return;
    }
    speechDarkLastTapAt = now;
    showSpeechDarkHint('もう一度タップすると戻ります', SPEECH_DARK_DOUBLE_TAP_MS);
  });
})();
// ▲ 画面を真っ黒にするモード ここまで
// 画面を消している間に端末が読み上げを止めてしまった場合、画面を点け直した
// ときに、読んでいた論証の頭から読み直す（読み上げ中のまま無音で固まらないように）
function speechLooksStalled(synth) {
  if (!speechIsPlaying || speechGapTimer || speechPreparing || !synth) return false;
  if (synth.paused) return true;
  return !synth.speaking && !synth.pending;
}
function recoverStalledSpeech() {
  if (!speechLooksStalled(window.speechSynthesis)) return;
  if (speechQueue.length === 0) return;
  if (speechOtherAudioTookOver()) {
    // 作業用BGMなどに切り替えて戻ってきたときは、勝手に読み直してBGMを止めない
    pauseSpeechByOtherAudio();
    return;
  }
  speechStallRetries = 0;
  startSpeechBackgroundAudio();
  speakCurrentEntry(speechPart);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !speechIsPlaying) return;
  if (!speechWakeLock) acquireSpeechWakeLock();
  setTimeout(recoverStalledSpeech, 1000);
});
function renderSpeechSubjectSelect() {
  const sel = document.getElementById('speechSubjectSelect');
  if (!sel) return;
  const subjects = getUniqueSubjects();
  const current = sel.value || 'all';
  let html = '<option value="all">📚 すべて</option>';
  subjects.forEach(s => {
    html += '<option value="' + escapeHtml(s) + '">' + getSubjectEmoji(s) + ' ' + escapeHtml(s) + '</option>';
  });
  sel.innerHTML = html;
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
  renderSpeechCategorySelect();
}
function getSpeechCategories(subject) {
  const scoped = subject === 'all' ? entries : entries.filter(e => (e.subject || 'その他') === subject);
  const seen = [];
  scoped.forEach(e => {
    const c = e.category || '未分類';
    if (!seen.includes(c)) seen.push(c);
  });
  return seen;
}
function renderSpeechCategorySelect() {
  const sel = document.getElementById('speechCategorySelect');
  const subjectSel = document.getElementById('speechSubjectSelect');
  if (!sel) return;
  const subject = subjectSel ? subjectSel.value : 'all';
  const categories = getSpeechCategories(subject);
  const current = sel.value || 'all';
  let html = '<option value="all">すべての分野</option>';
  categories.forEach(c => {
    html += '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
  });
  sel.innerHTML = html;
  sel.value = [...sel.options].some(o => o.value === current) ? current : 'all';
}
function buildSpeechQueue() {
  const sel = document.getElementById('speechSubjectSelect');
  const subject = sel ? sel.value : 'all';
  const catSel = document.getElementById('speechCategorySelect');
  const category = catSel ? catSel.value : 'all';
  const importanceSel = document.getElementById('speechImportanceSelect');
  const importance = importanceSel ? importanceSel.value : 'all';
  const includeMemorized = document.getElementById('speechIncludeMemorizedChk').checked;
  return entries.filter(e => {
    if (subject !== 'all' && (e.subject || 'その他') !== subject) return false;
    if (category !== 'all' && (e.category || '未分類') !== category) return false;
    if (importance !== 'all' && (e.importance || 0) !== Number(importance)) return false;
    if (!includeMemorized && studyLog[e.title] && studyLog[e.title].memorized) return false;
    return true;
  });
}
function renderSpeechStatus(text) {
  const el = document.getElementById('speechStatus');
  if (el) el.textContent = text;
}
// ▼▼▼ 新規追加：読み上げ中の文章を読み仮名カードで表示・直接編集する機能
// 表示中の論証（タイトル・本文）を、辞書登録済みの単語は「読み」に、
// まだ辞書に無い漢字のかたまりは「そのままの表記」に置き換えた断片列に
// 分解する。カード側では断片ごとに編集可能なspanとして表示し、そこを
// 直接編集すると読み方辞書（speechDict）にそのまま反映される
let speechFuriganaVisible = false;
function buildFuriganaSegments(text) {
  if (!text) return [];
  const sorted = [...speechDict].filter(d => d.word).sort((a, b) => b.word.length - a.word.length);
  const segments = [];
  let i = 0;
  while (i < text.length) {
    if (isKanjiChar(text[i])) {
      let j = i + 1;
      while (j < text.length && isKanjiChar(text[j])) j++;
      // [i, j)は連続する漢字のかたまり。applySpeechDictと同じ理由で、
      // このかたまり全体を登録済みの単語だけで埋めきれる場合に限って
      // 分割し、埋めきれない場合はかたまり全体を1つの未登録語として扱う
      const tiled = tileKanjiRun(text, i, j, sorted);
      if (tiled) {
        tiled.forEach(d => segments.push({ type: 'dict', word: d.word, reading: d.reading }));
      } else {
        segments.push({ type: 'kanji', word: text.slice(i, j) });
      }
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !isKanjiChar(text[j])) j++;
    segments.push({ type: 'plain', text: text.slice(i, j) });
    i = j;
  }
  return segments;
}
function buildFuriganaHtml(text) {
  return buildFuriganaSegments(text).map(seg => {
    if (seg.type === 'dict') {
      return '<span class="speechFuriganaWord" contenteditable="true" data-word="' + escapeHtml(seg.word)
        + '" title="「' + escapeHtml(seg.word) + '」の読み方（編集すると辞書に反映されます）">' + escapeHtml(seg.reading) + '</span>';
    }
    if (seg.type === 'kanji') {
      return '<span class="speechFuriganaWord speechFuriganaUnregistered" contenteditable="true" data-word="' + escapeHtml(seg.word)
        + '" title="まだ読み方辞書に無い単語です。読み方を入力すると登録されます">' + escapeHtml(seg.word) + '</span>';
    }
    // 見えない文字は、読み仮名カード上で「⚠」として場所が分かるように表示する
    return escapeHtml(seg.text).replace(SPEECH_INVISIBLE_CHAR_RE, '<span class="speechInvisibleChar" title="見えない文字（読み上げでは飛ばします）">⚠</span>').replace(/\n/g, '<br>');
  }).join('');
}
function renderSpeechFuriganaCard(e) {
  const wrap = document.getElementById('speechFuriganaCard');
  if (!wrap) return;
  if (!speechFuriganaVisible || !e) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  wrap.innerHTML = '<div class="speechFuriganaNote">💡 読み方が違う単語はタップして直接修正できます。点線の単語はまだ読み方辞書に登録されていない漢字です（読み方を入力すると登録されます）。</div>'
    + '<div class="speechFuriganaText">' + buildFuriganaHtml(e.title) + '</div>'
    + '<div class="speechFuriganaText speechFuriganaBody">' + buildFuriganaHtml(e.body) + '</div>';
}
function saveFuriganaWordEdit(span) {
  const word = span.getAttribute('data-word');
  const newReading = span.textContent.trim();
  if (!word || !newReading) return;
  const wasUnregistered = span.classList.contains('speechFuriganaUnregistered');
  if (wasUnregistered && newReading === word) return; // 未編集のまま外れた場合は何もしない
  const idx = speechDict.findIndex(d => d.word === word);
  if (idx !== -1) {
    if (speechDict[idx].reading === newReading) return;
    speechDict[idx].reading = newReading;
  } else {
    speechDict.push({ word: word, reading: newReading });
  }
  saveSpeechDict();
  status.textContent = '🔤 「' + word + '」の読み方を「' + newReading + '」として読み方辞書に反映しました。';
  renderSpeechDictList();
  // 同じ単語が文章中の別の箇所にも出てくる場合、そちらの表示にも反映されるよう再描画する
  if (speechQueue.length > 0) renderSpeechFuriganaCard(speechQueue[speechIndex]);
}
const speechCurrentCardEl = document.getElementById('speechCurrentCard');
if (speechCurrentCardEl) {
  speechCurrentCardEl.addEventListener('focusout', (evt) => {
    const span = evt.target.closest ? evt.target.closest('.speechFuriganaWord') : null;
    if (span) saveFuriganaWordEdit(span);
  });
  speechCurrentCardEl.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    const span = evt.target.closest ? evt.target.closest('.speechFuriganaWord') : null;
    if (!span) return;
    evt.preventDefault();
    span.blur();
  });
  speechCurrentCardEl.addEventListener('click', (evt) => {
    const btn = evt.target.closest ? evt.target.closest('#speechFuriganaToggleBtn') : null;
    if (!btn) return;
    speechFuriganaVisible = !speechFuriganaVisible;
    btn.classList.toggle('active', speechFuriganaVisible);
    renderSpeechFuriganaCard(speechQueue[speechIndex]);
  });
}
// ▲▲▲ 読み仮名カード ここまで ▲▲▲
function renderSpeechCurrentCard() {
  if (speechDarkOpen) {
    // 真っ黒の間は見えないので描き直さない（電池を使わないように）。戻ったときに描き直す
    speechDarkCardStale = true;
    return;
  }
  const el = document.getElementById('speechCurrentCard');
  if (!el) return;
  if (speechQueue.length === 0) {
    el.innerHTML = '<div class="speechEmpty">対象の論証がありません。科目や「暗記済みも含める」の設定を見直してください。</div>';
    return;
  }
  const e = speechQueue[speechIndex];
  el.innerHTML = '<div class="speechProgress">' + (speechIndex + 1) + ' / ' + speechQueue.length + '問</div>'
    + '<div class="speechMeta">' + escapeHtml(e.subject || '') + ' ｜ ' + escapeHtml(e.category || '') + '</div>'
    + '<div class="speechTitleRow">'
    + '<div class="speechTitle">' + escapeHtml(e.title) + '</div>'
    + '<span class="speechFuriganaToggleBtn' + (speechFuriganaVisible ? ' active' : '') + '" id="speechFuriganaToggleBtn" title="読み仮名を表示・編集">🔤 読み仮名</span>'
    + '</div>'
    + '<div class="speechBody">' + linkifyLawRefs((e.bodyHtml || escapeHtml(e.body || '')), e.subject) + '</div>'
    + '<div id="speechFuriganaCard" class="speechFuriganaCard"></div>';
  renderSpeechFuriganaCard(e);
}
function advanceSpeechAfterEntry() {
  if (!speechIsPlaying) return;
  speechStallRetries = 0;
  const loopSel = document.getElementById('speechLoopSelect');
  const loopMode = loopSel ? loopSel.value : 'none';
  if (loopMode === 'one') {
    scheduleSpeechGap(() => { if (speechIsPlaying) speakCurrentEntry(); }, SPEECH_ENTRY_PAUSE_MS);
  } else if (speechIndex < speechQueue.length - 1) {
    speechIndex++;
    scheduleSpeechGap(() => { if (speechIsPlaying) speakCurrentEntry(); }, SPEECH_ENTRY_PAUSE_MS);
  } else if (loopMode === 'all') {
    speechIndex = 0;
    scheduleSpeechGap(() => { if (speechIsPlaying) speakCurrentEntry(); }, SPEECH_ENTRY_PAUSE_MS);
  } else {
    speechIsPlaying = false;
    stopSpeechKeepAlive();
    releaseSpeechWakeLock();
    stopSpeechBackgroundAudio();
    renderSpeechStatus('🎉 すべて読み上げが終了しました。');
  }
}
function speechInterruptAction(now, startedAt, retries) {
  if (now - startedAt <= SPEECH_START_WINDOW_MS && retries < SPEECH_MAX_INTERRUPT_RETRIES) return 'retry';
  return 'pause';
}
function stopSpeechWithError() {
  speechIsPlaying = false;
  speechPreparing = false;
  stopSpeechKeepAlive();
  releaseSpeechWakeLock();
  stopSpeechBackgroundAudio();
  renderSpeechStatus('読み上げ中にエラーが発生しました。');
}
// 声が切られたとき（'interrupted'・'canceled'）。自分で止めたり次へ進んだりした場合は
// 発話の組の番号が変わっているので何もしない
function handleSpeechUtteranceError(evt, runId, part) {
  if (runId !== speechRunId || !speechIsPlaying) return;
  const err = evt && evt.error;
  if (err !== 'interrupted' && err !== 'canceled') {
    stopSpeechWithError();
    return;
  }
  if (speechOtherAudioTookOver() || speechInterruptAction(Date.now(), speechStartedAt, speechInterruptRetries) === 'pause') {
    pauseSpeechByOtherAudio(part);
    return;
  }
  speechInterruptRetries++;
  scheduleSpeechGap(() => {
    if (speechIsPlaying && runId === speechRunId) speakCurrentEntry(part);
  }, SPEECH_INTERRUPT_RETRY_MS);
}
// ほかのアプリ（作業用BGMなど）が音を使い始めたので、読み上げを止める。▶を押すと、
// 止めたときに読んでいた部分（タイトル・本文）の頭から読む
function pauseSpeechByOtherAudio(part) {
  if (!speechIsPlaying) return;
  speechResumePart = part || speechPart;
  speechIsPlaying = false;
  speechPreparing = false;
  speechRunId++;
  clearSpeechGapTimer();
  stopSpeechKeepAlive();
  try { window.speechSynthesis.cancel(); } catch (e) {}
  releaseSpeechWakeLock();
  stopSpeechBackgroundAudio();
  renderSpeechStatus('⏸ ほかのアプリの音（作業用BGMなど）に切り替わったので、読み上げを止めました。「▶ 再生」を押すと、この論証の' + (speechResumePart === 'body' ? '本文' : 'タイトル') + 'から読みます。');
}
// startPart が 'body' なら、タイトルをとばして本文から読む
function speakCurrentEntry(startPart) {
  if (!speechSupported()) {
    renderSpeechStatus('お使いのブラウザは読み上げ機能に対応していません。');
    return;
  }
  if (speechQueue.length === 0) return;
  const e = speechQueue[speechIndex];
  speechPreparing = false;
  const runId = ++speechRunId;
  renderSpeechCurrentCard();
  clearSpeechGapTimer();
  const synth = window.speechSynthesis;
  synth.cancel();
  // 一時停止のまま新しく話しかけても声が出ない端末があるため、一時停止を解いておく
  try { if (synth.paused) synth.resume(); } catch (err) {}
  const rateSel = document.getElementById('speechRateSelect');
  const rate = rateSel ? Number(rateSel.value) || 1 : 1;
  const speakBody = () => {
    if (!speechIsPlaying || runId !== speechRunId) return;
    speechPart = 'body';
    const bodyUtterance = new SpeechSynthesisUtterance(speechTextFor(e.body));
    // 読み上げ中に声を選び直したときも、本文から新しい声になるよう、ここで当てる
    applySpeechVoice(bodyUtterance);
    bodyUtterance.rate = rate;
    bodyUtterance.onend = () => {
      if (runId !== speechRunId) return;
      advanceSpeechAfterEntry();
    };
    bodyUtterance.onerror = (evt) => handleSpeechUtteranceError(evt, runId, 'body');
    synth.speak(bodyUtterance);
  };
  renderSpeechStatus('🔊 読み上げ中… (' + (speechIndex + 1) + ' / ' + speechQueue.length + ')');
  startSpeechKeepAlive();
  setupSpeechMediaSession();
  if (startPart === 'body') {
    speakBody();
    return;
  }
  speechPart = 'title';
  const titleUtterance = new SpeechSynthesisUtterance(speechTextFor(e.title));
  applySpeechVoice(titleUtterance);
  titleUtterance.rate = rate;
  titleUtterance.onend = () => {
    if (!speechIsPlaying || runId !== speechRunId) return;
    scheduleSpeechGap(speakBody, SPEECH_TITLE_BODY_PAUSE_MS);
  };
  titleUtterance.onerror = (evt) => handleSpeechUtteranceError(evt, runId, 'title');
  synth.speak(titleUtterance);
}
// iPhone・iPadでは、ページで最初の読み上げは画面を押した瞬間に始めないと声が出ない。
// 無音の音声を待ってから話し始めるときのために、押した瞬間に無音の発話を1つ入れておく
// （話し始めるときに取り消すので、声には出ない）
function unlockSpeechSynthesis() {
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}
function startSpeech() {
  if (!speechSupported()) {
    renderSpeechStatus('お使いのブラウザは読み上げ機能に対応していません。');
    return;
  }
  const synth = window.speechSynthesis;
  acquireSpeechWakeLock();
  speechStallRetries = 0;
  speechInterruptRetries = 0;
  speechResumeTried = false;
  speechStartedAt = Date.now();
  // 一時停止から続ける（ほかのアプリの音で止めたときは、止めた部分の頭から読み直す）
  const resumePaused = !speechResumePart && speechQueue.length > 0 && synth.paused && (synth.speaking || synth.pending);
  if (!resumePaused) {
    if (speechQueue.length === 0) {
      speechQueue = buildSpeechQueue();
      speechIndex = 0;
      speechResumePart = null;
    } else {
      speechIndex = Math.min(speechIndex, speechQueue.length - 1);
    }
  }
  speechIsPlaying = true;
  const go = () => {
    if (resumePaused) {
      try { synth.resume(); } catch (e) {}
      startSpeechKeepAlive();
      setupSpeechMediaSession();
      renderSpeechStatus('🔊 読み上げ中… (' + (speechIndex + 1) + ' / ' + speechQueue.length + ')');
      return;
    }
    if (speechQueue.length === 0) {
      // 読む論証が無い（科目・分野などの絞り込みで0件）。カードに案内が出る
      speechIsPlaying = false;
      stopSpeechKeepAlive();
      releaseSpeechWakeLock();
      stopSpeechBackgroundAudio();
      renderSpeechCurrentCard();
      renderSpeechStatus('');
      return;
    }
    const part = speechResumePart || 'title';
    speechResumePart = null;
    renderSpeechCurrentCard();
    speakCurrentEntry(part);
  };
  const ready = startSpeechBackgroundAudio();
  if (!ready) {
    go();
    return;
  }
  // 無音の音声が流れ始め、音の切り替えが落ち着いてから話し始める（作業用BGMなどを
  // 止める切り替えの最中に話し始めると、声が切られて黙ってしまうため）
  if (!resumePaused) unlockSpeechSynthesis();
  speechPreparing = true;
  const prepareId = ++speechPrepareId;
  renderSpeechStatus('🔊 読み上げの準備中…');
  if (!resumePaused) renderSpeechCurrentCard();
  ready.then(() => {
    setTimeout(() => {
      if (prepareId !== speechPrepareId || !speechPreparing || !speechIsPlaying) return;
      speechPreparing = false;
      go();
    }, SPEECH_AUDIO_SETTLE_MS);
  });
}
function pauseSpeech() {
  if (!speechSupported()) return;
  speechIsPlaying = false;
  speechPreparing = false;
  clearSpeechGapTimer();
  stopSpeechKeepAlive();
  window.speechSynthesis.pause();
  releaseSpeechWakeLock();
  stopSpeechBackgroundAudio();
  renderSpeechStatus('⏸ 一時停止中');
}
function stopSpeech() {
  if (!speechSupported()) return;
  speechIsPlaying = false;
  speechPreparing = false;
  speechResumePart = null;
  speechRunId++;
  clearSpeechGapTimer();
  stopSpeechKeepAlive();
  const synth = window.speechSynthesis;
  synth.cancel();
  // 一時停止のまま止めると、次の▶で「続きから」と見なされて声が出ないため解いておく
  try { if (synth.paused) synth.resume(); } catch (e) {}
  releaseSpeechWakeLock();
  stopSpeechBackgroundAudio();
  renderSpeechStatus('⏹ 停止しました');
}
function speechStep(delta) {
  if (speechQueue.length === 0) return;
  const wasPlaying = speechIsPlaying;
  speechIsPlaying = false;
  speechPreparing = false;
  speechResumePart = null;
  speechRunId++;
  clearSpeechGapTimer();
  window.speechSynthesis.cancel();
  speechIndex = Math.min(Math.max(speechIndex + delta, 0), speechQueue.length - 1);
  renderSpeechCurrentCard();
  if (wasPlaying) {
    speechIsPlaying = true;
    speakCurrentEntry();
  }
}
document.getElementById('speechPlayBtn').addEventListener('click', startSpeech);
document.getElementById('speechPauseBtn').addEventListener('click', pauseSpeech);
document.getElementById('speechStopBtn').addEventListener('click', stopSpeech);
document.getElementById('speechNextBtn').addEventListener('click', () => speechStep(1));
document.getElementById('speechPrevBtn').addEventListener('click', () => speechStep(-1));
document.getElementById('speechSubjectSelect').addEventListener('change', () => {
  stopSpeech();
  renderSpeechCategorySelect();
  speechQueue = buildSpeechQueue();
  speechIndex = 0;
  renderSpeechCurrentCard();
  renderSpeechStatus('');
});
document.getElementById('speechCategorySelect').addEventListener('change', () => {
  stopSpeech();
  speechQueue = buildSpeechQueue();
  speechIndex = 0;
  renderSpeechCurrentCard();
  renderSpeechStatus('');
});
document.getElementById('speechImportanceSelect').addEventListener('change', () => {
  stopSpeech();
  speechQueue = buildSpeechQueue();
  speechIndex = 0;
  renderSpeechCurrentCard();
  renderSpeechStatus('');
});
document.getElementById('speechIncludeMemorizedChk').addEventListener('change', () => {
  stopSpeech();
  speechQueue = buildSpeechQueue();
  speechIndex = 0;
  renderSpeechCurrentCard();
  renderSpeechStatus('');
});
/* ▲▲▲ 新規追加：論証の読み上げ機能 ここまで ▲▲▲ */

