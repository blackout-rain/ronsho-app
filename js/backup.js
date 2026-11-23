/* ▼▼▼ 新規追加：全データバックアップ機能 ここから ▼▼▼ */
// クラウド同期とは別に、ブラウザにファイルとして保存しておく手動バックアップ。
// ブラウザの仕様上、確認なしで自動的にファイル保存を繰り返すことはできないため、
// 「最後にバックアップしてから一定日数経ったらお知らせする」形の
// 半自動（催促＋ワンタップ書き出し）として実装している。
const BACKUP_LAST_AT_KEY = 'ronshoLastBackupAtV1';
const BACKUP_SNOOZE_AT_KEY = 'ronshoBackupSnoozeAtV1';
const BACKUP_REMINDER_DAYS_KEY = 'ronshoBackupReminderDaysV1';
const BACKUP_REMINDER_DAYS_DEFAULT = 7;
// 通知までの日数は、設定タブ（⚙️ その他）から変更できるようにする
// （drive-sync.jsで同期対象）
function loadBackupReminderDays() {
  const n = Number(localStorage.getItem(BACKUP_REMINDER_DAYS_KEY));
  return Number.isInteger(n) && n > 0 ? n : BACKUP_REMINDER_DAYS_DEFAULT;
}
function saveBackupReminderDays(days) {
  localStorage.setItem(BACKUP_REMINDER_DAYS_KEY, String(days));
}

function buildBackupPayload() {
  const snap = (typeof window.ronshoBuildBackupSnapshot === 'function')
    ? window.ronshoBuildBackupSnapshot()
    : { entries: entries, studyLog: studyLog, manualLog: manualLog };
  return Object.assign({ exportedAt: new Date().toISOString() }, snap);
}
// 端末への保存に共有シート（Web Share API）を使うかどうか。
// iPhone・iPad（ホーム画面のPWAを含む）では<a download>が効かずJSONが画面に
// 表示されるだけなので共有シートを使う。それ以外（Windows・Mac・Androidの
// Chromeなど）は<a download>で普通にダウンロードする。
// v31.0まではWindowsのChromeでも共有シートを使おうとしていたが、先にGoogle Drive
// へアップロードしている間に「ボタンを押した直後」の扱いが切れて共有が拒否され
// （NotAllowedError）、「端末への保存はできませんでした」になっていた
function backupPrefersShareSheet(nav) {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  const ua = String(nav.userAgent || '');
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13以降のSafariはMacと同じUAを名乗るため、タッチ対応かどうかで見分ける
  return /Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1;
}
// バックアップのJSONを端末に保存する。戻り値は 'saved'（保存した／保存を始めた）・
// 'cancelled'（共有シートを閉じた）・'failed'（保存できなかった）
async function saveBackupFileLocally(json, fileName) {
  try {
    if (backupPrefersShareSheet(navigator)) {
      const file = new File([json], fileName, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: fileName });
          return 'saved';
        } catch (shareErr) {
          if (shareErr && shareErr.name === 'AbortError') return 'cancelled';
          // 時間が経って共有が拒否された（NotAllowedError）などの場合は、
          // <a download>に切り替えるとiOSでは画面がJSONに遷移してしまうため、
          // 「端末に保存」ボタンでもう一度押してもらう
          return 'failed';
        }
      }
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'saved';
  } catch (err) {
    return 'failed';
  }
}
// 端末への保存ができなかったときに、もう一度押して保存し直せるボタンを出す
// （押した直後なら共有シートも拒否されない）
let pendingBackupFile = null;
function showBackupStatus(message, retryFile) {
  pendingBackupFile = retryFile || null;
  status.textContent = message;
  if (pendingBackupFile) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'backupSaveLocalRetryBtn';
    btn.textContent = '📥 端末に保存する';
    btn.style.marginLeft = '8px';
    status.appendChild(btn);
  }
}
status.addEventListener('click', async (e) => {
  if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('#backupSaveLocalRetryBtn')) return;
  const file = pendingBackupFile;
  if (!file) return;
  const result = await saveBackupFileLocally(file.json, file.fileName);
  if (result === 'saved') {
    localStorage.setItem(BACKUP_LAST_AT_KEY, todayStr());
    localStorage.removeItem(BACKUP_SNOOZE_AT_KEY);
    renderBackupLastInfo();
    renderBackupReminderBanner();
    showBackupStatus('📦 バックアップを端末に保存しました。');
  } else if (result === 'cancelled') {
    showBackupStatus('端末への保存はキャンセルされました。', file);
  } else {
    showBackupStatus('端末に保存できませんでした。もう一度お試しください。', file);
  }
});
async function downloadFullBackup() {
  const payload = buildBackupPayload();
  const fileName = '論証集バックアップ_' + todayStr() + '.json';
  const json = JSON.stringify(payload, null, 2);
  // 先にGoogle Driveへアップロードする。iPadのホーム画面アイコン（PWA）では
  // <a download>による保存が効かずblobの中身が画面に表示されてページ遷移が
  // 起きてしまい、後に回したアップロードが中断されて失敗していたため、
  // 遷移の恐れが無い通信を先に済ませる
  let driveUploaded = false;
  let driveError = '';
  if (typeof window.ronshoUploadBackupToDrive === 'function') {
    try {
      await window.ronshoUploadBackupToDrive(payload, fileName);
      driveUploaded = true;
    } catch (err) {
      driveError = err.message;
    }
  }
  const localResult = await saveBackupFileLocally(json, fileName);
  const localSaved = localResult === 'saved';
  if (localSaved || driveUploaded) {
    localStorage.setItem(BACKUP_LAST_AT_KEY, todayStr());
    localStorage.removeItem(BACKUP_SNOOZE_AT_KEY);
  }
  renderBackupLastInfo();
  renderBackupReminderBanner();
  const retryFile = localSaved ? null : { json: json, fileName: fileName };
  if (localSaved && driveUploaded) {
    showBackupStatus('📦 バックアップを保存し、Google Driveにもアップロードしました。');
  } else if (driveUploaded) {
    showBackupStatus(localResult === 'cancelled'
      ? '📦 Google Driveにアップロードしました（端末への保存はキャンセルされました）。'
      : '📦 Google Driveにアップロードしました（端末への保存はできませんでした）。', retryFile);
  } else if (localSaved) {
    showBackupStatus('📦 バックアップを端末に保存しました（Google Driveへのアップロードは失敗：' + driveError + '）。');
  } else {
    showBackupStatus('バックアップに失敗しました（Google Driveへのアップロードは失敗：' + driveError + '）。通信状況を確認してもう一度お試しください。', retryFile);
  }
}
function daysSince(dateStr) {
  return Math.round((new Date(todayStr() + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
}
function renderBackupLastInfo() {
  const el = document.getElementById('backupLastInfo');
  if (!el) return;
  const last = localStorage.getItem(BACKUP_LAST_AT_KEY);
  el.textContent = last ? ('最終バックアップ：' + last + '（' + daysSince(last) + '日前）') : 'まだバックアップを取っていません。';
}
function renderBackupReminderBanner() {
  const banner = document.getElementById('backupReminderBanner');
  if (!banner) return;
  const last = localStorage.getItem(BACKUP_LAST_AT_KEY);
  const overdue = last ? daysSince(last) >= loadBackupReminderDays() : entries.length > 0;
  const snoozedToday = localStorage.getItem(BACKUP_SNOOZE_AT_KEY) === todayStr();
  if (!overdue || snoozedToday) {
    banner.innerHTML = '';
    banner.classList.remove('visible');
    return;
  }
  banner.classList.add('visible');
  const message = last
    ? '📦 最後のバックアップから<strong>' + daysSince(last) + '日</strong>経っています。念のためバックアップを取っておきましょう。'
    : '📦 まだ一度もバックアップを取っていません。念のため取っておきましょう。';
  banner.innerHTML = message
    + '<button type="button" id="backupReminderDownloadBtn">📦 今すぐバックアップ</button>'
    + '<span class="backupReminderDismissBtn" id="backupReminderDismissBtn">✖</span>';
}
document.getElementById('downloadBackupBtn').addEventListener('click', downloadFullBackup);
document.getElementById('backupReminderBanner').addEventListener('click', (e) => {
  if (e.target.closest('#backupReminderDownloadBtn')) {
    downloadFullBackup();
    return;
  }
  if (e.target.closest('#backupReminderDismissBtn')) {
    localStorage.setItem(BACKUP_SNOOZE_AT_KEY, todayStr());
    renderBackupReminderBanner();
  }
});
registerSettingsPageRenderer(renderBackupLastInfo);

// バックアップファイルからの復元（全データを上書き）。
// 各データ種別は、既存の save*() 関数をそのまま呼ぶことで、都度同期の
// フックも通常操作と同じように働くようにしている（復元後にクラウドとの
// 差分があれば、通常の同期の仕組みで検知・確認される）。
function restoreFromBackupPayload(data) {
  entries = Array.isArray(data.entries) ? data.entries : [];
  studyLog = (data.studyLog && typeof data.studyLog === 'object') ? data.studyLog : {};
  manualLog = (data.manualLog && typeof data.manualLog === 'object') ? data.manualLog : {};
  dupArchiveList = Array.isArray(data.dupArchive) ? data.dupArchive : [];
  dupResolvedSet = new Set(Array.isArray(data.dupResolved) ? data.dupResolved : []);
  if (Array.isArray(data.speechDict)) speechDict = data.speechDict;
  orphanEntryArchive = (data.orphanEntryArchive && typeof data.orphanEntryArchive === 'object') ? data.orphanEntryArchive : {};
  precedents = Array.isArray(data.precedents) ? data.precedents : [];
  if (typeof saveBooks === 'function') saveBooks(Array.isArray(data.books) ? data.books : []);
  editingEntryTitle = null;
  compareList = [];
  compareModalOpen = false;
  dupCheckPairs = [];
  expandedBodySet = new Set();
  saveEntries();
  saveStudyLog();
  saveManualLog();
  saveDupArchive();
  saveDupResolved();
  saveSpeechDict();
  saveOrphanEntryArchive();
  savePrecedents();
  // 過去問ログ（v34.2〜は消した印も）。消した印は古いバックアップには無い
  if (typeof restorePastExamLogsFromBackup === 'function') restorePastExamLogsFromBackup(data.pastExamLogs, data.pastExamDeleted);
  else savePastExamLogs(Array.isArray(data.pastExamLogs) ? data.pastExamLogs : []);
  saveCountdowns(Array.isArray(data.countdowns) ? data.countdowns : []);
  if (data.dailyGoal) saveDailyGoal(data.dailyGoal);
  if (data.weeklyGoal && typeof saveWeeklyGoal === 'function') saveWeeklyGoal(data.weeklyGoal);
  if (data.dailyStats && typeof data.dailyStats === 'object') saveDailyStats(data.dailyStats);
  if (typeof saveXp === 'function') saveXp(Number(data.xp) || 0);
  // 表示テーマ・ペット・各画面の既定フィルタなど、以前は端末ごとのローカル設定
  // だったものも同期対象になったため、バックアップの復元でも合わせて復元する。
  // 値は元のファイルと同じ形式（生の文字列・数値）でそのまま保存する
  const RAW_STRING_RESTORE_KEYS = {
    theme: 'ronshoThemeV1',
    petEnabled: 'ronshoPetEnabledV1',
    petSpecies: 'ronshoPetSpeciesV1',
    petBubbleEnabled: 'ronshoPetBubbleEnabledV1',
    petBubbleDuration: 'ronshoPetBubbleDurationV1',
    speechDefaultRate: 'ronshoSpeechDefaultRateV1',
    speechDefaultImportance: 'ronshoSpeechDefaultImportanceV1',
    speechDefaultLoop: 'ronshoSpeechDefaultLoopV1',
    speechDefaultIncludeMemorized: 'ronshoSpeechDefaultIncludeMemorizedV1',
    csvExcludeMemorized: 'ronshoCsvExcludeMemorizedV1',
    starFilterDefault: 'ronshoStarFilterDefaultV1',
    pastExamDefaultType: 'ronshoPastExamDefaultTypeV1',
    backupReminderDays: 'ronshoBackupReminderDaysV1',
    lastBackupAt: 'ronshoLastBackupAtV1',
    backupSnoozeAt: 'ronshoBackupSnoozeAtV1',
    progressViewMode: 'ronshoProgressViewModeV1',
    lawRefView: 'ronshoLawRefViewV1'
  };
  Object.keys(RAW_STRING_RESTORE_KEYS).forEach(field => {
    const v = data[field];
    const key = RAW_STRING_RESTORE_KEYS[field];
    if (v === undefined || v === null || v === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(v));
  });
  if (data.quizDefaultFilters && typeof data.quizDefaultFilters === 'object') localStorage.setItem('ronshoQuizDefaultFiltersV1', JSON.stringify(data.quizDefaultFilters));
  if (data.tabShortcuts && typeof data.tabShortcuts === 'object') localStorage.setItem('ronshoTabShortcutsV1', JSON.stringify(data.tabShortcuts));
  if (Array.isArray(data.syncConflicts)) localStorage.setItem('ronshoSyncConflictsV1', JSON.stringify(data.syncConflicts));
  // 過去問の資料の「読んだ」印（v32.0〜）。古いバックアップには無いので、そのときは今の印を残す
  if (data.examRead && typeof data.examRead === 'object' && !Array.isArray(data.examRead)) localStorage.setItem('ronshoExamReadV1', JSON.stringify(data.examRead));
  // 百選の目次（v33.0〜）。古いバックアップには無いので、そのときは今の目次を残す
  if (Array.isArray(data.hyakusenToc)) localStorage.setItem('ronshoHyakusenTocV1', JSON.stringify(data.hyakusenToc));
  // 開いた条文の回数・お気に入り（v34.1〜）。古いバックアップには無いので、そのときは今の記録を残す
  if (data.lawHistory && typeof data.lawHistory === 'object' && !Array.isArray(data.lawHistory)) localStorage.setItem('ronshoLawHistoryV1', JSON.stringify(data.lawHistory));
  // 過去問の資料のマーカー（v34.0〜）。古いバックアップには無いので、そのときは今のマーカーを残す
  if (data.examMarks && typeof data.examMarks === 'object' && !Array.isArray(data.examMarks)) localStorage.setItem('ronshoExamMarksV1', JSON.stringify(data.examMarks));
  if (entries.length > 0) {
    downloadBtn.style.display = 'inline-block';
    downloadLogBtn.style.display = 'inline-block';
  }
  renderAll();
}
document.getElementById('restoreBackupBtn').addEventListener('click', () => {
  document.getElementById('restoreBackupInput').click();
});
document.getElementById('restoreBackupInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert('ファイルの読み込みに失敗しました。正しいバックアップファイル（.json）を選択してください。');
    return;
  }
  if (!data || !Array.isArray(data.entries)) {
    alert('このファイルは全データバックアップの形式ではないようです（論証データが見つかりません）。');
    return;
  }
  const exportedAtLabel = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : '不明';
  const confirmMsg = '⚠️ バックアップから復元します。\n\n'
    + '書き出し日時：' + exportedAtLabel + '\n'
    + '論証数：' + data.entries.length + '件\n\n'
    + '現在この端末にあるデータ（このバックアップ以降に追加・変更した内容を含む）は、このバックアップの内容で全て上書きされます。この操作は元に戻せません。\n\n'
    + '本当に復元しますか？';
  if (!confirm(confirmMsg)) return;
  restoreFromBackupPayload(data);
  status.textContent = '🔄 バックアップ（' + exportedAtLabel + '時点）から復元しました。';
});
/* ▲▲▲ 新規追加：全データバックアップ機能 ここまで ▲▲▲ */
