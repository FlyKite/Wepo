/**
 * 微仓助手渲染进程逻辑:服务器配置、备份选择(目录/压缩包)、解析导入与进度。
 * 数据查看已迁移到服务端网页(http://<服务器>:3800/)。
 */

const $ = (sel) => document.querySelector(sel);
const ACTIVE_IMPORT_KEY = 'wepo.activeImport.v1';
const SERVER_BACKUP_KEY = 'wepo.serverBackupKey';
const SERVER_INCLUDE_MEDIA_KEY = 'wepo.serverIncludeMedia';

function readActiveImport() {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_IMPORT_KEY) || 'null');
    if (value && typeof value.backupId === 'string' && value.backupId) return value;
  } catch (err) {
    /* ignore */
  }
  return null;
}

const state = {
  serverUrl: localStorage.getItem('wepo.serverUrl') || '',
  secret: localStorage.getItem('wepo.secret') || '',
  importDir: localStorage.getItem('wepo.backupDir') || '',
  importZip: localStorage.getItem('wepo.backupZip') || '',
  includeMedia: localStorage.getItem('wepo.includeMedia') !== '0',
  importing: false,
  importBackupId: null,
  resumeBackupId: null,
  activeImport: readActiveImport(),
  incompleteImports: [],
  serverBackups: [],
  serverBackupRoot: '',
  serverBackupsError: '',
  serverBackupsLoading: false,
  serverBackupKey: localStorage.getItem(SERVER_BACKUP_KEY) || '',
  serverIncludeMedia: localStorage.getItem(SERVER_INCLUDE_MEDIA_KEY) !== '0',
  serverJob: null,
  serverJobTimer: null,
  serverJobPolling: false,
  serverJobGeneration: 0,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function toast(text, isError) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.style.background = isError ? '#c94f4f' : '#4c4c4c';
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}

async function api(path, options = {}) {
  if (!state.serverUrl) throw new Error('请先配置并保存服务器地址');
  const headers = Object.assign({}, options.headers || {});
  if (state.secret) headers['X-WEPO-Secret'] = state.secret;
  const res = await fetch(state.serverUrl + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch (err) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ---------- 服务器设置 ----------

function hasSavedServerSettings() {
  return Boolean(localStorage.getItem('wepo.serverUrl') && localStorage.getItem('wepo.secret'));
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function setConnStatus(message, type) {
  const el = $('#connStatus');
  el.textContent = message || '';
  el.className = 'setup-status' + (type ? ` status-${type}` : '');
}

function showSetup(allowCancel) {
  $('#mainView').classList.add('hidden');
  $('#setupView').classList.remove('hidden');
  $('#serverUrlInput').value = state.serverUrl;
  $('#secretInput').value = state.secret;
  $('#cancelServerBtn').classList.toggle('hidden', !allowCancel);
  $('#saveServerBtn').disabled = false;
  $('#saveServerBtn').textContent = '确定';
  setConnStatus('');
  setTimeout(() => $('#serverUrlInput').focus(), 0);
}

function showMain() {
  $('#setupView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
  $('#currentServerUrl').textContent = state.serverUrl;
  $('#currentServerUrl').title = state.serverUrl;
  refreshIncompleteImports();
  refreshServerBackups();
  startServerJobPolling();
}

async function verifyServerConnection(url, secret) {
  let health;
  try {
    health = await fetch(`${url}/api/health`);
  } catch (err) {
    throw new Error(`无法连接服务器: ${err.message}`);
  }
  if (!health.ok) throw new Error(`服务器不可用: HTTP ${health.status}`);

  let verify;
  try {
    verify = await fetch(`${url}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
  } catch (err) {
    throw new Error(`Secret 校验失败: ${err.message}`);
  }
  if (!verify.ok) throw new Error('服务器可连接，但 Secret 校验失败，请检查 Secret');
}

async function confirmServerSettings() {
  const url = normalizeServerUrl($('#serverUrlInput').value);
  const secret = $('#secretInput').value.trim();
  if (!url) {
    setConnStatus('请输入服务器地址', 'fail');
    return;
  }
  if (!secret) {
    setConnStatus('请输入访问 Secret', 'fail');
    return;
  }

  const button = $('#saveServerBtn');
  button.disabled = true;
  button.textContent = '连接中...';
  setConnStatus('正在测试连接...');
  try {
    await verifyServerConnection(url, secret);
    state.serverUrl = url;
    state.secret = secret;
    localStorage.setItem('wepo.serverUrl', url);
    localStorage.setItem('wepo.secret', secret);
    setConnStatus('');
    showMain();
    toast('连接成功');
  } catch (err) {
    setConnStatus(err.message, 'fail');
    button.disabled = false;
    button.textContent = '确定';
  }
}

function cancelServerSettings() {
  if (!hasSavedServerSettings()) return;
  showMain();
}

function bindServer() {
  $('#saveServerBtn').addEventListener('click', confirmServerSettings);
  $('#cancelServerBtn').addEventListener('click', cancelServerSettings);
  $('#modifyServerBtn').addEventListener('click', () => showSetup(true));
  $('#serverUrlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#secretInput').focus();
  });
  $('#secretInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmServerSettings();
  });
}

// ---------- 备份选择 ----------

function refreshBackupInput() {
  const value = state.importZip || state.importDir;
  $('#backupInput').value = value;
}

function setImportSource(value) {
  if (!value) return;
  if (/\.zip$/i.test(value)) {
    state.importZip = value;
    state.importDir = '';
    localStorage.setItem('wepo.backupZip', value);
    localStorage.removeItem('wepo.backupDir');
  } else {
    state.importDir = value;
    state.importZip = '';
    localStorage.setItem('wepo.backupDir', value);
    localStorage.removeItem('wepo.backupZip');
  }
  refreshBackupInput();
}

function setBackupMenuOpen(open) {
  $('#backupMenu').classList.toggle('hidden', !open);
  $('#pickBackupBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function bindBackupPick() {
  refreshBackupInput();

  $('#pickBackupBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    setBackupMenuOpen($('#backupMenu').classList.contains('hidden'));
  });
  $('#pickDirBtn').addEventListener('click', async () => {
    setBackupMenuOpen(false);
    const dir = await window.wepo.selectBackupDir();
    if (dir) setImportSource(dir);
  });
  $('#pickZipBtn').addEventListener('click', async () => {
    setBackupMenuOpen(false);
    const zip = await window.wepo.selectBackupZip();
    if (zip) setImportSource(zip);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.backup-picker')) setBackupMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setBackupMenuOpen(false);
  });
}

// ---------- 服务器 NAS 备份导入 ----------

function formatBackupDate(value) {
  if (!value) return '备份时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '备份时间未知';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatCount(value) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

function serverJobActive(job = state.serverJob) {
  return Boolean(job && (job.status === 'starting' || job.status === 'running'));
}

function serverBackupStatusLabel(item) {
  const info = item && item.import;
  if (!info) return '未导入';
  if (info.incomplete) return '有未完成导入';
  return '已导入';
}

function serverBackupOptionLabel(item) {
  const name = item.deviceName || item.folderName || item.key;
  const ios = item.iosVersion ? `iOS ${item.iosVersion}` : 'iOS 版本未知';
  return `${name} · ${ios} · ${formatBackupDate(item.backupDate)} · ${serverBackupStatusLabel(item)}`;
}

function currentServerBackup() {
  const select = $('#serverBackupSelect');
  const key = select ? select.value : state.serverBackupKey;
  return state.serverBackups.find((item) => item.key === key) || null;
}

function renderServerBackupHint() {
  const hint = $('#serverBackupHint');
  if (!hint) return;
  hint.className = 'hint';
  if (state.serverBackupsLoading) {
    hint.textContent = '正在读取服务器备份目录...';
    return;
  }
  if (state.serverBackupsError) {
    hint.textContent = state.serverBackupsError;
    hint.className = 'hint status-fail';
    return;
  }
  const item = currentServerBackup();
  if (!item) {
    hint.textContent = state.serverBackupRoot
      ? `服务器目录 ${state.serverBackupRoot} 中没有找到有效的 iOS 备份`
      : '服务器没有返回可用的备份';
    return;
  }
  const parts = [];
  if (state.serverBackupRoot) parts.push(`目录: ${state.serverBackupRoot}`);
  parts.push(`文件夹: ${item.folderName || item.key}`);
  if (item.serialNumber) parts.push(`序列号: ${item.serialNumber}`);
  const info = item.import;
  if (info) {
    const summary = info.incomplete ? '未完成导入' : '已完成导入';
    const counts = [];
    if (info.messageCount) counts.push(`${formatCount(info.messageCount)} 条消息`);
    if (info.mediaCount) counts.push(`${formatCount(info.mediaCount)} 个媒体`);
    parts.push(`${summary}${counts.length ? `(${counts.join(',')})` : ''}`);
  } else {
    parts.push('未导入');
  }
  hint.textContent = parts.join(' · ');
}

function renderServerBackups() {
  const select = $('#serverBackupSelect');
  if (!select) return;
  if (state.serverBackupsLoading) {
    select.innerHTML = '<option>正在读取...</option>';
    select.disabled = true;
    updateServerActionState();
    renderServerBackupHint();
    return;
  }
  const items = state.serverBackups;
  if (items.length === 0) {
    select.innerHTML = '<option>没有可用备份</option>';
    select.disabled = true;
    state.serverBackupKey = '';
    updateServerActionState();
    renderServerBackupHint();
    return;
  }

  const activeKey = serverJobActive() && state.serverJob ? state.serverJob.sourceKey : '';
  const desired = activeKey || state.serverBackupKey;
  const selected = items.find((item) => item.key === desired) || items[0];
  select.innerHTML = items.map((item) => (
    `<option value="${esc(item.key)}">${esc(serverBackupOptionLabel(item))}</option>`
  )).join('');
  select.value = selected.key;
  select.disabled = false;
  if (state.serverBackupKey !== selected.key) {
    state.serverBackupKey = selected.key;
    localStorage.setItem(SERVER_BACKUP_KEY, selected.key);
  }
  updateServerActionState();
  renderServerBackupHint();
}

async function refreshServerBackups() {
  if (!state.serverUrl || !state.secret) return;
  state.serverBackupsLoading = true;
  state.serverBackupsError = '';
  renderServerBackups();
  try {
    const data = await api('/api/import/sources');
    state.serverBackupRoot = String(data.root || '');
    state.serverBackups = Array.isArray(data.items) ? data.items : [];
    state.serverBackupsError = data.exists === false ? String(data.error || '服务器备份目录不存在') : '';
  } catch (err) {
    state.serverBackups = [];
    state.serverBackupsError = err.message || '读取服务器备份目录失败';
  } finally {
    state.serverBackupsLoading = false;
    renderServerBackups();
  }
}

function updateServerActionState() {
  const startBtn = $('#startServerImportBtn');
  const cancelBtn = $('#cancelServerImportBtn');
  const refreshBtn = $('#refreshServerBackupsBtn');
  const select = $('#serverBackupSelect');
  const mediaChk = $('#serverIncludeMediaChk');
  if (!startBtn) return;
  const active = serverJobActive();
  const item = currentServerBackup();
  startBtn.disabled = !item || active || state.importing || state.serverBackupsLoading;
  startBtn.textContent = active
    ? '服务端导入中...'
    : (item && item.import && item.import.incomplete ? '继续导入' : '导入所选备份');
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !active);
  if (refreshBtn) refreshBtn.disabled = state.importing || active;
  if (select) select.disabled = state.serverBackupsLoading || !state.serverBackups.length || active || state.importing;
  if (mediaChk) mediaChk.disabled = active || state.importing;
  // 服务端导入期间禁用本机导入入口,避免两个导入任务同时写同一个数据库。
  const localBusy = active || state.importing;
  ['startImportBtn', 'pickBackupBtn', 'pickDirBtn', 'pickZipBtn', 'resumeImportBtn', 'resumeBackupSelect']
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = localBusy;
    });
}

function renderServerJob() {
  const track = $('#serverImportProgressTrack');
  const fill = $('#serverImportProgressFill');
  const status = $('#serverImportStatus');
  if (!track || !fill || !status) return;
  const job = state.serverJob;
  if (!job || job.status === 'idle' || !job.id) {
    track.classList.add('hidden');
    fill.style.width = '0%';
    fill.classList.remove('is-indeterminate');
    status.textContent = '';
    status.className = 'hint';
    return;
  }

  const active = serverJobActive(job);
  track.classList.remove('hidden');
  if (job.percent !== null && job.percent !== undefined) {
    fill.classList.remove('is-indeterminate');
    fill.style.width = `${job.percent}%`;
  } else if (active) {
    fill.classList.add('is-indeterminate');
    fill.style.width = '';
  } else if (job.status === 'completed') {
    fill.classList.remove('is-indeterminate');
    fill.style.width = '100%';
  } else {
    fill.classList.remove('is-indeterminate');
    fill.style.width = '0%';
  }

  const device = job.deviceName ? `${job.deviceName} · ` : '';
  if (active) {
    status.className = 'hint';
    status.textContent = `${device}${job.text || '服务器正在导入...'}`;
    return;
  }
  if (job.status === 'completed') {
    const stats = job.stats || {};
    status.className = 'hint status-ok';
    status.textContent = `${device}导入完成:`
      + ` ${formatCount(stats.contactCount)} 个联系人,`
      + `${formatCount(stats.messageCount)} 条消息,`
      + `${formatCount(stats.mediaCount)} 个媒体文件`
      + (Number(stats.pendingMedia) > 0
        ? `;${formatCount(stats.pendingMedia)} 个媒体没有可用源文件`
        : '');
    return;
  }
  if (job.status === 'failed') {
    status.className = 'hint status-fail';
    status.textContent = `导入失败: ${job.error || '未知错误'}`;
    return;
  }
  if (job.status === 'interrupted') {
    status.className = 'hint status-fail';
    status.textContent = job.error || '导入已中断';
    return;
  }
  status.className = 'hint';
  status.textContent = job.text || '导入已停止';
}

async function refreshServerJobStatus() {
  if (!state.serverUrl || !state.secret) return;
  if (document.hidden) return;
  if (state.serverJobPolling) return;
  state.serverJobPolling = true;
  const previous = state.serverJob;
  try {
    const data = await api('/api/import/current');
    const next = data.job || null;
    state.serverJob = next;
    if (next && next.active && next.sourceKey) {
      const select = $('#serverBackupSelect');
      if (select && state.serverBackups.some((item) => item.key === next.sourceKey)) {
        select.value = next.sourceKey;
        state.serverBackupKey = next.sourceKey;
        localStorage.setItem(SERVER_BACKUP_KEY, next.sourceKey);
      }
    }
    renderServerJob();
    renderServerBackupHint();
    updateServerActionState();
    const previousActive = Boolean(previous
      && (previous.status === 'starting' || previous.status === 'running'));
    const nextFinished = Boolean(next
      && !next.active
      && ['completed', 'failed', 'cancelled', 'interrupted'].includes(next.status));
    if (previousActive && nextFinished) {
      refreshServerBackups();
      refreshIncompleteImports();
      if (next.status === 'completed') toast('服务器导入完成');
      else if (next.status === 'failed') toast('服务器导入失败', true);
    }
  } catch (err) {
    /* 轮询失败保留上一次状态,避免网络抖动时界面闪烁 */
  } finally {
    state.serverJobPolling = false;
  }
}

function startServerJobPolling() {
  state.serverJobGeneration += 1;
  const generation = state.serverJobGeneration;
  if (state.serverJobTimer) {
    clearTimeout(state.serverJobTimer);
    state.serverJobTimer = null;
  }
  const tick = async () => {
    if (generation !== state.serverJobGeneration) return;
    await refreshServerJobStatus();
    if (generation !== state.serverJobGeneration) return;
    if (!state.serverUrl || !state.secret) return;
    // 导入中更频繁地刷新;空闲/完成后降低轮询频率,避免持续刷服务器日志。
    state.serverJobTimer = setTimeout(tick, serverJobActive() ? 1500 : 5000);
  };
  tick();
}

async function startServerImport() {
  if (!state.serverUrl) {
    toast('请先配置并保存服务器地址', true);
    return;
  }
  if (!state.secret) {
    toast('请先填写访问 Secret', true);
    return;
  }
  if (state.importing) {
    toast('本机导入正在进行,请等待完成后再使用服务器导入', true);
    return;
  }
  if (serverJobActive()) {
    toast('服务器正在导入备份,请等待完成或先停止', true);
    return;
  }
  const item = currentServerBackup();
  if (!item) {
    toast('没有可导入的服务器备份', true);
    return;
  }
  if (item.import && item.import.completedAt) {
    const proceed = window.confirm(
      '该备份已经导入完成。再次导入会创建新的导入记录，用于合并之后新增的消息；'
      + '媒体文件可能重复占用服务器空间。\n\n仍要再次导入吗？'
    );
    if (!proceed) return;
  }

  state.serverIncludeMedia = $('#serverIncludeMediaChk').checked;
  localStorage.setItem(SERVER_INCLUDE_MEDIA_KEY, state.serverIncludeMedia ? '1' : '0');
  const startBtn = $('#startServerImportBtn');
  startBtn.disabled = true;
  startBtn.textContent = '启动中...';
  try {
    const data = await api('/api/import/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: item.key,
        includeMedia: state.serverIncludeMedia,
      }),
    });
    state.serverJob = data.job || null;
    renderServerJob();
    updateServerActionState();
    toast('已通知服务器开始导入');
    startServerJobPolling();
  } catch (err) {
    toast(err.message || '启动服务器导入失败', true);
    updateServerActionState();
    refreshServerJobStatus();
  }
}

async function cancelServerImport() {
  if (!serverJobActive()) return;
  const proceed = window.confirm('停止服务器导入？已写入的数据会保留，可稍后继续导入同一备份。');
  if (!proceed) return;
  try {
    const data = await api('/api/import/server/cancel', { method: 'POST' });
    state.serverJob = data.job || null;
    renderServerJob();
    updateServerActionState();
    toast('已停止服务器导入');
    refreshServerBackups();
    refreshIncompleteImports();
  } catch (err) {
    toast(err.message || '停止服务器导入失败', true);
    refreshServerJobStatus();
  }
}

function bindServerBackupControls() {
  $('#refreshServerBackupsBtn').addEventListener('click', refreshServerBackups);
  $('#serverBackupSelect').addEventListener('change', () => {
    state.serverBackupKey = $('#serverBackupSelect').value;
    localStorage.setItem(SERVER_BACKUP_KEY, state.serverBackupKey);
    renderServerBackupHint();
    updateServerActionState();
  });
  $('#serverIncludeMediaChk').checked = state.serverIncludeMedia;
  $('#serverIncludeMediaChk').addEventListener('change', () => {
    state.serverIncludeMedia = $('#serverIncludeMediaChk').checked;
    localStorage.setItem(SERVER_INCLUDE_MEDIA_KEY, state.serverIncludeMedia ? '1' : '0');
  });
  $('#startServerImportBtn').addEventListener('click', startServerImport);
  $('#cancelServerImportBtn').addEventListener('click', cancelServerImport);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshServerJobStatus();
  });
}

// ---------- 导入流程 ----------

function appendImportLog(text) {
  const el = $('#importLog');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.textContent += `[${time}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

function saveActiveImport(backupId) {
  const active = {
    backupId,
    serverUrl: state.serverUrl,
    backupDir: state.importDir || null,
    backupZip: state.importZip || null,
    includeMedia: state.includeMedia,
    startedAt: new Date().toISOString(),
  };
  state.activeImport = active;
  localStorage.setItem(ACTIVE_IMPORT_KEY, JSON.stringify(active));
}

function clearActiveImport() {
  state.activeImport = null;
  localStorage.removeItem(ACTIVE_IMPORT_KEY);
}

function setImporting(on) {
  state.importing = on;
  $('#startImportBtn').disabled = on;
  $('#startImportBtn').textContent = on ? '导入中...' : '开始解析并导入';
  $('#cancelImportBtn').classList.toggle('hidden', !on);
  $('#pickBackupBtn').disabled = on;
  $('#pickDirBtn').disabled = on;
  $('#pickZipBtn').disabled = on;
  $('#modifyServerBtn').disabled = on;
  if (on) setBackupMenuOpen(false);
  $('#resumeImportBtn').disabled = on;
  $('#resumeBackupSelect').disabled = on;
  updateServerActionState();
}

function formatResumeOption(item) {
  const date = item.createdAt || '未完成导入';
  const parts = [date];
  const messages = Number(item.messages) || 0;
  const contacts = Number(item.contacts) || 0;
  const pending = Number(item.pendingMedia) || 0;
  parts.push(messages > 0 ? `${messages.toLocaleString('zh-CN')} 条消息` : '尚未上传消息');
  if (contacts > 0) parts.push(`${contacts.toLocaleString('zh-CN')} 个联系人`);
  if (pending > 0) parts.push(`待补 ${pending.toLocaleString('zh-CN')} 个媒体`);
  return parts.join(' · ');
}

function currentResumeItem() {
  const id = $('#resumeBackupSelect').value;
  return state.incompleteImports.find((item) => item.id === id) || null;
}

function updateResumeHint() {
  const hint = $('#resumeHint');
  const item = currentResumeItem();
  if (!item) {
    hint.classList.add('hidden');
    return;
  }
  hint.classList.remove('hidden');
  const active = state.activeImport && state.activeImport.backupId === item.id
    ? state.activeImport
    : null;
  const source = item.sourcePath || active?.backupDir || active?.backupZip
    || state.importDir || state.importZip;
  hint.textContent = `继续导入会复用原导入记录，只补传缺失消息和媒体，不会生成新的 backup UUID。`
    + (source ? `来源：${source}` : '请先选择对应的备份目录或压缩包。');
}

function renderResumeOptions() {
  const row = $('#resumeRow');
  const select = $('#resumeBackupSelect');
  const hints = $('#resumeHint');
  const items = state.incompleteImports.slice();
  const active = state.activeImport;
  if (active && !items.some((item) => item.id === active.backupId)) {
    items.unshift({
      id: active.backupId,
      createdAt: active.startedAt || '',
      messages: 0,
      contacts: 0,
      pendingMedia: 0,
      sourcePath: active.backupDir || active.backupZip || '',
    });
  }
  if (items.length === 0) {
    row.classList.add('hidden');
    hints.classList.add('hidden');
    select.innerHTML = '';
    state.resumeBackupId = null;
    return;
  }

  row.classList.remove('hidden');
  const preferred = state.resumeBackupId || active?.backupId || select.value;
  select.innerHTML = items.map((item) => (
    `<option value="${esc(item.id)}">${esc(formatResumeOption(item))}</option>`
  )).join('');
  const selected = items.find((item) => item.id === preferred) || items[0];
  select.value = selected.id;
  state.resumeBackupId = selected.id;
  updateResumeHint();
}

async function refreshIncompleteImports() {
  if (!state.serverUrl || !state.secret) {
    renderResumeOptions();
    return;
  }
  try {
    const data = await api('/api/import/incomplete');
    state.incompleteImports = (Array.isArray(data.items) ? data.items : [])
      .filter((item) => item.source !== 'server');
    if (!state.importing && state.activeImport
      && !state.incompleteImports.some((item) => item.id === state.activeImport.backupId)) {
      clearActiveImport();
    }
  } catch (err) {
    /* 服务端暂时不可用时保留本地 activeImport 作为继续入口 */
  }
  renderResumeOptions();
}

async function beginImport(backupId) {
  if (!state.serverUrl) {
    toast('请先配置并保存服务器地址', true);
    return;
  }
  if (!state.secret) {
    toast('请先填写访问 Secret(项目根目录 config.json 中的 secret)', true);
    return;
  }
  if (!state.importDir && !state.importZip) {
    toast('请先选择 iOS 备份目录或 zip 压缩包', true);
    return;
  }
  if (serverJobActive()) {
    toast('服务器正在从 NAS 导入备份,请等待完成或先停止', true);
    return;
  }
  state.includeMedia = $('#includeMediaChk').checked;
  localStorage.setItem('wepo.includeMedia', state.includeMedia ? '1' : '0');
  state.importBackupId = backupId || null;
  state.resumeBackupId = backupId || null;
  setImporting(true);
  $('#importProgressTrack').classList.remove('hidden');
  $('#importProgressFill').style.width = '0%';
  $('#importStatus').textContent = '';
  const logEl = $('#importLog');
  logEl.classList.remove('hidden');
  logEl.textContent = '';
  appendImportLog(
    `${backupId ? '继续导入' : '开始导入'}(${state.importZip ? '压缩包' : '目录'})...`
  );

  try {
    await window.wepo.startImport({
      backupDir: state.importDir || null,
      backupZip: state.importZip || null,
      serverUrl: state.serverUrl,
      secret: state.secret,
      includeMedia: state.includeMedia,
      backupId: backupId || null,
    });
  } catch (err) {
    setImporting(false);
    appendImportLog(`启动失败: ${err.message}`);
    toast(`启动失败: ${err.message}`, true);
    refreshIncompleteImports();
  }
}

async function startImport() {
  // 先刷新一次,避免服务端未完成记录还没加载出来就新建导入、产生重复数据。
  await refreshIncompleteImports();
  if (state.incompleteImports.length > 0 || state.activeImport) {
    const proceed = window.confirm(
      '检测到未完成的导入。建议点击“继续导入”从当前进度补传,避免重复占用磁盘。\n\n仍要创建一次新的导入吗?'
    );
    if (!proceed) return;
  }
  await beginImport(null);
}

async function startResume() {
  const item = currentResumeItem();
  const backupId = item?.id || state.resumeBackupId || state.activeImport?.backupId;
  if (!backupId) {
    toast('没有可继续的导入记录', true);
    return;
  }
  const active = state.activeImport && state.activeImport.backupId === backupId
    ? state.activeImport
    : null;
  const source = item?.sourcePath || active?.backupDir || active?.backupZip;
  if (source) {
    const sourceExists = await window.wepo.pathExists(source);
    if (sourceExists) {
      setImportSource(source);
    } else if (!state.importDir && !state.importZip) {
      toast('原备份路径已不可用，请选择同一备份的目录或压缩包后继续', true);
      return;
    } else {
      appendImportLog(`原备份路径已不可用: ${source}，将使用当前选择的备份来源`);
    }
  }
  if (!state.importDir && !state.importZip) {
    toast('请先选择该未完成导入对应的备份目录或压缩包', true);
    return;
  }
  await beginImport(backupId);
}

async function cancelImport() {
  try {
    await window.wepo.cancelImport();
  } catch (err) {
    appendImportLog(`停止失败: ${err.message}`);
  }
  setImporting(false);
  appendImportLog('已停止导入。已上传的数据会保留，可点击“继续导入”从当前进度补传。');
  toast('已停止导入，进度已保留');
  refreshIncompleteImports();
}

function handleImportEvent(payload) {
  if (!state.importing && payload.event !== 'done') return;
  switch (payload.event) {
    case 'started':
      state.importBackupId = payload.backupId;
      state.resumeBackupId = payload.backupId;
      saveActiveImport(payload.backupId);
      break;
    case 'stage':
      $('#importStatus').textContent = payload.text;
      appendImportLog(payload.text);
      break;
    case 'summary':
      appendImportLog(
        `解析结果: 设备 ${payload.deviceName} · 账号 ${payload.userCount} 个 · 联系人 ${payload.contactCount} 个 · 消息 ${payload.messageCount} 条`
      );
      break;
    case 'progress': {
      const stagePercent = Number(payload.stagePercent);
      if (Number.isFinite(stagePercent)) {
        $('#importProgressFill').style.width = `${Math.max(0, Math.min(100, stagePercent))}%`;
      } else if (payload.total > 0) {
        const percent = Math.round((payload.done / payload.total) * 100);
        $('#importProgressFill').style.width = `${percent}%`;
      }
      $('#importStatus').textContent = payload.text;
      break;
    }
    case 'log':
      appendImportLog(payload.text);
      break;
    case 'error':
      setImporting(false);
      appendImportLog(`错误: ${payload.message}`);
      $('#importStatus').textContent =
        `导入失败: ${payload.message}（已上传数据会保留，可在“未完成导入”中继续；`
        + '若没有记录，说明尚未写入服务端数据或服务端已完成，可直接重新开始）';
      toast('导入失败，可从未完成导入继续', true);
      refreshIncompleteImports();
      break;
    case 'done':
      setImporting(false);
      clearActiveImport();
      state.importBackupId = null;
      state.resumeBackupId = null;
      $('#importProgressFill').style.width = '100%';
      $('#importStatus').textContent =
        `导入完成: ${payload.stats.contactCount} 个联系人,${payload.stats.messageCount} 条消息,${payload.stats.mediaCount} 个媒体文件`
        + (payload.stats.pendingMedia > 0
          ? `；仍有 ${payload.stats.pendingMedia} 个媒体消息没有可用源文件`
          : '');
      appendImportLog(`导入完成: ${JSON.stringify(payload.stats)}`);
      toast('导入完成,可在服务端页面查看数据');
      refreshIncompleteImports();
      break;
    default:
      break;
  }
}

// ---------- 初始化 ----------

function init() {
  bindServer();
  bindBackupPick();
  bindServerBackupControls();
  $('#startImportBtn').addEventListener('click', startImport);
  $('#cancelImportBtn').addEventListener('click', cancelImport);
  $('#resumeImportBtn').addEventListener('click', startResume);
  $('#resumeBackupSelect').addEventListener('change', () => {
    state.resumeBackupId = $('#resumeBackupSelect').value;
    updateResumeHint();
  });
  window.wepo.onImportEvent(handleImportEvent);
  $('#includeMediaChk').checked = state.includeMedia;
  $('#includeMediaChk').addEventListener('change', () => {
    state.includeMedia = $('#includeMediaChk').checked;
    localStorage.setItem('wepo.includeMedia', state.includeMedia ? '1' : '0');
  });
  if (hasSavedServerSettings()) showMain();
  else showSetup(false);
}

document.addEventListener('DOMContentLoaded', init);
