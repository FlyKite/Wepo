/**
 * 网页查看器逻辑(微信 PC 风格):聊天 / 通讯录 / 数据管理。
 * 与服务端同源,API 使用相对路径;数据可由微仓助手或服务端 NAS 导入。
 */

/* eslint-disable no-use-before-define */

const $ = (sel) => document.querySelector(sel);

const THEME_KEY = 'wepo.theme';
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const savedTheme = localStorage.getItem(THEME_KEY);
const initialTheme = savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system'
  ? savedTheme
  : 'system';

let wxEmojiMap = new Map();
let wxEmojiRegex = null;
const WX_EMOJI_ASSET_VERSION = '20261124b';

const state = {
  view: 'chats', // chats | contacts | data
  secret: localStorage.getItem('wepo.secret') || '',
  theme: initialTheme, // system | light | dark
  appStarted: false,
  contacts: [],
  contactsPage: 1,
  contactsTotal: 0,
  contactsHasMore: false,
  contactsLoading: false,
  contactsLoaded: false,
  listRequestIds: { chats: 0, contacts: 0 },
  listPending: { chats: null, contacts: null }, // 在途的全量列表请求,切回 tab 时复用
  contactsSearch: '',
  contactsOrder: 'time',
  contactGroups: null, // 联系人视图的首字母分组
  contactSubpage: null, // 通讯录子页面:标签/群聊
  contactSubpageHistoryDepth: 0,
  contactSubpageRequestId: 0,
  listCache: { chats: null, contacts: null },
  searchOverlayOpen: false, // 独立搜索页是否展开(仅移动端单栏)
  searchMode: null, // overlay(移动端二级页) | inline(PC/分栏列表内搜索)
  searchQuery: '',
  searchHistoryDepth: 0, // 移动端搜索页/分类页对应的 history 层数
  searchResults: null, // 搜索页 联系人/群聊/聊天记录 分组结果
  searchLoading: false,
  searchRequestId: 0,
  searchPage: null, // 搜索页内点击“更多xx”后的分类结果
  searchPageRequestId: 0,
  searchCache: new Map(),
  selectedMessageId: null,
  pendingMessageFocusId: null,
  dataCache: null,
  dataRequestId: 0,
  users: [],
  currentOwner: localStorage.getItem('wepo.owner') || '',
  selected: null, // 当前选中联系人(dto)
  messages: [],
  messagePage: 1,
  messageHasMore: false,
  messageHasNewer: false,
  messageDateMode: false,
  messageOlderCursor: null,
  messageNewerCursor: null,
  messageAnchorId: null,
  messagesLoading: false,
  messagesLoadingNewer: false,
  messagesRestoringScroll: false,
  messagesScrollRestoreToken: 0,
  messagesPointerActive: false,
  messagesLastScrollAt: 0,
  messagesWheelUntil: 0,
  messagesLoadArmed: true, // 一次触顶只加载一页，向下离开顶部后才能再次触发
  messagesOlderLoadLocked: false, // 更早一页加载后锁定,直到新手势/滚轮批次开始
  messagesNewerArmed: true, // 日期窗口模式下，滑到底部只自动加载一页
  messagesLastScrollTop: 0,
  messagesLayoutAnchor: null,
  messagesLayoutAnchorTop: 0,
  messagesLayoutObserver: null,
  messagesRequestId: 0,
  chatSearch: '',
  chatSearchFilterTotal: 0,
  chatSearchPageOpen: false,
  chatSearchPage: null,
  chatSearchPageRequestId: 0,
  dateJumpOpen: false, // 从日期/分类列表进入的独立消息列表页,返回时回到来源页
  messageJumpSource: '', // date | category
  chatFromContactDetail: false, // 从通讯录联系人详情进入的聊天页,返回时先回详情
  chatContactDetailOpen: false,
  chatRecordDetailOpen: false,
  dataSourceOpen: false,
  dataSourceItems: [],
  dataSourceRoot: '',
  dataSourceError: '',
  dataSourceLoading: false,
  dataSourceRequestId: 0,
  serverImportJob: null,
  // 只有在本页面会话中观察到任务运行过,才展示结束后的进度;刷新页面后
  // 不显示旧的完成状态,避免把上次导入误认为当前进度。
  serverImportSeenActive: false,
  serverImportTimer: null,
  serverImportPolling: false,
};

const MESSAGE_LOAD_TOP = 120;
const MESSAGE_LOAD_BOTTOM = 120;
const MESSAGE_REARM_DISTANCE = 180;
const MESSAGE_WHEEL_GAP = 250;
const MESSAGE_PAGE_SIZE = 30;
const MESSAGE_DATE_BEFORE = 50;
const MESSAGE_DATE_AFTER = 49;
const MESSAGE_DATE_PAGE_SIZE = MESSAGE_DATE_BEFORE + 1 + MESSAGE_DATE_AFTER;
const SEARCH_PAGE_SIZE = 50;
const CHAT_SEARCH_GALLERY_MONTH_PAGE_SIZE = 500;

// 进入日期消息页前保存原消息列表,返回聊天页时恢复(两者不共用 messages/滚动位置)
let savedMessagePageState = null;
// 引用跳转替换消息列表前保存原列表,点击“回到引用位置”时恢复
let quoteJumpReturnState = null;
// 引用目标已在当前列表时,只记录跳转前视口位置
let quoteLoadedReturnAnchor = null;
// 移动端详情页会隐藏联系人列表并可能丢失 scrollTop,单独记录返回时位置
let contactListReturnScrollTop = null;
let chatRecordDetailStack = [];
let chatRecordDetailHistoryDepth = 0;

// ---------- 主题 ----------

/** 当前实际生效的外观:强制深/浅色,或跟随系统 */
function resolvedTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return systemThemeQuery.matches ? 'dark' : 'light';
}

/** 应用外观到 <html data-theme>,并同步浏览器状态栏颜色 */
function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#1c1c1c' : '#ededed');
}

/** 监听系统外观变化(仅"跟随系统"时生效) */
function setupTheme() {
  applyTheme();
  const onChange = () => {
    if (state.theme === 'system') applyTheme();
  };
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', onChange);
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(onChange);
  }
}

// ---------- 工具函数 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatListTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, yest)) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMsgTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDay(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  // 日期分隔条同时显示该天第一条消息的时间(24 小时制)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 用于判断是否跨天;不能把时间算进去,否则每条消息都会生成一个日期分隔条 */
function formatDayKey(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 替换落单的 UTF-16 代理项,避免 encodeURIComponent 抛 URIError */
function toWellFormed(value) {
  const str = String(value ?? '');
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += str[i];
    }
  }
  return out;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function fallbackAvatar(name, hash) {
  const raw = String(name || '微');
  const ch = escapeXml(toWellFormed(Array.from(raw)[0] || '微'));
  const colors = ['#5a9ef8', '#f59b3f', '#53c36a', '#e4668c', '#8d6fe0', '#4ec0c4', '#d38b4a', '#6b9bd8'];
  let h = 0;
  for (const c of String(hash || name || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const color = colors[h % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76"><rect width="76" height="76" rx="8" fill="${color}"/><text x="38" y="52" font-size="36" fill="#fff" text-anchor="middle" font-family="sans-serif">${ch}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(toWellFormed(svg));
}

function avatarUrl(contact) {
  if (contact && contact.avatar) return mediaUrl(contact.avatar); // 背景图无法带请求头,用 ?secret=
  return fallbackAvatar(contact && (contact.remark || contact.nickname || contact.username), contact && contact.hash);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 加载微信内置表情标签到本地图片的映射(静态资源,不含聊天数据) */
async function loadWxEmojiMap() {
  if (wxEmojiRegex) return;
  try {
    const res = await fetch('/wx-emoji/emoji.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const groups = await res.json();
    const map = new Map();
    for (const group of Array.isArray(groups) ? groups : []) {
      const pre = String(group.preTag || '');
      const post = String(group.postTag || '');
      for (const item of Array.isArray(group.keys) ? group.keys : []) {
        const key = String(item.key || '');
        const file = String(item.file || '');
        if (!key || !file) continue;
        const token = `${pre}${key}${post}`;
        if (!map.has(token)) map.set(token, file);
      }
    }
    if (map.size === 0) return;
    const tokens = [...map.keys()].sort((a, b) => b.length - a.length);
    wxEmojiMap = map;
    wxEmojiRegex = new RegExp(tokens.map(escapeRegExp).join('|'), 'g');
  } catch (err) {
    console.warn('[emoji] 微信内置表情资源加载失败:', err.message);
  }
}

/** 转义文本,并把 [微笑] / /微笑 / /:) 等微信表情标签换成图片 */
function renderTextWithEmoji(value) {
  const raw = String(value || '');
  if (!wxEmojiRegex) return esc(raw);
  wxEmojiRegex.lastIndex = 0;
  let out = '';
  let last = 0;
  let match;
  while ((match = wxEmojiRegex.exec(raw)) !== null) {
    const token = match[0];
    out += esc(raw.slice(last, match.index));
    const file = wxEmojiMap.get(token);
    if (file) {
      out += `<img class="msg-wxemoji" src="/wx-emoji/images/${encodeURIComponent(file)}.png?v=${WX_EMOJI_ASSET_VERSION}" alt="${esc(token)}" loading="lazy" />`;
    } else {
      out += esc(token);
    }
    last = match.index + token.length;
  }
  return out + esc(raw.slice(last));
}

function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch (err) {
    return '';
  }
}

function urlHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch (err) {
    return '';
  }
}

function cardMain(title, desc, meta) {
  const titleHtml = title ? `<div class="msg-card-title">${esc(title)}</div>` : '';
  const descHtml = desc ? `<div class="msg-card-desc">${esc(desc).replace(/\n/g, '<br>')}</div>` : '';
  const metaHtml = meta ? `<div class="msg-card-meta">${esc(meta)}</div>` : '';
  return `<div class="msg-card-main">${titleHtml}${descHtml}${metaHtml}</div>`;
}

function appCardIcon(symbol) {
  return `<div class="msg-card-icon">${symbol}</div>`;
}

/** 微信旧数据里可能把空字段序列化成字符串 "(null)" */
function cleanCardText(value) {
  const text = String(value || '').trim();
  return text === '(null)' || text === 'null' ? '' : text;
}

/** 小程序分享图/图标只允许 https,避免混合内容;http 地址自动升级 */
function safeCardImageUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    return parsed.toString();
  } catch (err) {
    return '';
  }
}

function miniappLogoSymbol(title) {
  const chars = Array.from(String(title || '').trim());
  return chars.length > 0 ? chars[0] : '小';
}

function miniappLogoUrl(extra) {
  const weapp = extra.weapp && typeof extra.weapp === 'object' ? extra.weapp : {};
  const candidates = [
    extra.iconurl,
    extra.iconUrl,
    extra.weappiconurl,
    weapp.iconurl,
    weapp.iconUrl,
    weapp.appiconurl,
  ];
  for (const candidate of candidates) {
    const url = safeCardImageUrl(candidate);
    if (url) return url;
  }
  return '';
}

/** 小程序卡片:应用名/交易保障 + 消息文字 + 分享图 + 底部“小程序” */
function renderMiniappCard(m, extra) {
  const weapp = extra.weapp && typeof extra.weapp === 'object' ? extra.weapp : {};
  const appName = cleanCardText(weapp.appName)
    || cleanCardText(extra.sourceDisplayName)
    || '小程序';
  const description = cleanCardText(extra.title) || cleanCardText(extra.des);
  const serviceType = cleanCardText(weapp.serviceType);
  const badge = serviceType && serviceType !== '0'
    ? '<span class="miniapp-card-badge">交易保障</span>'
    : '';
  const logoUrl = miniappLogoUrl(extra);
  const logoSymbol = esc(miniappLogoSymbol(appName));
  const logoHtml = logoUrl
    ? `<div class="miniapp-card-logo miniapp-card-logo--image" style="background-image:url('${esc(logoUrl)}')"></div>`
    : `<div class="miniapp-card-logo">${logoSymbol}</div>`;
  const { src: coverUrl, fallback: coverFallback } = linkThumbnailInfo(m, extra);
  const coverHtml = coverUrl
    ? `<div class="miniapp-card-cover"><img class="msg-card-cover-img" src="${esc(coverUrl)}"${coverFallback ? ` data-fallback-src="${esc(coverFallback)}"` : ''} alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
    : '';
  const miniIcon = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M8.4 8.5a5 5 0 0 1 7 0l.6.6a5 5 0 0 1-7 7l-.9-.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path>
    <path d="M15.6 15.5a5 5 0 0 1-7 0l-.6-.6a5 5 0 0 1 7-7l.9.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"></path>
  </svg>`;
  return `
    <div class="msg-card msg-card--miniapp">
      <div class="miniapp-card-header">
        ${logoHtml}
        <div class="miniapp-card-app">
          <span class="miniapp-card-appname">${esc(appName)}</span>
          ${badge}
        </div>
      </div>
      ${description ? `<div class="miniapp-card-desc">${esc(description).replace(/\n/g, '<br>')}</div>` : ''}
      ${coverHtml}
      <div class="miniapp-card-footer">${miniIcon}<span>小程序</span></div>
    </div>`;
}

/** 红包卡片:左侧红包图标 + 祝福语 + 底部“红包” */
function renderRedPacketCard(m, extra) {
  const pay = extra.pay && typeof extra.pay === 'object' ? extra.pay : {};
  const greeting = cleanCardText(m.isSent ? pay.senderTitle : pay.receiveTitle)
    || cleanCardText(pay.receiveTitle)
    || cleanCardText(pay.senderTitle)
    || cleanCardText(extra.des)
    || cleanCardText(extra.title)
    || '微信红包';
  const envelope = `<svg viewBox="0 0 48 60" width="34" height="43" aria-hidden="true">
    <rect x="2" y="2" width="44" height="56" rx="7" fill="#e75a49"></rect>
    <path d="M2 15c7.5 9.5 15.5 13.5 22 13.5S38.5 24.5 46 15V9a7 7 0 0 0-7-7H9a7 7 0 0 0-7 7z" fill="#c94334"></path>
    <circle cx="24" cy="33" r="9" fill="#f2c65a"></circle>
    <text x="24" y="38" text-anchor="middle" font-size="12" font-weight="700" fill="#b47b12">¥</text>
  </svg>`;
  return `
    <div class="msg-card msg-card--pay msg-card--redpacket">
      <div class="pay-card-main">
        <div class="pay-card-icon pay-card-icon--redpacket">${envelope}</div>
        <div class="pay-card-body">
          <div class="pay-card-title">${esc(greeting)}</div>
        </div>
      </div>
      <div class="pay-card-footer">红包</div>
    </div>`;
}

/** 转账卡片:金额/状态从旧版转账文案中提取,布局参照微信转账消息 */
function renderTransferCard(m, extra) {
  const pay = extra.pay && typeof extra.pay === 'object' ? extra.pay : {};
  const raw = [
    cleanCardText(extra.des),
    cleanCardText(m.content),
    cleanCardText(pay.receiverDesc),
    cleanCardText(pay.senderDesc),
    cleanCardText(pay.hintText),
    cleanCardText(pay.receiveStatus),
  ].filter(Boolean).join(' ');

  const payerName = cleanCardText(pay.payerName);
  const receiverName = cleanCardText(pay.receiverName);
  const rawAmountMatch = raw.match(/[￥¥]?\s*([\d,]+(?:\.\d{1,2})?)\s*元/);
  const feeAmount = Number(cleanCardText(pay.feeDesc).replace(/[^\d.]/g, ''));
  const amountNumber = rawAmountMatch
    ? Number(rawAmountMatch[1].replace(/,/g, ''))
    : (Number.isFinite(feeAmount) ? feeAmount : NaN);
  const amountText = Number.isFinite(amountNumber) && amountNumber > 0
    ? `¥${amountNumber.toFixed(2)}`
    : '';

  // 新数据由服务端根据 payer_username / receiver_username 解析姓名
  let title = '';
  if (m.isSent && receiverName) title = `向${receiverName}转账`;
  else if (!m.isSent && payerName) title = `${payerName}向你转账`;

  if (!title) {
    title = '转账';
    if (rawAmountMatch) {
      const before = raw.slice(0, rawAmountMatch.index).trim()
        .replace(/^\[转账\]\s*/, '')
        .replace(/。$/, '');
      if (before && before.length <= 30 && before.includes('转账')) title = before;
    } else {
      title = raw.replace(/^\[转账\]\s*/, '').trim() || cleanCardText(extra.title) || '转账';
    }
  }
  // 旧版转账文案统一是“收到转账”,自己发出的转账不显示成“收到”
  if (m.isSent && /^收到转账/.test(title)) title = '转账';

  const statuses = ['已被接收', '已接收', '已收款', '已到账', '已存入零钱', '待收款', '已退还', '已过期'];
  const status = statuses.find((item) => raw.includes(item)) || '';

  const checkIcon = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path d="M5.5 12.5 10 17l8.5-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>`;
  return `
    <div class="msg-card msg-card--pay msg-card--transfer">
      <div class="pay-card-main">
        <div class="pay-card-icon pay-card-icon--transfer">${checkIcon}</div>
        <div class="pay-card-body">
          <div class="pay-card-title">${esc(title)}</div>
          ${amountText ? `<div class="pay-card-amount">${esc(amountText)}</div>` : ''}
          ${status ? `<div class="pay-card-status">${esc(status)}</div>` : ''}
        </div>
      </div>
      <div class="pay-card-footer">转账</div>
    </div>`;
}

/** 链接缩略图:本地导入优先,其次 thumburl,最后服务端按需读取原备份 */
function linkThumbnailInfo(m, extra) {
  const stored = m.mediaKind === 'link_thumb' && m.mediaPath ? mediaUrl(m.mediaPath) : '';
  const remote = safeCardImageUrl(extra.thumburl);
  const local = m.id ? mediaUrl(`/api/messages/${m.id}/link-thumb`) : '';
  const src = stored || remote || local;
  return { src, fallback: src && src !== local ? local : '' };
}

/** 链接来源名:优先 XML 中的公众号/应用名,旧数据按域名回退 */
function linkSourceLabel(extra, host) {
  const explicit = cleanCardText(extra.sourceDisplayName);
  if (explicit) return explicit;
  const normalized = String(host || '').toLowerCase();
  if (!normalized) return '网页链接';
  if (normalized === 'mp.weixin.qq.com') return '微信公众号文章';
  if (normalized.endsWith('xiaohongshu.com')) return '小红书';
  if (normalized.endsWith('jd.com')) return '京东';
  if (normalized.endsWith('taobao.com')) return '淘宝';
  if (normalized.endsWith('tmall.com')) return '天猫';
  if (normalized.endsWith('pinduoduo.com') || normalized.endsWith('yangkeduo.com')) return '拼多多';
  if (normalized.endsWith('douyin.com')) return '抖音';
  if (normalized.endsWith('bilibili.com') || normalized === 'b23.tv') return '哔哩哔哩';
  if (normalized.endsWith('weibo.com')) return '微博';
  if (normalized.endsWith('zhihu.com')) return '知乎';
  return host;
}

/** 视频分享卡缩略图上的播放按钮:纯装饰,不拦截卡片点击 */
function linkPlayButtonHtml() {
  return `<span class="link-card-play" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5z" fill="currentColor"></path>
    </svg>
  </span>`;
}

/** 链接卡片:标题、描述 + 右侧缩略图、底部来源 */
function renderLinkCard(m, extra, url, host) {
  const rawTitle = cleanCardText(extra.title);
  const rawDesc = cleanCardText(extra.des);
  const title = rawTitle || rawDesc || '链接';
  const desc = rawTitle && rawDesc ? rawDesc : '';
  const isVideo = Number(extra.appType) === 4;
  const { src: thumbUrl, fallback: thumbFallback } = linkThumbnailInfo(m, extra);
  const sourceName = linkSourceLabel(extra, host);
  const bodyHtml = desc || thumbUrl
    ? `<div class="link-card-body">
        ${desc ? `<div class="link-card-desc">${esc(desc).replace(/\n/g, '<br>')}</div>` : '<div class="link-card-desc"></div>'}
        ${thumbUrl ? `<div class="link-card-thumb"><img class="link-card-thumb-img" src="${esc(thumbUrl)}"${thumbFallback ? ` data-fallback-src="${esc(thumbFallback)}"` : ''} alt="" loading="lazy" referrerpolicy="no-referrer">${isVideo ? linkPlayButtonHtml() : ''}</div>` : ''}
      </div>`
    : '';
  const sourceIcon = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M4 5.6c2.6-1 5.2-.9 8 .7v13.1c-2.8-1.6-5.4-1.7-8-.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
    <path d="M20 5.6c-2.6-1-5.2-.9-8 .7v13.1c2.8-1.6 5.4-1.7 8-.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
  </svg>`;
  const inner = `
    <div class="link-card-title">${esc(title)}</div>
    ${bodyHtml}
    <div class="link-card-source">${sourceIcon}<span>${esc(sourceName)}</span></div>`;
  return url
    ? `<a class="msg-card msg-card--link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="msg-card msg-card--link">${inner}</div>`;
}

/** 视频号标题:去掉“作者名+的视频”这类由字段拼出的泛标题 */
function channelsDisplayTitle(extra, finder, author) {
  const title = cleanCardText(finder.desc) || cleanCardText(extra.title) || '';
  if (!title || (author && title === author)) return '';
  if (author && (title === `${author}的视频` || title === `${author}视频`)) return '';
  return title;
}

/** 视频号分享卡:封面 + 标题 + 作者,按搜索列表的卡片样式渲染 */
function renderChannelsCard(m, extra) {
  const finder = extra.finder && typeof extra.finder === 'object' ? extra.finder : {};
  const author = cleanCardText(finder.nickname) || cleanCardText(extra.sourceDisplayName) || '视频号';
  const finderCover = safeCardImageUrl(finder.thumbUrl || finder.coverUrl);
  const localCover = m.id ? mediaUrl(`/api/messages/${m.id}/link-thumb`) : '';
  const cover = finderCover || localCover;
  const avatar = safeCardImageUrl(finder.avatar || extra.avatarUrl)
    || fallbackAvatar(author, finder.username || author || m.id);
  // 消息列表卡片只保留封面、播放按钮和底部来源;标题/描述不覆盖在图上。
  const authorHtml = `<div class="channels-card-author-overlay">
    <span class="channels-card-avatar" style="background-image:url('${esc(avatar)}')"></span>
    <span class="channels-card-author">${esc(author)}</span>
  </div>`;
  const coverHtml = cover
    ? `<div class="channels-card-cover"><img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="channels-card-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M7.7 6.7v10.6l8.6-5.3z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path></svg>
        </span>
        ${authorHtml}
      </div>`
    : `<div class="channels-card-cover channels-card-cover--empty">
        <span class="channels-card-empty-icon">▶</span>
        ${authorHtml}
      </div>`;
  return `<div class="msg-card msg-card--channels">${coverHtml}</div>`;
}

/** 合并转发聊天记录卡片的预览行 */
function chatRecordPreviewLines(extra, limit = 3) {
  const records = extra && Array.isArray(extra.records) ? extra.records : [];
  const lines = [];
  for (const record of records) {
    const name = String(record && record.sourceName || '').replace(/\s+/g, ' ').trim();
    const text = String((record && (record.text || record.desc || record.title)) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    lines.push(name ? `${name}: ${text}` : text);
    if (lines.length >= limit) break;
  }
  let total = records.length;
  if (lines.length === 0) {
    const fallback = String(extra && extra.des || '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    total = fallback.length;
    lines.push(...fallback.slice(0, limit));
  }
  if (total > limit && lines.length > 0) lines[lines.length - 1] += '…';
  return lines;
}

/** 合并转发聊天记录卡片(按聊天记录卡片.jpg) */
function renderChatRecordCard(m, extra) {
  const title = cleanCardText(extra.title || extra.recordTitle) || '聊天记录';
  const lines = chatRecordPreviewLines(extra);
  const preview = lines.length
    ? lines.map((line) => `<div class="record-card-line">${renderTextWithEmoji(line)}</div>`).join('')
    : '';
  return `<div class="msg-card msg-card--record" role="button" tabindex="0" data-chat-record-message-id="${m.id}" aria-label="查看${esc(title)}">
    <div class="record-card-title">${esc(title)}</div>
    ${preview ? `<div class="record-card-preview">${preview}</div>` : ''}
    <div class="record-card-footer">聊天记录</div>
  </div>`;
}

/** type 49 应用消息卡片:链接/文件/红包/转账/小程序/音乐/视频/引用/聊天记录 */
function renderAppCard(m) {
  const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
  const appType = Number(extra.appType) || 0;
  const title = String(extra.title || '').trim();
  const desc = String(extra.des || '').trim();
  const url = safeHttpUrl(extra.url);
  const host = urlHost(url);
  const fileExt = String(extra.fileExt || extra.fileName || '').replace(/^\./, '').toUpperCase();
  const anchor = (classes, body) => (url
    ? `<a class="msg-card ${classes}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${body}</a>`
    : `<div class="msg-card ${classes}">${body}</div>`);
  const box = (classes, body) => `<div class="msg-card ${classes}">${body}</div>`;

  if (appType === 51) {
    if (extra.finder) return renderChannelsCard(m, extra);
    // 没有 finderFeed 的旧占位消息不再显示“请升级 App”的链接卡。
    return box('msg-card--generic', `${appCardIcon('▶')}${cardMain('视频号', '', '视频号')}`);
  }
  if (appType === 2001) {
    return renderRedPacketCard(m, extra);
  }
  if (appType === 2000) {
    return renderTransferCard(m, extra);
  }
  if (appType === 6) {
    return box('msg-card--file', `${appCardIcon('📄')}${cardMain(title || '文件', '', `文件${fileExt ? ` · ${fileExt}` : ''}`)}`);
  }
  // appType 19 合并转发聊天记录。
  if (appType === 19) {
    return renderChatRecordCard(m, extra);
  }
  if (appType === 53) {
    const lines = (title || desc || '群接龙').split('\n');
    return box('msg-card--note', `${appCardIcon('📋')}${cardMain(lines[0], lines.slice(1).join('\n'), '群接龙')}`);
  }
  if ([3, 76, 92, 996].includes(appType)) {
    return anchor('msg-card--music', `${appCardIcon('♪')}${cardMain(title || '音乐', desc, '音乐')}`);
  }
  if (appType === 4) {
    // 微信的“视频”应用消息本质上是带标题/描述/链接的视频分享,
    // 与链接消息共用同一套卡片样式,并按链接打开。
    return renderLinkCard(m, extra, url, host);
  }
  if ([33, 36].includes(appType)) {
    return renderMiniappCard(m, extra);
  }
  if (appType === 5 || url) {
    return renderLinkCard(m, extra, url, host);
  }
  return box('msg-card--generic', `${appCardIcon('💬')}${cardMain(title || m.content || '消息', desc, '消息')}`);
}

/** 去掉引用摘要里的类型前缀,用于卡片标题和纯文本兜底 */
function quoteReferText(value) {
  return String(value || '')
    .replace(/^\[(链接|视频号|文件|小程序|聊天记录|音乐|红包|转账|位置|名片|动画表情|语音|视频|图片)\]\s*/, '')
    .trim();
}

/** 引用视频号/链接:在引用块内使用紧凑的链接卡样式 */
function renderQuoteCard(refer, name, isChannels) {
  const appType = Number(refer.appType) || 0;
  const finder = refer.finder && typeof refer.finder === 'object' ? refer.finder : null;
  const isVideo = isChannels || appType === 4;
  const title = quoteReferText(
    isChannels
      ? (cleanCardText(finder && finder.desc) || cleanCardText(refer.title) || refer.content)
      : (cleanCardText(refer.title) || cleanCardText(refer.des) || refer.content)
  ) || (isChannels ? '视频号' : '链接');
  const author = cleanCardText(finder && finder.nickname)
    || cleanCardText(refer.sourceDisplayName)
    || '';
  const url = safeHttpUrl(refer.url);
  const source = isChannels
    ? `视频号${author ? ` · ${author}` : ''}`
    : (linkSourceLabel(refer, urlHost(url)) || '链接');
  const thumb = safeCardImageUrl(
    isChannels
      ? (cleanCardText(finder && finder.thumbUrl) || cleanCardText(finder && finder.coverUrl) || cleanCardText(refer.thumbUrl))
      : cleanCardText(refer.thumbUrl)
  );
  const thumbHtml = thumb
    ? `<div class="msg-quote-card-thumb"><img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">${isVideo ? linkPlayButtonHtml() : ''}</div>`
    : (isVideo
      ? `<div class="msg-quote-card-thumb msg-quote-card-thumb--empty"><span aria-hidden="true">▶</span></div>`
      : '');
  const card = `<div class="msg-quote-card">
    <div class="msg-quote-card-main">
      <div class="msg-quote-card-title">${esc(title)}</div>
      <div class="msg-quote-card-source">${esc(source)}</div>
    </div>
    ${thumbHtml}
  </div>`;
  const cardHtml = url
    ? `<a class="msg-quote-card-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${card}</a>`
    : card;
  const label = name ? `<div class="msg-quote-name msg-quote-name--card">${esc(name)}</div>` : '';
  return {
    refHtml: `<div class="msg-quote-ref msg-quote-ref--card">${label}${cardHtml}</div>`,
  };
}

/** 引用消息:回复正文放普通气泡,被引用内容放在气泡外下方 */
function renderQuoteParts(m) {
  const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
  const refer = extra.refer && typeof extra.refer === 'object' ? extra.refer : {};
  const reply = String(extra.title || extra.des || '');
  const name = String(refer.displayName || refer.displayname || '');
  const content = String(refer.content || '');
  const replyHtml = reply ? `<div class="msg-quote-reply">${renderTextWithEmoji(reply)}</div>` : '';
  const appType = Number(refer.appType) || 0;
  const isChannels = appType === 51;
  const isLink = [2, 4, 5].includes(appType);
  if (isChannels || isLink) {
    return { replyHtml, ...renderQuoteCard(refer, name, isChannels) };
  }
  const nameHtml = name ? `<span class="msg-quote-name">${esc(name)}</span>` : '';
  const contentHtml = content ? renderTextWithEmoji(content) : '';
  const refHtml = (nameHtml || contentHtml)
    ? `<div class="msg-quote-ref">${nameHtml}${nameHtml && contentHtml ? ': ' : ''}${contentHtml}</div>`
    : '';
  return { replyHtml, refHtml };
}

/** type 42/66 名片 */
function renderContactCard(m) {
  const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
  const name = String(extra.showNickName || extra.nickname || extra.username || '联系人');
  const avatar = fallbackAvatar(name, extra.username || name);
  return `<div class="msg-card msg-card--contact">
    <div class="msg-card-avatar" style="background-image:url('${avatar}')"></div>
    ${cardMain(name, '', m.type === 66 ? '群名片' : '联系人名片')}
  </div>`;
}

/** type 48 位置:标题/地址 + 地图预览 + 定位针 */
function renderLocationCard(m) {
  const extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
  const poiName = cleanCardText(extra.poiname);
  const label = cleanCardText(extra.label) || cleanCardText(extra.address);
  const title = poiName || label || '位置';
  const subtitle = poiName && label && label !== poiName ? label : '';
  const lat = Number(extra.latitude);
  const lon = Number(extra.longitude);
  const aria = [title, subtitle].filter(Boolean).join('，');
  const mapArt = `<svg class="location-map-art" viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">
    <rect width="300" height="150" class="location-map-bg"></rect>
    <path class="location-map-water" d="M-20 116C48 92 92 132 154 104s94-14 166-30v76H-20z"></path>
    <g class="location-map-blocks">
      <rect x="8" y="10" width="58" height="30" rx="2" transform="rotate(-7 37 25)"></rect>
      <rect x="80" y="4" width="44" height="26" rx="2" transform="rotate(5 102 17)"></rect>
      <rect x="196" y="8" width="68" height="32" rx="2" transform="rotate(-4 230 24)"></rect>
      <rect x="22" y="58" width="52" height="36" rx="2"></rect>
      <rect x="104" y="48" width="62" height="34" rx="2" transform="rotate(3 135 65)"></rect>
      <rect x="208" y="58" width="56" height="34" rx="2"></rect>
      <rect x="70" y="100" width="54" height="30" rx="2" transform="rotate(-5 97 115)"></rect>
      <rect x="168" y="98" width="62" height="36" rx="2"></rect>
    </g>
    <g class="location-map-roads">
      <path d="M-24 46 74 56 150 31 326 43" class="location-map-road-major"></path>
      <path d="M34 -12 45 162" class="location-map-road"></path>
      <path d="M154 -12 132 162" class="location-map-road"></path>
      <path d="M-12 89 312 74" class="location-map-road"></path>
      <path d="M60 -10 206 160" class="location-map-road-minor"></path>
    </g>
  </svg>`;
  const pin = `<div class="location-map-pin"><svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true">
    <path d="M16 43S30 25.5 30 15A14 14 0 1 0 2 15c0 10.5 14 28 14 28z" fill="#2fc25b"></path>
    <circle cx="16" cy="15" r="5.5" fill="#fff"></circle>
  </svg></div>`;
  const brand = `<div class="location-map-brand"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
    <path d="M3 5.5 9 3l6 2.5L21 3v15.5L15 21l-6-2.5L3 21z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
    <path d="M9 3v15.5M15 5.5V21" fill="none" stroke="currentColor" stroke-width="1.3"></path>
  </svg><span>地图</span></div>`;
  return `<div class="msg-card msg-card--location" role="img" aria-label="${esc(aria || '位置')}">
    <div class="location-card-info">
      <div class="location-card-title">${esc(title)}</div>
      ${subtitle ? `<div class="location-card-address">${esc(subtitle)}</div>` : ''}
    </div>
    <div class="location-card-map">${mapArt}${pin}${brand}</div>
  </div>`;
}

/** 通话/撤回/系统通知:居中的无气泡系统行 */
function systemInfo(m) {
  const type = Number(m.type);
  if ([50, 52, 53].includes(type)) {
    return { kind: 'call', icon: '📞', text: '通话' };
  }
  if (type === 64) {
    let text = String(m.content || '').trim().replace(/^:\s*/, '');
    const brace = text.indexOf('{');
    if (brace >= 0) {
      try {
        const parsed = JSON.parse(text.slice(brace));
        if (parsed && typeof parsed.msgContent === 'string' && parsed.msgContent) {
          text = parsed.msgContent;
        }
      } catch (err) {
        const match = text.match(/"msgContent"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (match) {
          try {
            text = JSON.parse(`"${match[1]}"`);
          } catch (e) {
            text = match[1];
          }
        }
      }
    }
    const isCall = /通话|视频/.test(text);
    return { kind: isCall ? 'call' : 'notice', icon: isCall ? '📞' : '💬', text: text || '群公告' };
  }
  if (type === 10002) {
    const who = m.isSent ? '你' : String(m.senderName || '').trim();
    return { kind: 'recall', icon: '↩', text: who ? `${who}撤回了一条消息` : '撤回了一条消息' };
  }
  if (type === 10000 || type === 9999) {
    let text = String(m.content || '').trim();
    if (!text || text === '[系统消息]' || text.startsWith('<')) text = '系统消息';
    return { kind: 'system', icon: '•', text };
  }
  return null;
}

function systemRowHtml(m) {
  const info = systemInfo(m);
  if (!info) return '';
  return `<div class="msg-row msg-row--system" data-message-id="${m.id}">
    <div class="msg-system msg-system--${info.kind}">
      <span class="msg-system-icon">${info.icon}</span>
      <span class="msg-system-text">${renderTextWithEmoji(info.text)}</span>
    </div>
  </div>`;
}

function displayName(c) {
  return c.remark || c.nickname || c.username || c.hash;
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (state.secret) headers['X-WEPO-Secret'] = state.secret;
  const res = await fetch(path, Object.assign({}, options, { headers, cache: 'no-store' }));
  if (res.status === 401) {
    // Secret 缺失/失效:回到登录遮罩
    state.secret = '';
    localStorage.removeItem('wepo.secret');
    showAuthOverlay('Secret 无效或已过期,请重新输入');
    throw new Error('未授权:Secret 无效或缺失');
  }
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

/** 媒体/头像 URL:<img>/<audio>/<video> 无法带请求头,追加 ?secret= 参数 */
function mediaUrl(path) {
  if (!path) return '';
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}secret=${encodeURIComponent(state.secret)}`;
}

function toast(text, isError) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:99;'
      + 'background:#4c4c4c;color:#fff;padding:9px 18px;border-radius:5px;font-size:13px;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .3s;';
    document.body.appendChild(el);
  }
  el.style.background = isError ? '#c94f4f' : '#4c4c4c';
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}

// ---------- 视图切换 ----------

/** 离开聊天页面/切换会话前停止所有语音,避免隐藏后继续播放 */
function stopAllAudioPlayback() {
  document.querySelectorAll('audio').forEach((audio) => {
    try {
      if (!audio.paused) audio.pause();
      if (audio.readyState > 0) audio.currentTime = 0;
    } catch (err) {
      /* 媒体尚未加载时忽略 currentTime 异常 */
    }
  });
  document.querySelectorAll('.msg-voice.is-playing').forEach((card) => {
    card.classList.remove('is-playing');
    card.setAttribute('aria-pressed', 'false');
  });
}

function showView(view) {
  if (state.chatContactDetailOpen) closeChatContactDetail();
  const previousView = state.view;
  if (previousView === 'chats' && view !== 'chats') {
    stopAllAudioPlayback();
  }
  if (previousView !== view) {
    state.chatFromContactDetail = false;
    chatFromContactHistoryPushed = false;
    if (state.dataSourceOpen) {
      if (dataSourceHistoryPushed) {
        dataSourceHistoryPushed = false;
        armIgnoreNextPop();
        try {
          history.back();
        } catch (err) {
          consumeIgnoreNextPop();
        }
      }
      state.dataSourceOpen = false;
      state.dataSourceItems = [];
      state.dataSourceRoot = '';
      state.dataSourceError = '';
      state.dataSourceLoading = false;
      state.dataSourceRequestId += 1;
    }
    if (state.chatSearchPageOpen) closeChatSearchPage();
    if (state.searchOverlayOpen) closeSearchOverlay();
    if (state.contactSubpage) closeContactSubpage();
    if (previousView === 'chats' || previousView === 'contacts') {
      saveListCache(previousView);
    }
    // 切换 tab 时清空列表搜索框,避免搜索状态带到另一个 tab
    const searchInput = $('#searchBox');
    if ((searchInput && searchInput.value.length > 0) || state.contactsSearch) {
      clearListSearch();
    }
    if (state.searchMode === 'inline') exitInlineSearch({ clearInput: true });
    // 不中断旧列表请求:响应回来时如果已经不在对应 tab,只写入该 tab 的缓存。
    state.contactsLoading = false;
    updateListLoading();
  }
  state.view = view;
  const app = $('#app');
  app.dataset.view = view;
  app.classList.remove('detail-open'); // 切换标签时关闭详情
  document.querySelectorAll('.nav-btn, .tab-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  const listVisible = view !== 'data';
  $('#listPanel').classList.toggle('hidden', !listVisible);
  $('#chatView').classList.toggle('hidden', view !== 'chats');
  $('#contactView').classList.toggle('hidden', view !== 'contacts');
  $('#dataView').classList.toggle('hidden', view !== 'data');
  $('#emptyView').classList.toggle('hidden', view !== 'chats' || Boolean(state.selected));

  const searchWrap = $('#listSearchWrap');
  if (searchWrap) searchWrap.classList.toggle('hidden', view === 'data');
  updateSearchPlaceholder();

  if (view === 'chats' || view === 'contacts') {
    // 聊天列表按最近消息排序,通讯录按昵称排序
    state.contactsOrder = view === 'contacts' ? 'name' : 'time';
    if (previousView !== view && !restoreListCache(view)) {
      loadContacts(true);
    }
  } else if (view === 'data') {
    renderDataManager();
  }

  if (view === 'chats' && state.selected) {
    renderChat(state.selected);
  } else if (view === 'contacts' && state.selected) {
    renderContactDetail(state.selected);
  }
  updateChatSearchFilterBar();
  updateMobileChrome();
}

/** 在用户手势回调中尽早压入详情 history,避免 iOS 将稍后的 pushState 视为虚拟记录 */
function pushDetailHistoryState() {
  if (!isMobileSinglePane() || detailHistoryPushed) return detailHistoryPushed;
  try {
    history.pushState({ wepoDetail: true }, '', location.href);
    detailHistoryPushed = true;
    return true;
  } catch (err) {
    detailHistoryPushed = false;
    return false;
  }
}

/** 移动端:进入详情页(全屏聊天/联系人资料,隐藏列表与底部标签栏) */
function openDetail() {
  const app = $('#app');
  const wasOpen = app.classList.contains('detail-open');
  app.classList.add('detail-open');
  updateMobileChrome();

  // 移动端单栏:压入历史记录,使浏览器/系统原生返回能关闭详情
  if (!wasOpen && isMobileSinglePane() && !detailHistoryPushed) {
    pushDetailHistoryState();
  }
}

/** 移动端:返回列表 */
function closeDetail(options = {}) {
  const fromHistory = options.fromHistory === true;
  stopAllAudioPlayback();
  if (!fromHistory && state.chatSearchPageOpen) closeChatSearchPage();
  if (!fromHistory && detailHistoryPushed) {
    detailHistoryPushed = false;
    armIgnoreNextPop();
    try {
      history.back();
    } catch (err) {
      consumeIgnoreNextPop();
    }
  }
  $('#app').classList.remove('detail-open');
  state.selected = null;
  state.chatFromContactDetail = false;
  chatFromContactHistoryPushed = false;
  state.messages = [];
  state.messageDateMode = false;
  state.messageHasNewer = false;
  state.messageOlderCursor = null;
  state.messageNewerCursor = null;
  state.messagesLoadingNewer = false;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  if (!state.searchOverlayOpen) state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  renderContactListKeepingScroll();
  updateContactSubpageSelection();
  showView(state.view);
  restoreContactListScrollAfterDetail();
  // 从搜索结果进入聊天详情后,返回时恢复搜索页
  if (state.searchOverlayOpen) {
    refreshSearchOverlayView();
    const searchView = $('#searchPageView');
    if (searchView) searchView.classList.remove('hidden');
  }
}

/** 独立消息跳转页的返回文案:日期回日历,分类列表回对应列表 */
function messageJumpBackLabel() {
  if (state.messageJumpSource === 'category') {
    const category = state.chatSearchPage && state.chatSearchPage.category;
    if (category === 'link') return '返回链接列表';
    if (category === 'location') return '返回位置列表';
    return '返回搜索结果';
  }
  return '返回日期日历';
}

/** 移动端顶部导航栏:标题与返回按钮 */
function updateMobileChrome() {
  const app = $('#app');
  app.classList.toggle('data-source-open', state.dataSourceOpen);
  const dataPanelBackBtn = $('#dataPanelBackBtn');
  if (dataPanelBackBtn) dataPanelBackBtn.classList.toggle('hidden', !state.dataSourceOpen);
  const dataViewTitle = $('#dataViewTitle');
  if (dataViewTitle) dataViewTitle.textContent = state.dataSourceOpen ? '数据源' : '我';
  const detailOpen = app.classList.contains('detail-open') && Boolean(state.selected);
  const contactDetailOpen = state.chatContactDetailOpen;
  const subpageOpen = !detailOpen && Boolean(state.contactSubpage);
  const backBtn = $('#mobileBackBtn');
  const title = $('#mobileNavTitle');
  if (contactDetailOpen) {
    backBtn.classList.remove('hidden');
    backBtn.setAttribute('aria-label', '返回聊天');
    title.textContent = '详细资料';
  } else if (detailOpen) {
    backBtn.classList.remove('hidden');
    if (state.dateJumpOpen) {
      backBtn.setAttribute('aria-label', messageJumpBackLabel());
      title.textContent = displayName(state.selected);
    } else if (state.chatFromContactDetail && state.view === 'chats') {
      backBtn.setAttribute('aria-label', '返回联系人详情');
      title.textContent = displayName(state.selected);
    } else if (state.view === 'contacts') {
      backBtn.setAttribute('aria-label', '返回通讯录');
      title.textContent = '详细资料';
    } else {
      backBtn.setAttribute('aria-label', '返回微信');
      title.textContent = displayName(state.selected);
    }
  } else if (state.view === 'data' && state.dataSourceOpen) {
    backBtn.classList.remove('hidden');
    backBtn.setAttribute('aria-label', '返回我');
    title.textContent = '数据源';
  } else if (subpageOpen) {
    backBtn.classList.remove('hidden');
    backBtn.setAttribute('aria-label', '返回通讯录');
    title.textContent = state.contactSubpage.title || '通讯录';
  } else {
    backBtn.classList.add('hidden');
    backBtn.setAttribute('aria-label', '返回');
    title.textContent = state.view === 'data' ? '我' : state.view === 'contacts' ? '通讯录' : '微信';
  }
  const chatsSearchBtn = $('#mobileChatSearchBtn');
  if (chatsSearchBtn) {
    chatsSearchBtn.classList.toggle(
      'hidden',
      !(detailOpen && state.view === 'chats' && !contactDetailOpen && !state.dateJumpOpen)
    );
  }
  const mobileContactBtn = $('#mobileContactDetailBtn');
  const showMobileContactBtn = Boolean(
    detailOpen
    && state.view === 'chats'
    && state.selected
    && !state.selected.isChatroom
    && !contactDetailOpen
  );
  if (mobileContactBtn) mobileContactBtn.classList.toggle('hidden', !showMobileContactBtn);
  const mobileNav = $('#mobileNav');
  if (mobileNav) mobileNav.classList.toggle('has-contact-detail-btn', showMobileContactBtn);

  const panelSearchBtn = $('#chatSearchOpenBtn');
  if (panelSearchBtn) {
    panelSearchBtn.classList.toggle(
      'hidden',
      !(state.selected && state.view === 'chats' && !contactDetailOpen && !state.dateJumpOpen)
    );
  }
  const chatBackBtn = $('#chatDateJumpBackBtn');
  if (chatBackBtn) {
    const showContactBack = state.chatFromContactDetail && state.view === 'chats';
    const showChatBack = state.dateJumpOpen || showContactBack;
    chatBackBtn.classList.toggle('hidden', !showChatBack);
    const label = state.dateJumpOpen ? messageJumpBackLabel() : '返回联系人详情';
    chatBackBtn.setAttribute('aria-label', label);
    chatBackBtn.title = label;
  }
  const panelContactBtn = $('#chatContactDetailBtn');
  if (panelContactBtn) {
    const showPanelContactBtn = Boolean(
      state.selected && state.view === 'chats' && !state.selected.isChatroom && !contactDetailOpen
    );
    panelContactBtn.classList.toggle('hidden', !showPanelContactBtn);
  }
  const composer = $('#chatComposer');
  if (composer) {
    composer.classList.toggle('hidden', !(state.selected && state.view === 'chats' && !contactDetailOpen));
  }
}

// ---------- 移动端浏览器返回 ----------

let detailHistoryPushed = false;
let chatSearchHistoryDepth = 0;
let dateJumpHistoryPushed = false;
let chatFromContactHistoryPushed = false;
let chatContactDetailHistoryPushed = false;
let dataSourceHistoryPushed = false;
let ignoreNextPop = false;
let ignoreNextPopTimer = null;
const IGNORE_POP_TIMEOUT_MS = 1000;

/** 忽略一次由代码主动触发的 popstate;超时自动解除,避免一次丢失的事件把后续返回全部吞掉 */
function armIgnoreNextPop() {
  ignoreNextPop = true;
  clearTimeout(ignoreNextPopTimer);
  ignoreNextPopTimer = setTimeout(() => {
    ignoreNextPop = false;
    ignoreNextPopTimer = null;
  }, IGNORE_POP_TIMEOUT_MS);
}

function consumeIgnoreNextPop() {
  ignoreNextPop = false;
  clearTimeout(ignoreNextPopTimer);
  ignoreNextPopTimer = null;
}

/** 当前是否为移动端单栏布局(平板分栏/桌面为 false) */
function isMobileSinglePane() {
  const nav = $('#mobileNav');
  return Boolean(nav) && getComputedStyle(nav).display !== 'none';
}

/** 为聊天内搜索的分类/成员详情层压入一条移动端 history */
function pushChatSearchHistoryLevel(minDepth) {
  if (!isMobileSinglePane() || chatSearchHistoryDepth < minDepth) return false;
  try {
    history.pushState({ wepoChatSearch: true }, '', location.href);
    chatSearchHistoryDepth += 1;
    return true;
  } catch (err) {
    return false;
  }
}

/** 联系人详情 → 聊天页作为独立页面压入移动端 history */
function pushChatFromContactHistoryState() {
  if (!isMobileSinglePane() || chatFromContactHistoryPushed) return chatFromContactHistoryPushed;
  try {
    history.pushState({ wepoChatFromContact: true }, '', location.href);
    chatFromContactHistoryPushed = true;
    return true;
  } catch (err) {
    chatFromContactHistoryPushed = false;
    return false;
  }
}

/** 日期日历 → 消息列表作为独立页面压入移动端 history */
function pushDateJumpHistoryLevel() {
  if (!isMobileSinglePane() || dateJumpHistoryPushed) return dateJumpHistoryPushed;
  try {
    history.pushState({ wepoDateJump: true }, '', location.href);
    chatSearchHistoryDepth += 1;
    dateJumpHistoryPushed = true;
    return true;
  } catch (err) {
    dateJumpHistoryPushed = false;
    return false;
  }
}

/** 从日期消息列表返回日历页,保留日历原有滚动位置 */
function restoreDateJumpPage() {
  if (!state.dateJumpOpen) return false;
  stopAllAudioPlayback();
  state.dateJumpOpen = false;
  dateJumpHistoryPushed = false;
  const view = $('#chatSearchPageView');
  if (view && state.chatSearchPageOpen && state.chatSearchPage) {
    view.classList.remove('hidden');
    view.classList.toggle('chat-search-page--fullscreen', isMobileSinglePane());
    if (state.chatSearchPage.category === 'image_video') {
      scheduleChatSearchGalleryAutoFill(state.chatSearchPage);
    }
  }
  updateMobileChrome();
  return true;
}

/** 日期消息列表返回按钮:移动端优先走原生历史返回 */
function handleDateJumpBack() {
  if (!state.dateJumpOpen) return;
  if (dateJumpHistoryPushed) {
    try {
      history.back();
      return;
    } catch (err) {
      chatSearchHistoryDepth = Math.max(0, chatSearchHistoryDepth - 1);
      dateJumpHistoryPushed = false;
    }
  }
  restoreDateJumpPage();
}

/** 合并转发聊天记录详情:日期/时间/头像与条目渲染 */
function formatChatRecordDate(sec) {
  const value = Number(sec) || 0;
  if (!value) return '';
  const date = new Date(value * 1000);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function chatRecordItemTime(item) {
  if (item && Number(item.createTime) > 0) return formatClockTime(item.createTime);
  const value = String((item && item.sourceTime) || '');
  const match = value.match(/(\d{1,2}:\d{2})/);
  return match ? match[1] : '';
}

function chatRecordMediaUrl(messageId, dataId, kind) {
  if (!messageId || !/^[a-f0-9]{32}$/i.test(String(dataId || ''))) return '';
  return mediaUrl(`/api/messages/${messageId}/record-media/${String(dataId).toLowerCase()}?kind=${kind}`);
}

function chatRecordLinkHtml(item) {
  const title = cleanCardText(item.title || item.text) || '链接';
  const desc = cleanCardText(item.desc);
  const url = safeHttpUrl(item.url);
  const inner = `<div class="chat-record-link-title">${renderTextWithEmoji(title)}</div>
    ${desc && desc !== title ? `<div class="chat-record-link-desc">${renderTextWithEmoji(desc)}</div>` : ''}`;
  return url
    ? `<a class="chat-record-link-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="chat-record-link-card">${inner}</div>`;
}

/** 详情页内嵌聊天记录卡片:复用消息列表的聊天记录卡视觉,而不是静态文本 */
function renderNestedChatRecordCard(item, index) {
  const title = cleanCardText(item.recordTitle || item.title || item.desc) || '聊天记录';
  const lines = chatRecordPreviewLines({ records: item.records, des: item.desc }, 3);
  return `<div class="msg-card msg-card--record chat-record-nested-record-card" role="button" tabindex="0" data-chat-record-nested-index="${index}" aria-label="查看${esc(title)}">
    <div class="record-card-title">${renderTextWithEmoji(title)}</div>
    ${lines.length ? `<div class="record-card-preview">${lines.map((line) => `<div class="record-card-line">${renderTextWithEmoji(line)}</div>`).join('')}</div>` : ''}
    <div class="record-card-footer">聊天记录</div>
  </div>`;
}

function renderChatRecordItemContent(item, messageId, index) {
  if (item && Array.isArray(item.records) && item.records.length) {
    return renderNestedChatRecordCard(item, index);
  }
  const dataType = Number(item && item.dataType) || 0;
  const dataId = String((item && item.dataId) || '');
  const text = String((item && (item.text || item.title || item.desc)) || '');
  const mediaFrame = (kind, content, fallback) => `<span class="chat-record-media-frame chat-record-media-frame--${kind}"><span class="chat-record-media-fallback">${fallback}</span>${content}</span>`;
  if (dataType === 2) {
    const src = chatRecordMediaUrl(messageId, dataId, 'full');
    return src
      ? mediaFrame('image', `<img class="chat-record-image" src="${esc(src)}" alt="图片" loading="lazy" data-full-src="${esc(src)}">`, '[图片]')
      : mediaFrame('image', '', '[图片]');
  }
  if (dataType === 4) {
    const src = chatRecordMediaUrl(messageId, dataId, 'full');
    const poster = chatRecordMediaUrl(messageId, dataId, 'thumb');
    return src
      ? mediaFrame('video', `<video class="chat-record-video" controls preload="metadata"${poster ? ` poster="${esc(poster)}"` : ''} src="${esc(src)}"></video>`, '[视频]')
      : mediaFrame('video', '', '[视频]');
  }
  if (dataType === 37) {
    const src = chatRecordMediaUrl(messageId, dataId, 'thumb') || chatRecordMediaUrl(messageId, dataId, 'full');
    return src
      ? mediaFrame('emoji', `<img class="chat-record-emoji" src="${esc(src)}" alt="表情" loading="lazy">`, '[动画表情]')
      : mediaFrame('emoji', '', '[动画表情]');
  }
  if (dataType === 1) return renderTextWithEmoji(text);
  if (dataType === 5) return chatRecordLinkHtml(item);
  if (dataType === 6) {
    const loc = item.location && typeof item.location === 'object' ? item.location : {};
    const name = cleanCardText(loc.poiname || loc.label) || text;
    const address = cleanCardText(loc.label);
    return `<div class="chat-record-location">
      <span class="chat-record-location-icon">⌖</span>
      <span><span class="chat-record-location-name">${renderTextWithEmoji(name)}</span>${address && address !== name ? `<span class="chat-record-location-address">${renderTextWithEmoji(address)}</span>` : ''}</span>
    </div>`;
  }
  if (dataType === 8) {
    return `<div class="chat-record-file"><span class="chat-record-file-icon">📄</span><span>${renderTextWithEmoji(text || '文件')}</span></div>`;
  }
  if (dataType === 19) {
    return `<div class="chat-record-miniapp"><span class="chat-record-miniapp-icon">▣</span><span>${renderTextWithEmoji(text || '小程序')}</span></div>`;
  }
  return renderTextWithEmoji(text);
}

function renderChatRecordDetailItem(item, messageId, index) {
  const name = cleanCardText(item && item.sourceName) || '聊天记录';
  const avatar = safeCardImageUrl(item && item.sourceHeadUrl)
    || fallbackAvatar(name, (item && (item.sourceName || item.dataId)) || name);
  return `<div class="chat-record-item">
    <div class="chat-record-item-avatar" style="background-image:url('${esc(avatar)}')"></div>
    <div class="chat-record-item-main">
      <div class="chat-record-item-head">
        <span class="chat-record-item-name">${esc(name)}</span>
        <span class="chat-record-item-time">${esc(chatRecordItemTime(item))}</span>
      </div>
      <div class="chat-record-item-content">${renderChatRecordItemContent(item, messageId, index)}</div>
    </div>
  </div>`;
}

function chatRecordLevelFromMessage(message) {
  const extra = message && message.extra && typeof message.extra === 'object' ? message.extra : {};
  const records = Array.isArray(extra.records) ? extra.records : [];
  return {
    title: cleanCardText(extra.recordTitle || extra.title) || '聊天记录',
    dateSec: Number(message && message.createTime) || 0,
    records,
    fallbackDes: String(extra.des || ''),
    mediaMessageId: message && message.id,
  };
}

function chatRecordLevelFromItem(item, parent) {
  const records = item && Array.isArray(item.records) ? item.records : [];
  return {
    title: cleanCardText(item && (item.recordTitle || item.title || item.desc)) || '聊天记录',
    dateSec: Number(item && item.createTime) > 0 ? Number(item.createTime) : parent.dateSec,
    records,
    fallbackDes: String((item && item.desc) || ''),
    mediaMessageId: parent.mediaMessageId,
  };
}

function renderChatRecordDetailLevel() {
  const level = chatRecordDetailStack[chatRecordDetailStack.length - 1];
  if (!level) return;
  const items = level.records.length === 0
    ? level.fallbackDes.split('\n').filter((line) => line.trim()).map((line) => ({ text: line }))
    : level.records;
  const title = $('#chatRecordDetailTitle');
  const date = $('#chatRecordDetailDate');
  const body = $('#chatRecordDetailBody');
  if (title) title.textContent = level.title;
  if (date) date.textContent = formatChatRecordDate(level.dateSec);
  if (body) {
    body.innerHTML = items.length
      ? items.map((item, index) => renderChatRecordDetailItem(item, level.mediaMessageId, index)).join('')
      : '<div class="chat-record-empty">聊天记录内容为空</div>';
    body.scrollTop = 0;
  }
}

function openChatRecordDetail(message) {
  if (!message) return;
  state.chatRecordDetailOpen = true;
  chatRecordDetailStack = [chatRecordLevelFromMessage(message)];
  chatRecordDetailHistoryDepth = 0;
  renderChatRecordDetailLevel();
  const page = $('#chatRecordDetailPage');
  if (!page) return;
  page.classList.remove('hidden');
  page.classList.toggle('chat-record-page--fullscreen', isMobileSinglePane());
  if (isMobileSinglePane()) {
    history.pushState({ wepoChatRecordDetail: true }, '', location.href);
    chatRecordDetailHistoryDepth = 1;
  }
}

function openNestedChatRecord(index) {
  if (!state.chatRecordDetailOpen || chatRecordDetailStack.length === 0) return;
  const parent = chatRecordDetailStack[chatRecordDetailStack.length - 1];
  const item = parent.records[index];
  if (!item || !Array.isArray(item.records) || item.records.length === 0) return;
  chatRecordDetailStack.push(chatRecordLevelFromItem(item, parent));
  renderChatRecordDetailLevel();
  if (isMobileSinglePane()) {
    history.pushState({ wepoChatRecordDetail: true }, '', location.href);
    chatRecordDetailHistoryDepth += 1;
  }
}

function navigateBackChatRecordDetail() {
  if (!state.chatRecordDetailOpen) return;
  if (isMobileSinglePane() && chatRecordDetailHistoryDepth > 0) {
    history.back();
    return;
  }
  if (chatRecordDetailStack.length > 1) {
    chatRecordDetailStack.pop();
    renderChatRecordDetailLevel();
    return;
  }
  closeChatRecordDetail();
}

function closeChatRecordDetail() {
  state.chatRecordDetailOpen = false;
  chatRecordDetailStack = [];
  chatRecordDetailHistoryDepth = 0;
  const page = $('#chatRecordDetailPage');
  if (page) page.classList.add('hidden');
  const body = $('#chatRecordDetailBody');
  if (body) body.innerHTML = '';
}

/**
 * 浏览器返回键 / Android 返回手势 / iOS 浏览器原生边缘返回。
 * 详情页打开时已 pushState,原生返回触发 popstate 后关闭详情回到列表。
 */
function bindHistoryBack() {
  window.addEventListener('popstate', () => {
    if (ignoreNextPop) {
      consumeIgnoreNextPop();
      return;
    }
    if (state.chatRecordDetailOpen) {
      chatRecordDetailHistoryDepth = Math.max(0, chatRecordDetailHistoryDepth - 1);
      if (chatRecordDetailStack.length > 1) {
        chatRecordDetailStack.pop();
        renderChatRecordDetailLevel();
      } else {
        closeChatRecordDetail();
      }
      return;
    }
    if (state.chatContactDetailOpen) {
      // 联系人资料页是当前最上层。它也可能叠在日期消息页之上,
      // 必须先关闭资料页,不能提前处理下面的日期/搜索层。
      chatContactDetailHistoryPushed = false;
      closeChatContactDetail({ fromHistory: true });
      return;
    }
    if (state.dateJumpOpen) {
      // 日期消息列表是独立页面:返回时恢复日期日历,不关闭聊天内搜索
      chatSearchHistoryDepth = Math.max(0, chatSearchHistoryDepth - 1);
      restoreDateJumpPage();
      return;
    }
    if (state.chatSearchPageOpen) {
      const page = state.chatSearchPage;
      if (chatSearchHistoryDepth > 1 && page) {
        chatSearchHistoryDepth -= 1;
        const atDetail = (page.category === 'members' && page.selectedMember)
          || (page.category === 'date' && page.selectedDate);
        if (atDetail) {
          revertChatSearchDetailLevel();
          return;
        }
        if (page.category) {
          revertChatSearchCategoryLevel();
          return;
        }
      }
      chatSearchHistoryDepth = 0;
      closeChatSearchPage({ fromHistory: true, restoreMessagePage: true });
      return;
    }
    if (state.chatFromContactDetail && state.view === 'chats') {
      // 从通讯录联系人详情进入的聊天页:先回到联系人详情
      chatFromContactHistoryPushed = false;
      returnFromChatToContactDetail();
      return;
    }
    if ($('#app').classList.contains('detail-open')) {
      // 即使 detailHistoryPushed 因历史记录异常/上限未同步,系统返回也应关闭详情
      detailHistoryPushed = false;
      closeDetail({ fromHistory: true });
      return;
    }
    if (state.dataSourceOpen) {
      // 数据源是「我」页的二级页面,原生返回回到「我」页
      dataSourceHistoryPushed = false;
      closeDataSourcePage({ fromHistory: true });
      return;
    }
    if (state.contactSubpage) {
      const page = state.contactSubpage;
      if (page.kind === 'tag' && page.parent && state.contactSubpageHistoryDepth > 1) {
        state.contactSubpageHistoryDepth -= 1;
        restoreContactSubpagePage(page.parent);
        return;
      }
      state.contactSubpageHistoryDepth = 0;
      closeContactSubpage({ fromHistory: true });
      return;
    }
    if (state.searchOverlayOpen) {
      if (state.searchPage && state.searchHistoryDepth > 1) {
        state.searchHistoryDepth -= 1;
        closeSearchCategory();
        return;
      }
      state.searchHistoryDepth = Math.max(0, state.searchHistoryDepth - 1);
      closeSearchOverlay();
    }
  });
}

// ---------- 联系人列表 ----------

/** 桌面/平板右栏空状态:区分"有数据待选择"与"尚未导入" */
function updateEmptyTip() {
  const el = $('#emptyTip');
  if (!el) return;
  if (state.contactsLoading && state.contacts.length === 0) {
    el.textContent = '正在加载...';
    return;
  }
  el.textContent = state.contacts.length > 0
    ? '请选择左侧会话开始查看聊天记录'
    : '暂无数据。请使用桌面客户端导入备份数据。';
}

function updateListLoading() {
  const el = $('#listMore');
  if (!el) return;
  if (state.searchMode === 'inline') {
    el.classList.add('hidden');
    return;
  }
  el.classList.toggle('hidden', !state.contactsLoading);
}

function updateMessageLoading() {
  const top = $('#loadMore');
  if (top) {
    top.classList.toggle('hidden', !(state.messagesLoading && !state.messagesLoadingNewer));
  }
  const bottom = $('#loadMoreNewer');
  if (bottom) {
    bottom.classList.toggle('hidden', !(state.messagesLoading && state.messagesLoadingNewer));
  }
}

/** 分页加载浮层:不参与列表布局,供搜索类旧页加载使用 */
function setPagingBusy(visible) {
  const el = $('#pagingBusy');
  if (el) el.classList.toggle('hidden', !visible);
}

/** 图片列表的顶部加载提示:位置与消息列表“加载更早消息”一致 */
function setChatSearchGalleryLoading(visible) {
  const el = $('#chatSearchGalleryLoading');
  if (el) el.classList.toggle('hidden', !visible);
}

/** 会话列表/通讯录各自的账号级内存缓存 */
function invalidateListCaches() {
  state.listCache = { chats: null, contacts: null };
  state.listPending = { chats: null, contacts: null };
  state.dataCache = null;
  if (state.chatContactDetailOpen) closeChatContactDetail();
  if (state.contactSubpage) closeContactSubpage();
  if (state.chatSearchPageOpen) closeChatSearchPage();
  if (state.searchOverlayOpen) closeSearchOverlay();
  else if (state.searchMode === 'inline') exitInlineSearch({ clearInput: true });
  state.searchMode = null;
  state.searchCache.clear();
  state.searchResults = null;
  state.searchLoading = false;
  state.searchRequestId += 1;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  state.chatSearchFilterTotal = 0;
  updateInlineBackButton();
  updateSearchPlaceholder();
  updateChatSearchFilterBar();
}

/** 切换账号时立即清空列表 DOM,避免新账号数据返回前继续显示旧账号内容 */
function resetListViewForOwnerChange() {
  state.listRequestIds.chats += 1;
  state.listRequestIds.contacts += 1;
  state.listPending = { chats: null, contacts: null };
  if (state.searchMode === 'inline') exitInlineSearch({ clearInput: true });
  state.searchMode = state.searchOverlayOpen ? 'overlay' : null;
  state.searchRequestId += 1;
  state.searchResults = null;
  state.searchLoading = false;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  state.selectedMessageId = null;
  updateInlineBackButton();
  updateSearchPlaceholder();
  state.contacts = [];
  state.contactGroups = state.view === 'contacts' ? [] : null;
  state.contactsPage = 1;
  state.contactsTotal = 0;
  state.contactsHasMore = false;
  state.contactsLoaded = false;
  state.contactsLoading = true;
  const list = $('#contactList');
  if (list) list.scrollTop = 0;
  updateEmptyTip();
  renderContactList();
  updateListLoading();
}

/** 重绘列表时保留当前滚动位置(打开详情/返回列表时列表不应跳回顶部) */
function renderContactListKeepingScroll() {
  const list = $('#contactList');
  const scrollTop = list ? list.scrollTop : 0;
  renderContactList();
  if (!list) return;
  list.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    if (list.isConnected) list.scrollTop = scrollTop;
  });
}

/** 从联系人详情返回列表后恢复进入详情前的滚动位置 */
function restoreContactListScrollAfterDetail() {
  const scrollTop = contactListReturnScrollTop;
  contactListReturnScrollTop = null;
  if (scrollTop === null || scrollTop === undefined) return;
  if (state.view !== 'contacts' || state.selected || state.contactSubpage) return;
  const list = $('#contactList');
  if (!list) return;
  const apply = () => {
    if (list.isConnected
      && state.view === 'contacts'
      && !state.selected
      && !state.contactSubpage) {
      list.scrollTop = scrollTop;
    }
  };
  apply();
  requestAnimationFrame(apply);
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

/** 清空旧账号的聊天/联系人详情 DOM;列表视图显示加载中的空状态 */
function clearDetailViewForOwnerChange() {
  stopAllAudioPlayback();
  if (state.chatSearchPageOpen) closeChatSearchPage();
  state.selected = null;
  state.chatFromContactDetail = false;
  chatFromContactHistoryPushed = false;
  state.messages = [];
  state.messageDateMode = false;
  state.messageHasNewer = false;
  state.messageOlderCursor = null;
  state.messageNewerCursor = null;
  state.messagesLoadingNewer = false;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  $('#chatTitle').innerHTML = '';
  $('#messageList').innerHTML = '';
  $('#contactDetail').innerHTML = '';
  $('#app').classList.remove('detail-open');
  if (state.view !== 'data') {
    $('#chatView').classList.add('hidden');
    $('#contactView').classList.add('hidden');
    $('#emptyView').classList.remove('hidden');
  }
  updateChatSearchFilterBar();
  updateMobileChrome();
}

function saveListCache(viewKey) {
  // 会话搜索是独立的分组结果视图,不写入普通会话列表缓存
  if (viewKey === 'chats' && state.contactsSearch) return;
  if (!state.contactsLoaded || !state.currentOwner) return;
  const list = $('#contactList');
  state.listCache[viewKey] = {
    view: viewKey,
    owner: state.currentOwner,
    search: state.contactsSearch,
    contacts: state.contacts.slice(),
    contactGroups: state.contactGroups
      ? state.contactGroups.map((group) => ({
        letter: group.letter,
        contacts: group.contacts.slice(),
      }))
      : null,
    page: state.contactsPage,
    total: state.contactsTotal,
    hasMore: state.contactsHasMore,
    scrollTop: list ? list.scrollTop : 0,
  };
}

/** 恢复当前账号/搜索条件下的列表缓存;无有效缓存返回 false */
function restoreListCache(viewKey) {
  if (viewKey === 'chats' && state.contactsSearch) return false;
  const cache = state.listCache[viewKey];
  if (!cache
    || cache.view !== viewKey
    || cache.owner !== state.currentOwner
    || cache.search !== state.contactsSearch) return false;
  state.contacts = cache.contacts.slice();
  state.contactGroups = cache.contactGroups
    ? cache.contactGroups.map((group) => ({
      letter: group.letter,
      contacts: group.contacts.slice(),
    }))
    : null;
  state.contactsPage = cache.page;
  state.contactsTotal = cache.total;
  state.contactsHasMore = cache.hasMore;
  state.contactsLoaded = true;
  state.contactsLoading = false;
  state.contactsOrder = viewKey === 'contacts' ? 'name' : 'time';
  updateEmptyTip();
  renderContactList();
  updateListLoading();
  const list = $('#contactList');
  if (list) {
    list.scrollTop = cache.scrollTop || 0;
    requestAnimationFrame(() => {
      if (list.isConnected) list.scrollTop = cache.scrollTop || 0;
    });
  }
  return true;
}

/** 响应不属于当前 tab 时,只写入该 tab 的列表缓存,供切回时恢复 */
function cacheListResponse(viewKey, owner, search, data, reset) {
  // 会话搜索是独立的分组结果视图,不写入普通会话列表缓存
  if (viewKey === 'chats' && search) return;
  const existing = state.listCache[viewKey];
  const canAppend = !reset
    && existing
    && existing.view === viewKey
    && existing.owner === owner
    && existing.search === search;
  const pageSize = viewKey === 'contacts' ? 200 : 100;

  if (viewKey === 'chats') {
    const items = Array.isArray(data.items) ? data.items : [];
    const contacts = canAppend ? existing.contacts.concat(items) : items;
    const page = Number(data.page) || (canAppend ? existing.page + 1 : 1);
    const total = data.total === undefined ? contacts.length : Number(data.total) || 0;
    const hasMore = typeof data.hasMore === 'boolean' ? data.hasMore : page * pageSize < total;
    state.listCache.chats = {
      view: 'chats',
      owner,
      search,
      contacts,
      contactGroups: null,
      page,
      total,
      hasMore,
      scrollTop: canAppend ? existing.scrollTop || 0 : 0,
    };
    return;
  }

  const incoming = Array.isArray(data.groups) ? data.groups : [];
  const groups = mergeContactGroups(canAppend ? existing.contactGroups : [], incoming);
  const contacts = groups.flatMap((group) => group.contacts);
  const page = Number(data.page) || (canAppend ? existing.page + 1 : 1);
  const total = data.total === undefined ? contacts.length : Number(data.total) || 0;
  const hasMore = typeof data.hasMore === 'boolean' ? data.hasMore : page * pageSize < total;
  state.listCache.contacts = {
    view: 'contacts',
    owner,
    search,
    contacts,
    contactGroups: groups,
    page,
    total,
    hasMore,
    scrollTop: canAppend ? existing.scrollTop || 0 : 0,
  };
}

/** 全量加载列表前清空共享状态与 DOM,避免显示上一个 tab 的内容 */
function resetListViewState(viewKey) {
  state.contacts = [];
  state.contactGroups = viewKey === 'contacts' ? [] : null;
  state.contactsPage = 1;
  state.contactsTotal = 0;
  state.contactsHasMore = false;
  state.contactsLoaded = false;
  state.listCache[viewKey] = null;
  const list = $('#contactList');
  if (list) list.scrollTop = 0;
  renderContactList();
  updateEmptyTip();
}

/** 响应是否仍是该 tab 的最新请求(账号/搜索条件也必须一致) */
function isListResponseValid(viewRequestId, owner, search, viewKey) {
  return viewRequestId === state.listRequestIds[viewKey]
    && owner === state.currentOwner
    && search === state.contactsSearch;
}

/** 响应是否正好属于当前激活的 tab,可以更新共享状态并渲染 */
function isCurrentListRequest(viewRequestId, owner, search, viewKey) {
  const currentViewKey = state.view === 'chats'
    ? 'chats'
    : (state.view === 'contacts' ? 'contacts' : null);
  const app = $('#app');
  const domView = app ? app.dataset.view : state.view;
  return isListResponseValid(viewRequestId, owner, search, viewKey)
    && viewKey === currentViewKey
    && domView === viewKey;
}

async function loadContacts(reset) {
  // 列表内搜索有自己的结果状态
  if (state.searchMode === 'inline') return;
  // 联系人视图:拼音排序 + 首字母分组,分页加载
  if (state.view === 'contacts') {
    await loadContactsGrouped(reset);
    return;
  }

  const viewKey = 'chats';
  const owner = state.currentOwner;
  const search = state.contactsSearch;
  const pending = state.listPending[viewKey];
  if (reset && pending && pending.owner === owner && pending.search === search && pending.reset) {
    // 同一列表的全量请求仍在途(例如刚切走又切回),直接复用它,不重复发请求
    state.contactsLoading = true;
    resetListViewState(viewKey);
    updateListLoading();
    return;
  }

  state.listRequestIds[viewKey] += 1;
  const requestId = state.listRequestIds[viewKey];
  state.listPending[viewKey] = { owner, search, reset: Boolean(reset), requestId };
  state.contactsLoading = true;
  updateListLoading();
  if (reset) resetListViewState(viewKey);
  try {
    const page = reset ? 1 : state.contactsPage + 1;
    const params = new URLSearchParams({
      page,
      pageSize: 100,
      order: state.contactsOrder,
    });
    if (search) params.set('search', search);
    if (owner) params.set('owner', owner);
    const data = await api(`/api/contacts?${params}`);
    if (!isListResponseValid(requestId, owner, search, viewKey)) return;
    if (!isCurrentListRequest(requestId, owner, search, viewKey)) {
      cacheListResponse(viewKey, owner, search, data, reset);
      return;
    }
    state.contactsPage = Number(data.page) || page;
    state.contacts = reset ? data.items : state.contacts.concat(data.items);
    state.contactsTotal = data.total;
    state.contactsHasMore = typeof data.hasMore === 'boolean' ? data.hasMore : page * 100 < data.total;
    state.contactsLoaded = true;
    updateEmptyTip();
    renderContactList();
    if (reset) $('#contactList').scrollTop = 0;
    saveListCache(viewKey);
  } catch (err) {
    if (isCurrentListRequest(requestId, owner, search, viewKey)) {
      toast(err.message, true);
    }
  } finally {
    if (state.listPending[viewKey] && state.listPending[viewKey].requestId === requestId) {
      state.listPending[viewKey] = null;
    }
    if (isCurrentListRequest(requestId, owner, search, viewKey)) {
      state.contactsLoading = false;
      updateListLoading();
      if (state.contacts.length === 0) renderContactList();
    }
  }
}

/** 合并连续分页返回的字母分组(相邻页可能在同一个字母分组内) */
function mergeContactGroups(existing, incoming) {
  const groups = Array.isArray(existing)
    ? existing.map((group) => ({ letter: group.letter, contacts: (group.contacts || []).slice() }))
    : [];
  const byLetter = new Map(groups.map((group) => [group.letter, group]));
  for (const group of incoming || []) {
    let target = byLetter.get(group.letter);
    if (!target) {
      target = { letter: group.letter, contacts: [] };
      byLetter.set(group.letter, target);
      groups.push(target);
    }
    target.contacts.push(...(group.contacts || []));
  }
  return groups;
}

/** 联系人视图:使用服务端已按拼音排序、首字母分组的分页结果 */
async function loadContactsGrouped(reset) {
  const viewKey = 'contacts';
  const owner = state.currentOwner;
  const search = state.contactsSearch;
  const pending = state.listPending[viewKey];
  if (reset && pending && pending.owner === owner && pending.search === search && pending.reset) {
    // 同一列表的全量请求仍在途(例如刚切走又切回),直接复用它,不重复发请求
    state.contactsLoading = true;
    resetListViewState(viewKey);
    updateListLoading();
    return;
  }

  state.listRequestIds[viewKey] += 1;
  const requestId = state.listRequestIds[viewKey];
  state.listPending[viewKey] = { owner, search, reset: Boolean(reset), requestId };
  state.contactsLoading = true;
  updateListLoading();
  if (reset) resetListViewState(viewKey);
  try {
    const page = reset ? 1 : state.contactsPage + 1;
    const params = new URLSearchParams({ page, pageSize: 200 });
    if (search) params.set('search', search);
    params.set('friends', '1'); // 通讯录只显示好友
    if (owner) params.set('owner', owner);
    const data = await api(`/api/contacts/grouped?${params}`);
    if (!isListResponseValid(requestId, owner, search, viewKey)) return;
    if (!isCurrentListRequest(requestId, owner, search, viewKey)) {
      cacheListResponse(viewKey, owner, search, data, reset);
      return;
    }
    const groups = Array.isArray(data.groups) ? data.groups : [];

    state.contactGroups = mergeContactGroups(state.contactGroups, groups);
    state.contacts = state.contactGroups.flatMap((group) => group.contacts);
    state.contactsTotal = Number(data.total) || state.contacts.length;
    state.contactsPage = Number(data.page) || page;
    state.contactsHasMore = Boolean(data.hasMore);
    state.contactsLoaded = true;
    updateEmptyTip();
    renderContactList();
    if (reset) $('#contactList').scrollTop = 0;
    saveListCache(viewKey);
  } catch (err) {
    if (isCurrentListRequest(requestId, owner, search, viewKey)) {
      toast(err.message, true);
    }
  } finally {
    if (state.listPending[viewKey] && state.listPending[viewKey].requestId === requestId) {
      state.listPending[viewKey] = null;
    }
    if (isCurrentListRequest(requestId, owner, search, viewKey)) {
      state.contactsLoading = false;
      updateListLoading();
      if (state.contacts.length === 0) renderContactList();
    }
  }
}

// ---------- 会话搜索:联系人 / 群聊 / 聊天记录 ----------

function searchCacheKey(owner, query) {
  return `${owner}\u0000${query}`;
}

function createSearchSection(section, isMessages) {
  const items = Array.isArray(section && section.items) ? section.items.slice(0, 3) : [];
  return {
    items,
    total: isMessages ? null : (Number(section && section.total) || items.length),
    hasMore: Boolean(section && section.hasMore),
  };
}

function buildSearchState(data, owner, query) {
  return {
    owner,
    query,
    contacts: createSearchSection(data.contacts, false),
    groups: createSearchSection(data.groups, false),
    messages: createSearchSection(data.messages, true),
    indexing: Boolean(data.indexing),
    ownerRequired: Boolean(data.ownerRequired),
  };
}

/** 当前搜索结果的渲染区域:移动端独立页 or 列表内搜索 */
function searchContentEl() {
  return state.searchMode === 'overlay' ? $('#searchPageContent') : $('#contactList');
}

function searchBodyEl() {
  return state.searchMode === 'overlay' ? $('#searchPageBody') : $('#contactList');
}

function updateInlineBackButton() {
  const btn = $('#listBackBtn');
  if (btn) btn.classList.toggle('hidden', !(state.searchMode === 'inline' && state.searchPage));
}

/** PC/分栏:在列表面板内开始搜索 */
function startInlineSearch(query) {
  state.searchMode = 'inline';
  state.searchQuery = query;
  state.contactsSearch = query;
  state.searchResults = null;
  state.searchLoading = false;
  state.searchRequestId += 1;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  updateInlineBackButton();
  updateSearchPlaceholder();
  const list = $('#contactList');
  if (list) list.scrollTop = 0;
  loadSearchResults();
}

/** 退出列表内搜索(不主动加载普通列表) */
function exitInlineSearch(options = {}) {
  const clearInput = options.clearInput !== false;
  clearTimeout(listSearchTimer);
  state.searchMode = state.searchOverlayOpen ? 'overlay' : null;
  state.searchQuery = '';
  state.contactsSearch = '';
  state.searchResults = null;
  state.searchLoading = false;
  state.searchRequestId += 1;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  if (clearInput) {
    const input = $('#searchBox');
    if (input) input.value = '';
  }
  updateInlineBackButton();
  updateSearchPlaceholder();
  updateListSearchClear();
  updateListLoading();
}

async function loadSearchResults() {
  const owner = state.currentOwner;
  const query = state.searchQuery;
  const mode = state.searchMode;
  if (!mode || !query) {
    state.searchResults = null;
    state.searchLoading = false;
    if (mode) renderSearchResults();
    return;
  }
  const key = searchCacheKey(owner, query);
  const cached = state.searchCache.get(key);
  if (cached) {
    state.searchResults = cached;
    state.searchLoading = false;
    renderSearchResults();
    return;
  }

  const requestId = state.searchRequestId + 1;
  state.searchRequestId = requestId;
  state.searchLoading = true;
  state.searchResults = null;
  const body = searchBodyEl();
  if (body) body.scrollTop = 0;
  renderSearchResults();

  try {
    const params = new URLSearchParams({ q: query });
    if (owner) params.set('owner', owner);
    const data = await api(`/api/search?${params}`);
    if (requestId !== state.searchRequestId
      || state.searchMode !== mode
      || owner !== state.currentOwner
      || query !== state.searchQuery) return;
    const results = buildSearchState(data, owner, query);
    // 索引构建中不缓存,完成后再次搜索可立即拿到聊天记录
    if (!results.indexing) {
      state.searchCache.set(key, results);
      while (state.searchCache.size > 8) {
        state.searchCache.delete(state.searchCache.keys().next().value);
      }
    }
    state.searchResults = results;
    renderSearchResults();
  } catch (err) {
    if (requestId === state.searchRequestId
      && state.searchMode === mode
      && owner === state.currentOwner
      && query === state.searchQuery) {
      toast(err.message, true);
      state.searchResults = null;
      renderSearchResults();
    }
  } finally {
    if (requestId === state.searchRequestId) {
      state.searchLoading = false;
      renderSearchResults();
    }
  }
}

function highlightText(value, query) {
  const raw = String(value ?? '');
  const needle = String(query || '').trim();
  if (!needle) return esc(raw);
  const lower = raw.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = '';
  let last = 0;
  let index = lower.indexOf(lowerNeedle);
  while (index >= 0) {
    out += esc(raw.slice(last, index));
    out += `<mark class="search-highlight">${esc(raw.slice(index, index + needle.length))}</mark>`;
    last = index + needle.length;
    index = lower.indexOf(lowerNeedle, last);
  }
  return out + esc(raw.slice(last));
}

function searchContactItemHtml(contact, kind) {
  const active = !state.selectedMessageId && state.selected
    && (state.selected.id === contact.id
      || (state.selected.hash && contact.hash && state.selected.hash === contact.hash));
  const name = displayName(contact);
  let subtitle = '';
  if (kind === 'groups') {
    const memberMatches = Array.isArray(contact.memberMatches) ? contact.memberMatches : [];
    if (!contact.matchedByName && memberMatches.length > 0) {
      const shown = memberMatches.slice(0, 3).join('、');
      const total = Number(contact.memberMatchCount) || memberMatches.length;
      subtitle = `包含：${shown}${total > memberMatches.length ? ` 等${total}人` : ''}`;
    } else {
      subtitle = contact.remark && contact.remark !== name
        ? contact.remark
        : (contact.lastMessage || contact.username || '群聊');
    }
  } else {
    subtitle = contact.remark && contact.remark !== name
      ? contact.remark
      : (contact.wxName ? `微信号: ${contact.wxName}` : (contact.username || contact.lastMessage || ''));
  }
  return `
    <div class="contact-item search-result-item${active ? ' active' : ''}"
         data-search-kind="${kind}" data-id="${contact.id}">
      <div class="contact-avatar" style="background-image:url('${avatarUrl(contact)}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${highlightText(name, state.searchQuery)}</div>
          <div class="contact-time">${formatListTime(contact.lastMessageTime)}</div>
        </div>
        <div class="contact-preview">${highlightText(subtitle, state.searchQuery)}</div>
      </div>
    </div>`;
}

function searchMessageItemHtml(item) {
  const contact = item.contact || {};
  const name = displayName(contact);
  const active = Number(state.selectedMessageId) === Number(item.id);
  return `
    <div class="contact-item search-result-item search-message-item${active ? ' active' : ''}"
         data-search-kind="message" data-id="${item.id}" data-contact-id="${contact.id}">
      <div class="contact-avatar" style="background-image:url('${avatarUrl(contact)}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${highlightText(name, state.searchQuery)}</div>
          <div class="contact-time">${formatListTime(item.createTime)}</div>
        </div>
        <div class="contact-preview search-message-preview">${highlightText(item.content || '', state.searchQuery)}</div>
      </div>
    </div>`;
}

function searchSectionHtml(key, title, section, kind) {
  const indexingNote = key === 'messages' && state.searchResults.indexing;
  if (!section.items.length && !indexingNote) return '';
  const moreLabel = {
    contacts: '更多联系人',
    groups: '更多群聊',
    messages: '更多聊天记录',
  }[key];
  const itemsHtml = section.items
    .map((item) => (kind === 'message' ? searchMessageItemHtml(item) : searchContactItemHtml(item, kind)))
    .join('');
  let actions = '';
  if (section.hasMore) {
    actions += `<button class="search-more-btn" type="button" data-search-action="more" data-section="${key}">${moreLabel}</button>`;
  }
  if (indexingNote) {
    actions += '<div class="search-indexing">聊天记录索引正在建立，稍后可搜索</div>';
  }
  return `<section class="search-section" data-section="${key}">
    <div class="search-section-title">${title}</div>
    ${itemsHtml}
    ${actions}
  </section>`;
}

function renderSearchResults() {
  const content = searchContentEl();
  if (!content) return;
  const body = searchBodyEl();
  const scrollTop = body ? body.scrollTop : 0;

  if (!state.searchQuery) {
    content.innerHTML = '<div class="empty-tip" style="padding-top:80px">搜索联系人、群聊和聊天记录</div>';
    if (body) body.scrollTop = 0;
    return;
  }

  if (!state.searchResults) {
    const tip = state.searchLoading ? '正在搜索...' : '没有匹配的结果';
    content.innerHTML = `<div class="empty-tip" style="padding-top:80px">${tip}</div>`;
    if (body) body.scrollTop = scrollTop;
    return;
  }

  const result = state.searchResults;
  const sections = [
    searchSectionHtml('contacts', '联系人', result.contacts, 'contacts'),
    searchSectionHtml('groups', '群聊', result.groups, 'groups'),
    searchSectionHtml('messages', '聊天记录', result.messages, 'message'),
  ].filter(Boolean);

  if (sections.length === 0) {
    const tip = result.ownerRequired
      ? '请先选择账号'
      : '没有匹配的联系人、群聊或聊天记录';
    content.innerHTML = `<div class="empty-tip" style="padding-top:80px">${tip}</div>`;
  } else {
    content.innerHTML = `<div class="search-sections">${sections.join('')}</div>`;
    content.querySelectorAll('[data-search-action="more"]').forEach((btn) => {
      btn.addEventListener('click', () => openSearchCategory(btn.dataset.section));
    });
    content.querySelectorAll('[data-search-kind]').forEach((el) => {
      el.addEventListener('click', () => {
        const kind = el.dataset.searchKind;
        if (kind === 'message') {
          const item = result.messages.items.find((msg) => Number(msg.id) === Number(el.dataset.id));
          if (item) openMessageSearchResult(item);
          return;
        }
        const section = kind === 'groups' ? result.groups : result.contacts;
        const contact = section.items.find((c) => Number(c.id) === Number(el.dataset.id));
        if (contact) openContact(contact);
      });
    });
  }
  if (body) body.scrollTop = scrollTop;
}

const SEARCH_PAGE_TITLES = {
  contacts: '联系人',
  groups: '群聊',
  messages: '聊天记录',
};

const SEARCH_PAGE_PLACEHOLDERS = {
  contacts: '搜索联系人',
  groups: '搜索群聊',
  messages: '搜索聊天记录',
};

/** 聊天内搜索页空态的快速分类 */
const CHAT_SEARCH_CATEGORIES = [
  { id: 'date', label: '日期' },
  { id: 'image_video', label: '图片与视频' },
  { id: 'file', label: '文件' },
  { id: 'link', label: '链接' },
  { id: 'music_audio', label: '音乐与音频' },
  { id: 'transaction', label: '交易' },
  { id: 'miniapp', label: '小程序' },
  { id: 'channels', label: '视频号' },
  { id: 'contact', label: '名片' },
  { id: 'location', label: '位置' },
  { id: 'note', label: '笔记' },
  { id: 'product_shop', label: '商品与小店' },
  { id: 'gift', label: '礼物' },
  { id: 'emoji', label: '表情' },
];

function updateSearchPageClear() {
  const input = $('#searchPageInput');
  const btn = $('#searchPageClearBtn');
  if (input && btn) btn.classList.toggle('hidden', !input.value);
}

function updateSearchPagePlaceholder() {
  const input = $('#searchPageInput');
  if (!input) return;
  input.placeholder = state.searchPage
    ? (SEARCH_PAGE_PLACEHOLDERS[state.searchPage.section] || '搜索')
    : '搜索联系人、群聊、聊天记录';
}

/** 列表面板搜索框:移动端会话页作为独立搜索页入口;PC/分栏及通讯录页就地搜索 */
function updateSearchPlaceholder() {
  const input = $('#searchBox');
  if (!input) return;
  if (state.view === 'contacts') {
    input.placeholder = '搜索联系人';
    return;
  }
  const inlinePage = state.searchMode === 'inline' ? state.searchPage : null;
  input.placeholder = inlinePage
    ? (SEARCH_PAGE_PLACEHOLDERS[inlinePage.section] || '搜索')
    : '搜索联系人、群聊、聊天记录';
}

function bindSearchPageItemClicks() {
  const page = state.searchPage;
  const content = searchContentEl();
  if (!page || !content) return;
  content.querySelectorAll('[data-search-kind]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = el.dataset.searchKind;
      if (kind === 'message') {
        const item = page.items.find((msg) => Number(msg.id) === Number(el.dataset.id));
        if (item) openMessageSearchResult(item);
        return;
      }
      const contact = page.items.find((c) => Number(c.id) === Number(el.dataset.id));
      if (contact) openContact(contact);
    });
  });
}

function renderSearchPage() {
  const page = state.searchPage;
  const content = searchContentEl();
  if (!page || !content) return;
  setPagingBusy(Boolean(page.loading && page.items.length > 0));
  const body = searchBodyEl();
  const scrollTop = body ? body.scrollTop : 0;

  if (page.items.length === 0) {
    const tip = page.loading
      ? '正在加载...'
      : (page.error || (page.query ? '没有匹配的结果' : '输入关键词搜索'));
    content.innerHTML = `<div class="empty-tip" style="padding-top:80px">${esc(tip)}</div>`;
    if (body) body.scrollTop = scrollTop;
    return;
  }

  const title = SEARCH_PAGE_TITLES[page.section] || '';
  const count = page.total !== null && page.total !== undefined
    ? ` · ${Number(page.total) || page.items.length}`
    : '';
  const itemsHtml = page.items.map((item) => (
    page.section === 'messages'
      ? searchMessageItemHtml(item)
      : searchContactItemHtml(item, page.section)
  )).join('');
  let html = `<div class="search-page-title">${esc(title)}${esc(count)}</div>${itemsHtml}`;
  if (page.loading) {
    html += '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>';
  }
  if (page.error) {
    html += `<div class="search-page-error">${esc(page.error)}</div>`;
  }
  content.innerHTML = html;
  if (body) body.scrollTop = scrollTop;
  bindSearchPageItemClicks();
}

function openSearchOverlay(initialQuery = '') {
  if (state.searchOverlayOpen) {
    const existingInput = $('#searchPageInput');
    if (existingInput) existingInput.focus();
    return;
  }
  const query = String(initialQuery || '').trim();
  clearTimeout(searchPageTimer);
  state.searchOverlayOpen = true;
  state.searchMode = 'overlay';
  state.searchQuery = query;
  state.searchResults = null;
  state.searchLoading = false;
  state.searchRequestId += 1;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  state.searchHistoryDepth = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;

  const listInput = $('#searchBox');
  if (listInput) listInput.value = '';
  state.contactsSearch = '';
  updateListSearchClear();
  updateInlineBackButton();

  const view = $('#searchPageView');
  if (view) {
    view.classList.toggle('search-page--fullscreen', isMobileSinglePane());
    view.classList.remove('hidden');
  }
  $('#app').classList.add('search-open');

  const input = $('#searchPageInput');
  if (input) input.value = query;
  updateSearchPageClear();
  updateSearchPagePlaceholder();

  const body = $('#searchPageBody');
  if (body) body.scrollTop = 0;
  const content = $('#searchPageContent');
  if (content) content.innerHTML = '';
  renderSearchResults();

  if (isMobileSinglePane()) {
    try {
      history.pushState({ wepoSearch: 'grouped' }, '', location.href);
      state.searchHistoryDepth = 1;
    } catch (err) {
      state.searchHistoryDepth = 0;
    }
  }

  if (input) input.focus();
  if (query) loadSearchResults();
}

function closeSearchOverlay() {
  if (!state.searchOverlayOpen) return;
  clearTimeout(searchPageTimer);
  const reloadChat = Boolean(state.selected && state.chatSearch && state.view === 'chats');
  state.searchOverlayOpen = false;
  state.searchMode = null;
  state.searchQuery = '';
  state.searchResults = null;
  state.searchLoading = false;
  state.searchPage = null;
  state.searchRequestId += 1;
  state.searchPageRequestId += 1;
  state.searchHistoryDepth = 0;
  setPagingBusy(false);
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;

  const view = $('#searchPageView');
  if (view) {
    view.classList.add('hidden');
    view.classList.remove('search-page--fullscreen');
  }
  $('#app').classList.remove('search-open');
  const input = $('#searchPageInput');
  if (input) {
    input.blur();
    input.value = '';
  }
  updateSearchPageClear();
  updateSearchPagePlaceholder();
  const body = $('#searchPageBody');
  if (body) body.scrollTop = 0;
  const content = $('#searchPageContent');
  if (content) content.innerHTML = '';
  updateInlineBackButton();
  updateSearchPlaceholder();
  updateChatSearchFilterBar();
  renderContactList();
  if (reloadChat && state.selected) loadMessages(true);
}

function openSearchCategory(section) {
  const result = state.searchResults;
  const sectionData = result && result[section];
  const mode = state.searchMode;
  if (!mode || !sectionData || !SEARCH_PAGE_TITLES[section]) return;
  if (mode === 'overlay' && !state.searchOverlayOpen) return;
  if (result.owner !== state.currentOwner || result.query !== state.searchQuery) return;

  const body = searchBodyEl();
  const returnScrollTop = body ? body.scrollTop : 0;
  state.searchPage = {
    section,
    owner: result.owner,
    query: result.query,
    items: [],
    total: section === 'messages' ? null : (Number(sectionData.total) || 0),
    page: 0,
    pageSize: SEARCH_PAGE_SIZE,
    hasMore: true,
    loading: true,
    error: '',
    returnScrollTop,
    scrollPointerActive: false,
    lastScrollAt: 0,
    wheelUntil: 0,
  };
  state.selectedMessageId = null;
  state.searchPageRequestId += 1;

  if (mode === 'overlay' && isMobileSinglePane() && state.searchHistoryDepth >= 1) {
    try {
      history.pushState({ wepoSearch: 'category' }, '', location.href);
      state.searchHistoryDepth += 1;
    } catch (err) {
      /* pushState 失败时退回直接关闭分类页 */
    }
  }

  if (mode === 'overlay') {
    updateSearchPagePlaceholder();
  } else {
    updateInlineBackButton();
    updateSearchPlaceholder();
  }
  if (body) body.scrollTop = 0;
  if (mode === 'overlay') renderSearchPage();
  else renderContactList();
  loadSearchPage(true);
}

function closeSearchCategory() {
  const page = state.searchPage;
  if (!page) return;
  const mode = state.searchMode;
  state.searchPage = null;
  state.searchPageRequestId += 1;
  setPagingBusy(false);

  if (mode === 'overlay') updateSearchPagePlaceholder();
  else {
    updateInlineBackButton();
    updateSearchPlaceholder();
  }

  const body = searchBodyEl();
  if (!state.searchQuery) {
    if (mode === 'inline') {
      exitInlineSearch({ clearInput: true });
      loadContacts(true);
      return;
    }
    state.searchResults = null;
    state.searchLoading = false;
    if (body) body.scrollTop = 0;
    renderSearchResults();
    return;
  }

  const needsReload = !state.searchResults
    || state.searchResults.owner !== state.currentOwner
    || state.searchResults.query !== state.searchQuery;
  if (needsReload) {
    state.searchResults = null;
    if (body) body.scrollTop = 0;
    loadSearchResults();
    return;
  }

  if (mode === 'inline') renderContactList();
  else renderSearchResults();
  if (body) {
    const top = page.returnScrollTop || 0;
    body.scrollTop = top;
    requestAnimationFrame(() => {
      if (!state.searchPage && state.searchMode === mode && body.isConnected) {
        body.scrollTop = top;
      }
    });
  }
}

function handleSearchPageBack() {
  if (!state.searchOverlayOpen) return;
  if (state.searchPage) {
    if (state.searchHistoryDepth >= 2) {
      history.back();
    } else {
      closeSearchCategory();
    }
    return;
  }
  if (state.searchHistoryDepth >= 1) {
    history.back();
  } else {
    closeSearchOverlay();
  }
}

/** 全局搜索分类页是否仍处于触摸/惯性/滚轮滚动中 */
function isSearchPageScrollActive(page) {
  if (!page) return false;
  const now = performance.now();
  return Boolean(page.scrollPointerActive)
    || now - Number(page.lastScrollAt || 0) < 140
    || now < Number(page.wheelUntil || 0);
}

/** 等用户停止滚动后再追加/重绘分类结果,避免惯性滚动中整表重建造成闪屏 */
function waitForSearchPageScrollIdle(page, maxMs = 4000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const check = () => {
      if (!isSearchPageScrollActive(page) || performance.now() - startedAt >= maxMs) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function loadSearchPage(reset) {
  const page = state.searchPage;
  const mode = state.searchMode;
  if (!page || !mode) return;
  if (mode === 'overlay' && !state.searchOverlayOpen) return;
  if (!reset && (page.loading || !page.hasMore)) return;
  const requestId = state.searchPageRequestId + 1;
  state.searchPageRequestId = requestId;
  page.loading = true;
  page.error = '';
  if (!reset) setPagingBusy(true);
  const pageToLoad = reset ? 1 : page.page + 1;
  if (reset) {
    page.items = [];
    page.page = 0;
    page.hasMore = true;
    const body = searchBodyEl();
    if (body) body.scrollTop = 0;
    // 首屏/新关键词立即重绘;追加分页保留当前 DOM,等滚动停止和接口返回后
    // 一次性渲染,避免用户滚动期间整页重建造成闪屏。
    renderSearchPage();
  }

  try {
    const params = new URLSearchParams({
      owner: page.owner,
      q: page.query,
      section: page.section,
      page: pageToLoad,
      pageSize: page.pageSize,
    });
    const data = await api(`/api/search?${params}`);
    if (!reset) {
      // 分类页的新一页是更早的结果。先等滚动/惯性结束,再写入并重绘,
      // 避免渲染和滚动同时发生导致页面闪烁或多翻一页。
      await waitForSearchPageScrollIdle(page);
    }
    if (requestId !== state.searchPageRequestId
      || state.searchPage !== page
      || state.searchMode !== mode
      || (mode === 'overlay' && !state.searchOverlayOpen)
      || state.currentOwner !== page.owner
      || page.query !== state.searchQuery) return;
    const items = Array.isArray(data.items) ? data.items : [];
    page.items = reset ? items : page.items.concat(items);
    page.page = Number(data.page) || pageToLoad;
    page.hasMore = Boolean(data.hasMore);
    if (page.section !== 'messages') {
      page.total = Number(data.total) || 0;
    }
  } catch (err) {
    if (requestId === state.searchPageRequestId && state.searchPage === page) {
      page.error = err.message || '加载失败';
      page.hasMore = false;
      toast(page.error, true);
    }
  } finally {
    if (requestId === state.searchPageRequestId && state.searchPage === page) {
      page.loading = false;
      renderSearchPage();
    }
  }
}

function contactItemHtml(c, compact = false) {
  const name = displayName(c);
  const timeHtml = compact ? '' : `<div class="contact-time">${formatListTime(c.lastMessageTime)}</div>`;
  const previewHtml = compact
    ? ''
    : `<div class="contact-preview">${esc(c.lastMessage || (c.messageCount > 0 ? '' : '暂无消息'))}</div>`;
  return `
    <div class="contact-item${compact ? ' contact-item--compact' : ''}${state.selected && state.selected.id === c.id ? ' active' : ''}" data-id="${c.id}">
      <div class="contact-avatar" style="background-image:url('${avatarUrl(c)}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${esc(name)}</div>
          ${timeHtml}
        </div>
        ${previewHtml}
      </div>
    </div>`;
}

/** 通讯录列表顶部的固定入口:标签、群聊(搜索时不展示) */
function contactShortcutsHtml() {
  if (state.view !== 'contacts' || state.contactsSearch) return '';
  return `
    <div class="contact-shortcuts">
      <div class="contact-item contact-shortcut" data-contact-entry="tags" role="button" tabindex="0">
        <div class="contact-shortcut-icon contact-shortcut-icon--tags" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path fill="currentColor" d="M3.6 4.2c0-.3.3-.6.6-.6h6.9c.2 0 .4.1.5.2l8.8 8.8c.3.3.3.7 0 1l-6.6 6.6c-.3.3-.7.3-1 0L4 11.4a.7.7 0 0 1-.2-.5V4.2zm4.8 4.7a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z"/>
          </svg>
        </div>
        <div class="contact-info">
          <div class="contact-name-row"><div class="contact-name">标签</div></div>
        </div>
      </div>
      <div class="contact-item contact-shortcut" data-contact-entry="rooms" role="button" tabindex="0">
        <div class="contact-shortcut-icon contact-shortcut-icon--rooms" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path fill="currentColor" d="M8.8 11.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2zm7.1.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4zM8.8 13c-3.2 0-5.8 1.7-5.8 3.8v1.7h11.6v-1.7c0-2.1-2.6-3.8-5.8-3.8zm7.1.3c-.3 0-.6 0-.9.1 1.1.9 1.8 2 1.8 3.4v1.7h4.9v-1.6c0-1.9-2.4-3.6-5.8-3.6z"/>
          </svg>
        </div>
        <div class="contact-info">
          <div class="contact-name-row"><div class="contact-name">群聊</div></div>
        </div>
      </div>
    </div>`;
}

function bindContactListActions() {
  const list = $('#contactList');
  list.querySelectorAll('.contact-item[data-id]').forEach((el) => {
    el.addEventListener('click', () => selectContact(Number(el.dataset.id)));
  });
  list.querySelectorAll('[data-contact-entry]').forEach((el) => {
    const open = () => {
      if (el.dataset.contactEntry === 'tags') openContactTagsPage();
      else openContactRoomsPage();
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

// ---------- 通讯录子页面:标签 / 群聊 ----------

function contactSubpageContactsFromGroups(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((group) => group.contacts || []);
}

function contactTagChevronHtml() {
  return `
    <span class="contact-tag-chevron" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16">
        <path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    </span>`;
}

/** 标签成员预览:单行显示,超出部分由 CSS 省略 */
function contactTagPreviewHtml(names) {
  const text = (Array.isArray(names) ? names : []).join('、');
  return text ? `<div class="contact-tag-preview">${esc(text)}</div>` : '';
}

function openContactTagsPage() {
  if (state.view !== 'contacts') return;
  const page = {
    kind: 'tags',
    title: '标签',
    loading: true,
    error: '',
    tags: [],
    untaggedCount: 0,
    untaggedMembers: [],
    totalFriends: 0,
    parent: null,
  };
  openContactSubpage(page);
}

function openContactRoomsPage() {
  if (state.view !== 'contacts') return;
  const page = {
    kind: 'rooms',
    title: '群聊',
    loading: true,
    loadingMore: false,
    error: '',
    groups: [],
    contacts: [],
    total: 0,
    page: 1,
    pageSize: 100,
    hasMore: false,
    parent: null,
  };
  openContactSubpage(page);
}

/** 打开通讯录子页面;移动端单栏时压入 history,支持原生侧滑返回 */
function openContactSubpage(page, options = {}) {
  const fromHistory = options.fromHistory === true;
  state.contactSubpage = page;
  state.contactSubpageRequestId += 1;
  page.requestId = state.contactSubpageRequestId;

  if (!fromHistory && isMobileSinglePane()) {
    try {
      history.pushState({ wepoContactSubpage: true }, '', location.href);
      state.contactSubpageHistoryDepth += 1;
    } catch (err) {
      /* 浏览器禁止 pushState 时仍可通过页面返回按钮退出 */
    }
  }

  $('#app').classList.add('contact-subpage-open');
  $('#contactSubpage').classList.remove('hidden');
  $('#contactSubpageBody').scrollTop = 0;
  renderContactSubpage();
  updateMobileChrome();

  if (options.load === false) return;
  if (page.kind === 'tags') loadContactTagsPage(page);
  else loadContactSubpageContacts(page, true);
}

/** 从下一级页面回到已加载的标签页,不重新请求 */
function restoreContactSubpagePage(page) {
  state.contactSubpage = page;
  state.contactSubpageRequestId += 1;
  renderContactSubpage();
  updateMobileChrome();
}

function closeContactSubpage(options = {}) {
  if (!state.contactSubpage) return;
  const fromHistory = options.fromHistory === true;
  const depth = state.contactSubpageHistoryDepth;
  state.contactSubpage = null;
  state.contactSubpageHistoryDepth = 0;
  state.contactSubpageRequestId += 1;
  $('#contactSubpage').classList.add('hidden');
  $('#contactSubpageBody').innerHTML = '';
  $('#app').classList.remove('contact-subpage-open');
  updateMobileChrome();
  if (!fromHistory && depth > 0) {
    armIgnoreNextPop();
    try {
      history.go(-depth);
    } catch (err) {
      consumeIgnoreNextPop();
    }
  }
  renderContactList();
}

/** 页面内返回按钮 / 移动端顶部返回:优先使用原生 history 返回 */
function backContactSubpage() {
  const page = state.contactSubpage;
  if (!page) return;
  if (state.contactSubpageHistoryDepth > 0) {
    history.back();
    return;
  }
  if (page.kind === 'tag' && page.parent) {
    restoreContactSubpagePage(page.parent);
    return;
  }
  closeContactSubpage({ fromHistory: true });
}

function renderContactSubpage() {
  const page = state.contactSubpage;
  if (!page) return;
  const title = $('#contactSubpageTitle');
  if (title) title.textContent = page.title || '';
  const body = $('#contactSubpageBody');
  if (!body) return;

  if (page.kind === 'tags') {
    if (page.loading) {
      body.innerHTML = '<div class="empty-tip" style="padding-top:60px">正在加载标签...</div>';
      return;
    }
    if (page.error) {
      body.innerHTML = `<div class="empty-tip" style="padding-top:60px">${esc(page.error)}</div>`;
      return;
    }
    const untagged = `
      <div class="contact-item contact-tag-row contact-tag-row--untagged" data-tag-index="-1" role="button" tabindex="0">
        <div class="contact-info">
          <div class="contact-name-row">
            <div class="contact-name">未设置标签的朋友（${formatStatNumber(page.untaggedCount || 0)}）</div>
          </div>
          ${contactTagPreviewHtml(page.untaggedMembers)}
        </div>
        ${contactTagChevronHtml()}
      </div>`;
    const rows = page.tags.map((tag, index) => `
      <div class="contact-item contact-tag-row" data-tag-index="${index}" role="button" tabindex="0">
        <div class="contact-info">
          <div class="contact-name-row">
            <div class="contact-name">${esc(tag.name)}（${formatStatNumber(tag.count || 0)}）</div>
          </div>
          ${contactTagPreviewHtml(tag.members)}
        </div>
        ${contactTagChevronHtml()}
      </div>`).join('');
    body.innerHTML = `<div class="contact-tag-list">${untagged}${rows}</div>`;
    body.querySelectorAll('[data-tag-index]').forEach((el) => {
      const openTag = () => {
        const index = Number(el.dataset.tagIndex);
        const untaggedPage = index < 0;
        const tag = untaggedPage ? null : page.tags[index];
        if (!untaggedPage && !tag) return;
        openContactSubpage({
          kind: 'tag',
          title: untaggedPage ? '未设置标签的朋友' : tag.name,
          tagName: untaggedPage ? '' : tag.name,
          untagged: untaggedPage,
          loading: true,
          loadingMore: false,
          error: '',
          groups: [],
          contacts: [],
          total: 0,
          page: 1,
          pageSize: 100,
          hasMore: false,
          parent: page,
        });
      };
      el.addEventListener('click', openTag);
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTag();
        }
      });
    });
    return;
  }

  if (page.loading) {
    body.innerHTML = `<div class="empty-tip" style="padding-top:60px">正在加载${page.kind === 'rooms' ? '群聊' : '联系人'}...</div>`;
    return;
  }
  if (page.error) {
    body.innerHTML = `<div class="empty-tip" style="padding-top:60px">${esc(page.error)}</div>`;
    return;
  }
  if (page.contacts.length === 0) {
    body.innerHTML = `<div class="empty-tip" style="padding-top:60px">${page.kind === 'rooms' ? '暂无群聊' : '暂无联系人'}</div>`;
    return;
  }

  let contentHtml;
  if (page.kind === 'tag' && Array.isArray(page.groups) && page.groups.length > 0) {
    contentHtml = page.groups.map((group) => `
      <div class="contact-group">
        <div class="contact-group-header">${esc(group.letter)}</div>
        ${(group.contacts || []).map((contact) => contactItemHtml(contact, true)).join('')}
      </div>`).join('');
  } else {
    contentHtml = page.contacts.map((contact) => contactItemHtml(contact, true)).join('');
  }
  const moreHtml = page.loadingMore
    ? '<div class="loading-indicator" style="padding:14px"><span class="spinner"></span><span>加载中...</span></div>'
    : (page.hasMore ? '<div class="contact-subpage-more" style="padding:12px;text-align:center;color:var(--text-weak);font-size:13px">继续上滑加载更多</div>' : '');
  body.innerHTML = contentHtml + moreHtml;

  const byId = new Map(page.contacts.map((contact) => [contact.id, contact]));
  body.querySelectorAll('.contact-item[data-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const contact = byId.get(Number(el.dataset.id));
      if (contact) openContact(contact);
    });
  });
}

async function loadContactTagsPage(page) {
  const requestId = page.requestId;
  const owner = state.currentOwner;
  try {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    const data = await api(`/api/contacts/tags?${params}`);
    if (page !== state.contactSubpage || requestId !== page.requestId) return;
    page.tags = Array.isArray(data.tags) ? data.tags : [];
    page.untaggedCount = Number(data.untaggedCount) || 0;
    page.untaggedMembers = Array.isArray(data.untaggedMembers) ? data.untaggedMembers : [];
    page.totalFriends = Number(data.totalFriends) || 0;
    page.loading = false;
    page.error = '';
    renderContactSubpage();
  } catch (err) {
    if (page !== state.contactSubpage || requestId !== page.requestId) return;
    page.loading = false;
    page.error = err.message || '标签加载失败';
    renderContactSubpage();
  }
}

async function loadContactSubpageContacts(page, reset) {
  const requestId = state.contactSubpageRequestId + 1;
  state.contactSubpageRequestId = requestId;
  page.requestId = requestId;
  if (reset) {
    page.loading = true;
    page.error = '';
    page.groups = [];
    page.contacts = [];
    page.total = 0;
    page.hasMore = false;
    page.loadingMore = false;
  } else {
    page.loadingMore = true;
  }
  renderContactSubpage();

  const owner = state.currentOwner;
  const pageNumber = reset ? 1 : page.page + 1;
  const params = new URLSearchParams({
    page: String(pageNumber),
    pageSize: String(page.pageSize),
  });
  if (owner) params.set('owner', owner);
  if (page.kind === 'rooms') {
    params.set('rooms', '1');
  } else {
    params.set('friends', '1');
    if (page.untagged) params.set('untagged', '1');
    else params.set('tag', page.tagName);
  }

  try {
    const data = await api(`/api/contacts/grouped?${params}`);
    if (page !== state.contactSubpage || requestId !== page.requestId) return;
    const groups = Array.isArray(data.groups) ? data.groups : [];
    page.groups = reset ? groups : mergeContactGroups(page.groups, groups);
    page.contacts = contactSubpageContactsFromGroups(page.groups);
    page.total = Number(data.total) || page.contacts.length;
    page.page = Number(data.page) || pageNumber;
    page.hasMore = Boolean(data.hasMore);
    page.loading = false;
    page.loadingMore = false;
    page.error = '';
    renderContactSubpage();
  } catch (err) {
    if (page !== state.contactSubpage || requestId !== page.requestId) return;
    page.loading = false;
    page.loadingMore = false;
    page.error = err.message || '加载失败';
    renderContactSubpage();
  }
}

function loadMoreContactSubpage() {
  const page = state.contactSubpage;
  if (!page || page.kind === 'tags' || page.loading || page.loadingMore || !page.hasMore) return;
  loadContactSubpageContacts(page, false);
}

/** 只更新子页面选中高亮,避免重建列表导致滚动位置丢失 */
function updateContactSubpageSelection() {
  const body = $('#contactSubpageBody');
  if (!body || !state.contactSubpage) return;
  const selectedId = state.selected ? state.selected.id : null;
  body.querySelectorAll('.contact-item[data-id]').forEach((el) => {
    el.classList.toggle('active', selectedId !== null && Number(el.dataset.id) === selectedId);
  });
}

function renderContactList() {
  // 防御:如果 DOM 当前标签与 state 不一致,宁可不渲染,避免把旧响应画到新 tab 上
  const appView = $('#app')?.dataset.view;
  if (appView && appView !== state.view) return;
  if (state.searchMode === 'inline' && state.view === 'chats') {
    if (state.searchPage) renderSearchPage();
    else renderSearchResults();
    return;
  }
  const list = $('#contactList');
  if (state.contacts.length === 0) {
    list.innerHTML = contactShortcutsHtml() + `<div class="empty-tip" style="padding-top:60px">${
      state.contactsLoading
        ? '正在加载...'
        : (state.contactsSearch ? '没有匹配的联系人' : '暂无数据,请使用桌面客户端导入备份')
    }</div>`;
    bindContactListActions();
    return;
  }

  let itemsHtml = '';
  if (state.view === 'contacts' && state.contactGroups) {
    itemsHtml = state.contactGroups.map((group) => `
      <div class="contact-group">
        <div class="contact-group-header">${esc(group.letter)}</div>
        ${group.contacts.map((contact) => contactItemHtml(contact, true)).join('')}
      </div>`).join('');
  } else {
    itemsHtml = state.contacts.map((contact) => contactItemHtml(contact)).join('');
  }

  list.innerHTML = contactShortcutsHtml() + itemsHtml;
  bindContactListActions();
}

/** 从搜索页进入聊天详情:移动端先隐藏搜索页,返回时恢复;桌面端直接关闭搜索页 */
function suspendSearchOverlayForDetail() {
  if (!state.searchOverlayOpen) return;
  clearTimeout(searchPageTimer);
  // PC/分栏:搜索页只替换左侧列表,打开聊天时保持搜索页
  if (!isMobileSinglePane()) return;
  const input = $('#searchPageInput');
  if (input) input.blur();
  const view = $('#searchPageView');
  if (view) view.classList.add('hidden');
}

/** 搜索页被聊天详情暂时遮住时,同步选中态;返回搜索页后高亮仍正确 */
function refreshSearchOverlayView() {
  if (!state.searchOverlayOpen) return;
  if (state.searchPage) renderSearchPage();
  else renderSearchResults();
}

function openContact(contact) {
  if (!contact) return;
  stopAllAudioPlayback();
  pushDetailHistoryState();
  const contactList = $('#contactList');
  if (state.view === 'contacts' && !state.contactSubpage) {
    contactListReturnScrollTop = contactList ? contactList.scrollTop : null;
  } else {
    contactListReturnScrollTop = null;
  }
  state.chatFromContactDetail = false;
  chatFromContactHistoryPushed = false;
  if (state.chatContactDetailOpen) closeChatContactDetail();
  if (state.chatSearchPageOpen) closeChatSearchPage();
  suspendSearchOverlayForDetail();
  state.selected = contact;
  state.messages = [];
  state.messagePage = 1;
  state.messageDateMode = false;
  state.messageHasNewer = false;
  state.messageOlderCursor = null;
  state.messageNewerCursor = null;
  state.messagesLoadingNewer = false;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  refreshSearchOverlayView();
  renderContactListKeepingScroll();
  updateContactSubpageSelection();
  if (state.view === 'contacts') {
    renderContactDetail(contact);
    openDetail();
    return;
  }
  showView('chats');
  renderChat(contact);
  loadMessages(true);
  openDetail();
}

/** 通讯录联系人详情 → 查看聊天记录:聊天页作为独立层级,返回先回联系人详情 */
function openChatFromContactDetail(contact) {
  if (!contact) return;
  stopAllAudioPlayback();
  // pushState 必须在用户手势回调中尽早执行;iOS WebKit 会把过晚的调用
  // 标记为虚拟记录,导致后续系统返回被跳过。
  pushDetailHistoryState();
  chatFromContactHistoryPushed = false;
  const chatHistoryPushed = pushChatFromContactHistoryState();

  state.selected = contact;
  state.messages = [];
  state.messagePage = 1;
  state.messageHasMore = false;
  state.messageHasNewer = false;
  state.messageDateMode = false;
  state.messageOlderCursor = null;
  state.messageNewerCursor = null;
  state.messageAnchorId = null;
  state.messagesLoadingNewer = false;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  state.dateJumpOpen = false;
  dateJumpHistoryPushed = false;
  savedMessagePageState = null;

  showView('chats');
  state.chatFromContactDetail = true;
  chatFromContactHistoryPushed = chatHistoryPushed;
  renderChat(contact);
  loadMessages(true);
  openDetail();
  if (isMobileSinglePane() && !chatFromContactHistoryPushed) {
    pushChatFromContactHistoryState();
  }
  updateMobileChrome();
}

/** 从通讯录进入的聊天页返回联系人详情 */
function returnFromChatToContactDetail() {
  if (!state.chatFromContactDetail) return false;
  stopAllAudioPlayback();
  const contact = state.selected;
  state.chatFromContactDetail = false;
  chatFromContactHistoryPushed = false;
  if (!contact) return false;
  showView('contacts');
  openDetail();
  updateMobileChrome();
  return true;
}

/** 聊天页返回按钮:移动端优先走对应 history 层 */
function handleChatFromContactBack() {
  if (!state.chatFromContactDetail) return;
  if (state.view !== 'chats') {
    // 已经回到通讯录详情,不再把返回操作当作聊天层级处理
    state.chatFromContactDetail = false;
    chatFromContactHistoryPushed = false;
    return;
  }
  if (chatFromContactHistoryPushed) {
    try {
      history.back();
      return;
    } catch (err) {
      chatFromContactHistoryPushed = false;
    }
  }
  returnFromChatToContactDetail();
}

function selectContact(id) {
  const contact = state.contacts.find((c) => c.id === id);
  if (!contact) return;
  openContact(contact);
}

/** 点击“聊天记录”搜索结果:打开对应会话,并自动执行同关键词的聊天内搜索 */
function openMessageSearchResult(item) {
  const contact = item && item.contact;
  if (!contact) return;
  state.chatFromContactDetail = false;
  chatFromContactHistoryPushed = false;
  if (state.chatSearchPageOpen) closeChatSearchPage();
  const query = state.searchOverlayOpen ? state.searchQuery : state.contactsSearch;
  suspendSearchOverlayForDetail();
  state.selected = contact;
  state.messages = [];
  state.messagePage = 1;
  state.selectedMessageId = Number(item.id) || null;
  state.pendingMessageFocusId = Number(item.id) || null;
  state.chatSearch = query;
  state.chatSearchFilterTotal = 0;
  refreshSearchOverlayView();
  renderContactList();
  showView('chats');
  renderChat(contact);
  loadMessages(true);
  openDetail();
}

// ---------- 当前会话内搜索 ----------

function updateChatSearchFilterBar() {
  const bar = $('#chatSearchFilterBar');
  const text = $('#chatSearchFilterText');
  if (!bar) return;
  const active = Boolean(state.selected && state.view === 'chats' && state.chatSearch);
  bar.classList.toggle('hidden', !active);
  if (active && text) {
    let label = `搜索“${state.chatSearch}”`;
    if (state.chatSearchFilterTotal > 0) {
      label += ` · 共 ${formatStatNumber(state.chatSearchFilterTotal)} 条匹配`;
    }
    text.textContent = label;
  }
}

function updateChatSearchPageClear() {
  const input = $('#chatSearchPageInput');
  const btn = $('#chatSearchPageClearBtn');
  if (input && btn) btn.classList.toggle('hidden', !input.value);
}

function chatSearchMessageAvatar(item, contact) {
  if (item.isSent) {
    const user = currentUser();
    return user ? userAvatarUrl(user) : fallbackAvatar('我', contact.owner || 'me');
  }
  if (contact.isChatroom) {
    return avatarUrl({
      avatar: item.senderAvatar || '',
      nickname: item.senderName || item.sender || '群成员',
      hash: item.sender || contact.hash,
    });
  }
  return avatarUrl(contact);
}

function chatSearchMessageItemHtml(item, index) {
  const contact = state.selected;
  const page = state.chatSearchPage;
  if (!contact || !page) return '';
  const isSelf = Boolean(item.isSent);
  const senderName = isSelf
    ? '我'
    : (contact.isChatroom
      ? (item.senderName || memberName(contact, item.sender) || item.sender || '群成员')
      : displayName(contact));
  const preview = highlightText(String(item.content || '').trim() || '[消息]', page.query);
  const avatar = chatSearchMessageAvatar(item, contact);
  return `
    <div class="contact-item search-result-item search-message-item chat-search-message-item"
         data-chat-search-index="${index}" data-chat-search-message-id="${item.id}">
      <div class="contact-avatar" style="background-image:url('${avatar}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${esc(senderName)}</div>
          <div class="contact-time">${formatListTime(item.createTime)}</div>
        </div>
        <div class="contact-preview search-message-preview">${preview}</div>
      </div>
    </div>`;
}

function chatSearchBrowseItemHtml(item, timeText) {
  const contact = state.selected;
  if (!contact) return '';
  const isSelf = Boolean(item.isSent);
  const senderName = isSelf
    ? '我'
    : (contact.isChatroom
      ? (item.senderName || memberName(contact, item.sender) || item.sender || '群成员')
      : displayName(contact));
  const preview = esc(String(item.content || '').trim() || '[消息]');
  const avatar = chatSearchMessageAvatar(item, contact);
  return `
    <div class="contact-item search-result-item search-message-item chat-search-browse-item"
         data-chat-search-message-id="${item.id}">
      <div class="contact-avatar" style="background-image:url('${avatar}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${esc(senderName)}</div>
          <div class="contact-time">${esc(timeText || formatListTime(item.createTime))}</div>
        </div>
        <div class="contact-preview search-message-preview">${preview}</div>
      </div>
    </div>`;
}

function formatClockTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 链接/位置分类列表的周分组与日期文案(参照微信聊天内容列表) */
function chatSearchMediaGroup(sec) {
  const date = new Date((Number(sec) || 0) * 1000);
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart);
  weekStart.setDate(dayStart.getDate() - ((dayStart.getDay() + 6) % 7));
  if (date >= weekStart) return { key: 'week', label: '本周' };
  return {
    key: `${date.getFullYear()}-${date.getMonth()}`,
    label: `${date.getFullYear()}年${date.getMonth() + 1}月`,
  };
}

function chatSearchMediaTimeLabel(sec) {
  const date = new Date((Number(sec) || 0) * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (day >= weekStart) return `星期${'日一二三四五六'[date.getDay()]}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function chatSearchMediaFromLabel(item, contact) {
  if (item.isSent) return '我';
  if (contact && contact.isChatroom) {
    return item.senderName || memberName(contact, item.sender) || item.sender || '群成员';
  }
  return contact ? displayName(contact) : '';
}

function chatSearchMediaThumbPlaceholder(kind) {
  if (kind === 'location') {
    return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M12 21s6.5-6.2 6.5-11.5a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
      <circle cx="12" cy="9.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"></circle>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M10.2 13.8a4.2 4.2 0 0 0 5.9 0l2.1-2.1a4.2 4.2 0 0 0-5.9-5.9L11 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
    <path d="M13.8 10.2a4.2 4.2 0 0 0-5.9 0l-2.1 2.1a4.2 4.2 0 0 0 5.9 5.9L13 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
  </svg>`;
}

function chatSearchLinkListItemHtml(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const host = urlHost(extra.url);
  const title = cleanCardText(extra.title)
    || cleanCardText(extra.des)
    || String(item.content || '').replace(/^\[(链接|视频)\]\s*/, '').split('\n')[0].trim()
    || '链接';
  const desc = cleanCardText(extra.des).replace(/\s*\n+\s*/g, ' ');
  const source = linkSourceLabel(extra, host);
  const detail = desc && desc !== title && desc !== source ? desc : '';
  const subtitle = [source, detail].filter(Boolean).join(' | ');
  const { src, fallback } = linkThumbnailInfo(item, extra);
  const isVideo = Number(extra.appType) === 4;
  const thumb = src
    ? `<div class="chat-search-media-thumb"><img class="chat-search-media-thumb-img"
          src="${esc(src)}"${fallback ? ` data-fallback-src="${esc(fallback)}"` : ''}
          alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer">${isVideo ? linkPlayButtonHtml() : ''}</div>`
    : `<div class="chat-search-media-thumb chat-search-media-thumb--empty">${chatSearchMediaThumbPlaceholder('link')}</div>`;
  return `
    <div class="chat-search-media-item" data-chat-search-message-id="${item.id}">
      ${thumb}
      <div class="chat-search-media-main">
        <div class="chat-search-media-title">${esc(title)}</div>
        ${subtitle ? `<div class="chat-search-media-desc">${esc(subtitle)}</div>` : ''}
        <div class="chat-search-media-meta">
          <span>来自${esc(chatSearchMediaFromLabel(item, state.selected))}</span>
          <span class="chat-search-media-time">${esc(chatSearchMediaTimeLabel(item.createTime))}</span>
        </div>
      </div>
    </div>`;
}

function chatSearchLocationListItemHtml(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const poiName = cleanCardText(extra.poiname);
  const label = cleanCardText(extra.label) || cleanCardText(extra.address);
  const title = poiName || label
    || String(item.content || '').replace(/^\[位置\]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
    || '位置';
  const subtitle = poiName && label && label !== poiName ? label : '';
  return `
    <div class="chat-search-media-item" data-chat-search-message-id="${item.id}">
      <div class="chat-search-media-thumb chat-search-media-thumb--location">${chatSearchMediaThumbPlaceholder('location')}</div>
      <div class="chat-search-media-main">
        <div class="chat-search-media-title">${esc(title)}</div>
        ${subtitle ? `<div class="chat-search-media-desc">${esc(subtitle)}</div>` : ''}
        <div class="chat-search-media-meta">
          <span>来自${esc(chatSearchMediaFromLabel(item, state.selected))}</span>
          <span class="chat-search-media-time">${esc(chatSearchMediaTimeLabel(item.createTime))}</span>
        </div>
      </div>
    </div>`;
}

function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${Math.round(value)}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(2)}${units[index]}`;
}

function chatSearchFileExtension(extra, title) {
  const explicit = cleanCardText(extra.fileExt).toLowerCase().replace(/^\./, '');
  if (explicit) return explicit;
  const match = String(title || '').match(/\.([a-zA-Z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : '';
}

function chatSearchFileIconHtml(extension) {
  const audio = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'amr', 'wma', 'ape']);
  const ext = String(extension || '').toLowerCase();
  const kind = ext === 'pdf' ? 'pdf' : (audio.has(ext) ? 'audio' : 'generic');
  let glyph = '';
  if (kind === 'audio') {
    glyph = `<svg class="chat-search-file-glyph" viewBox="0 0 20 20" width="20" height="18" aria-hidden="true">
      <path d="M4 11v-2M7 7v8M10 9v4M13 5v12M16 8v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
    </svg>`;
  } else if (kind === 'pdf') {
    glyph = '<span class="chat-search-file-label">PDF</span>';
  } else {
    glyph = `<span class="chat-search-file-label">${esc((ext || 'FILE').slice(0, 4).toUpperCase())}</span>`;
  }
  return `<div class="chat-search-file-icon chat-search-file-icon--${kind}">
    <svg class="chat-search-file-shape" viewBox="0 0 44 54" preserveAspectRatio="none" aria-hidden="true">
      <path class="chat-search-file-shape-body" d="M6 2h23l9 9v41H6z"></path>
      <path class="chat-search-file-shape-fold" d="M29 2v9h9"></path>
    </svg>
    ${glyph}
  </div>`;
}

function chatSearchFileItemHtml(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const title = cleanCardText(extra.title)
    || cleanCardText(extra.fileName)
    || String(item.content || '').replace(/^\[文件\]\s*/, '').split('\n')[0].trim()
    || '文件';
  const extension = chatSearchFileExtension(extra, title);
  const size = formatFileSize(extra.fileSize);
  return `
    <div class="chat-search-file-item" data-chat-search-message-id="${item.id}">
      ${chatSearchFileIconHtml(extension)}
      <div class="chat-search-file-main">
        <div class="chat-search-file-title">${esc(title)}</div>
        ${size ? `<div class="chat-search-file-size">${esc(size)}</div>` : ''}
        <div class="chat-search-file-meta">
          <span>来自${esc(chatSearchMediaFromLabel(item, state.selected))}</span>
          <span class="chat-search-media-time">${esc(chatSearchMediaTimeLabel(item.createTime))}</span>
        </div>
      </div>
    </div>`;
}

function renderChatSearchFilesHtml(page) {
  const groups = [];
  let current = null;
  for (const item of page.items) {
    const meta = chatSearchMediaGroup(item.createTime);
    if (!current || current.key !== meta.key) {
      current = { ...meta, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  const groupsHtml = groups.map((group) => `
    <section class="chat-search-files-group">
      <div class="chat-search-media-group-title">${esc(group.label)}</div>
      ${group.items.map(chatSearchFileItemHtml).join('')}
    </section>`).join('');
  const loadingHtml = page.loading
    ? '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>'
    : '';
  const errorHtml = page.error
    ? `<div class="search-page-error">${esc(page.error)}</div>`
    : '';
  return `<div class="chat-search-files-list">${groupsHtml}${loadingHtml}${errorHtml}</div>`;
}

function renderChatSearchMediaMessagesHtml(page) {
  const groups = [];
  let current = null;
  for (const item of page.items) {
    const meta = chatSearchMediaGroup(item.createTime);
    if (!current || current.key !== meta.key) {
      current = { ...meta, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  const itemsFor = (item) => (page.category === 'link'
    ? chatSearchLinkListItemHtml(item)
    : chatSearchLocationListItemHtml(item));
  const groupsHtml = groups.map((group) => `
    <section class="chat-search-media-group">
      <div class="chat-search-media-group-title">${esc(group.label)}</div>
      ${group.items.map(itemsFor).join('')}
    </section>`).join('');
  const loadingHtml = page.loading
    ? '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>'
    : '';
  const errorHtml = page.error
    ? `<div class="search-page-error">${esc(page.error)}</div>`
    : '';
  return `<div class="chat-search-media-list">${groupsHtml}${loadingHtml}${errorHtml}</div>`;
}

function chatSearchChannelCoverPlaceholderHtml() {
  return '<div class="chat-search-channel-cover chat-search-channel-cover--empty"><span>▶</span></div>';
}

function chatSearchChannelCardHtml(item) {
  const extra = item.extra && typeof item.extra === 'object' ? item.extra : {};
  const finder = extra.finder && typeof extra.finder === 'object' ? extra.finder : {};
  const weapp = extra.weapp && typeof extra.weapp === 'object' ? extra.weapp : {};
  const author = cleanCardText(finder.nickname)
    || cleanCardText(extra.sourceDisplayName)
    || cleanCardText(weapp.appName)
    || '视频号';
  const title = channelsDisplayTitle(extra, finder, author)
    || cleanCardText(extra.des)
    || String(item.content || '').replace(/^\[(链接|视频号)\]\s*/, '').split('\n')[0].trim();
  const showTitle = Boolean(title && title !== author);
  const avatar = safeCardImageUrl(finder.avatar || extra.avatarUrl || extra.avatar || extra.iconurl || extra.iconUrl)
    || fallbackAvatar(author, finder.username || extra.sourceUsername || author || item.id);
  const finderCover = safeCardImageUrl(finder.thumbUrl || finder.coverUrl);
  const { src: fallbackSrc, fallback } = linkThumbnailInfo(item, extra);
  const src = finderCover || fallbackSrc;
  const coverHtml = src
    ? `<div class="chat-search-channel-cover"><img class="chat-search-channel-cover-img"
          src="${esc(src)}"${fallback ? ` data-fallback-src="${esc(fallback)}"` : ''}
          alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer"></div>`
    : chatSearchChannelCoverPlaceholderHtml();
  return `
    <div class="chat-search-channel-card" data-chat-search-message-id="${item.id}">
      ${coverHtml}
      ${showTitle ? `<div class="chat-search-channel-title">${esc(title)}</div>` : ''}
      <div class="chat-search-channel-meta">
        <span class="chat-search-channel-avatar" style="background-image:url('${esc(avatar)}')"></span>
        <span class="chat-search-channel-name">${esc(author)}</span>
      </div>
    </div>`;
}

function renderChatSearchChannelsHtml(page) {
  const groups = [];
  let current = null;
  for (const item of page.items) {
    const meta = chatSearchMediaGroup(item.createTime);
    if (!current || current.key !== meta.key) {
      current = { ...meta, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  const groupsHtml = groups.map((group) => {
    const columns = [[], []];
    group.items.forEach((item, index) => {
      columns[index % 2].push(chatSearchChannelCardHtml(item));
    });
    return `
      <section class="chat-search-channels-group">
        <div class="chat-search-media-group-title">${esc(group.label)}</div>
        <div class="chat-search-channels-grid">
          <div class="chat-search-channels-column">${columns[0].join('')}</div>
          <div class="chat-search-channels-column">${columns[1].join('')}</div>
        </div>
      </section>`;
  }).join('');
  const loadingHtml = page.loading
    ? '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>'
    : '';
  const errorHtml = page.error
    ? `<div class="search-page-error">${esc(page.error)}</div>`
    : '';
  return `<div class="chat-search-channels-list">${groupsHtml}${loadingHtml}${errorHtml}</div>`;
}

function chatSearchDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function chatSearchDateTitle(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function chatSearchMonthLabel(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  return `${year}年${month}月`;
}

/** 生成 [最早月份, 最晚月份] 之间的连续月份键,按从旧到新排列 */
function chatSearchMonthKeys(earliestMonth, latestMonth) {
  const [startYear, startMonth] = String(earliestMonth).split('-').map(Number);
  const [endYear, endMonth] = String(latestMonth).split('-').map(Number);
  if (!startYear || !startMonth || !endYear || !endMonth) return [];
  const keys = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${pad(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

function chatSearchDateRange(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return null;
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000) - 1,
  };
}

/** 本地时区的一个自然月 [月初, 下月初) */
function chatSearchMonthRange(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  if (!year || !month) return null;
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000) - 1,
  };
}

function chatSearchPageModeKey(page) {
  const member = page.selectedMember && page.selectedMember.username
    ? page.selectedMember.username
    : '';
  return `${page.query || ''}\u0000${page.category || ''}\u0000${page.selectedDate || ''}\u0000${member}`;
}

function renderChatSearchQuickPage(content, body) {
  const categories = state.selected && state.selected.isChatroom
    ? [{ id: 'members', label: '群成员' }, ...CHAT_SEARCH_CATEGORIES]
    : CHAT_SEARCH_CATEGORIES;
  const buttons = categories.map((item) => (
    `<button class="chat-search-quick-btn" type="button" data-chat-search-category="${item.id}">${esc(item.label)}</button>`
  )).join('');
  content.innerHTML = `
    <div class="chat-search-quick">
      <div class="chat-search-quick-title">快速搜索聊天内容</div>
      <div class="chat-search-quick-grid">${buttons}</div>
    </div>`;
  content.querySelectorAll('[data-chat-search-category]').forEach((btn) => {
    btn.addEventListener('click', () => openChatSearchCategory(btn.dataset.chatSearchCategory));
  });
  if (body) body.scrollTop = 0;
}

function chatSearchBrowseHeaderHtml(page) {
  const title = page.category === 'members' && page.selectedMember
    ? page.selectedMember.name
    : (page.selectedDate
      ? chatSearchDateTitle(page.selectedDate)
      : (page.categoryLabel || ''));
  const backLabel = page.category === 'members' && page.selectedMember
    ? '返回群成员'
    : (page.selectedDate ? '返回日历' : '返回快速搜索');
  let count = '';
  if (page.category === 'members' && !page.selectedMember && page.groupMembersTotal > 0) {
    count = `<span class="chat-search-browse-count">共 ${formatStatNumber(page.groupMembersTotal)} 人</span>`;
  } else if (page.total > 0) {
    count = `<span class="chat-search-browse-count">共 ${formatStatNumber(page.total)} 条</span>`;
  }
  return `
    <div class="chat-search-browse-head">
      <button class="chat-search-browse-back" type="button" data-chat-search-browse-back aria-label="${backLabel}">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
      </button>
      <div class="chat-search-browse-title">${esc(title)}</div>
      ${count}
    </div>`;
}

function renderChatSearchCalendarMonthHtml(monthKey, page) {
  const [year, month] = monthKey.split('-').map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayKey = chatSearchDateKey(new Date());
  const counts = page.dateCounts || new Map();
  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) {
    cells.push('<div class="chat-search-calendar-cell"></div>');
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${pad(month)}-${pad(day)}`;
    const count = counts.get(dateKey) || 0;
    const enabled = count > 0;
    const todayClass = dateKey === todayKey ? ' chat-search-calendar-day--today' : '';
    const aria = enabled
      ? `${chatSearchDateTitle(dateKey)}，${count} 条消息`
      : `${chatSearchDateTitle(dateKey)}，无消息`;
    cells.push(`
      <button class="chat-search-calendar-day${todayClass}" type="button"
              aria-label="${esc(aria)}" title="${esc(aria)}"
              ${enabled ? `data-chat-search-date="${dateKey}"` : 'disabled'}>
        <span>${day}</span>
        ${enabled ? '<span class="chat-search-calendar-dot" aria-hidden="true"></span>' : ''}
      </button>`);
  }

  return `
    <section class="chat-search-calendar-month">
      <div class="chat-search-calendar-month-title">${chatSearchMonthLabel(monthKey)}</div>
      <div class="chat-search-calendar-week">
        ${['日', '一', '二', '三', '四', '五', '六'].map((d) => `<span>${d}</span>`).join('')}
      </div>
      <div class="chat-search-calendar-grid">${cells.join('')}</div>
    </section>`;
}

function renderChatSearchCalendarHtml(page) {
  if (page.datesLoading) {
    return '<div class="empty-tip" style="padding-top:60px">正在加载日期...</div>';
  }
  if (page.datesError) {
    return `<div class="empty-tip" style="padding-top:60px">${esc(page.datesError)}</div>`;
  }
  if (!page.dates || page.dates.length === 0) {
    return '<div class="empty-tip" style="padding-top:60px">暂无聊天记录</div>';
  }

  const earliestMonth = (page.earliestDate || page.dates[0].date).slice(0, 7);
  const latestMonth = (page.latestDate || page.dates[page.dates.length - 1].date).slice(0, 7);
  const months = chatSearchMonthKeys(earliestMonth, latestMonth);
  return `
    <div class="chat-search-calendar chat-search-calendar--list">
      ${months.map((monthKey) => renderChatSearchCalendarMonthHtml(monthKey, page)).join('')}
    </div>`;
}

function renderChatSearchCategoryMessagesHtml(page) {
  if (page.items.length === 0) {
    const tip = page.loading
      ? '正在加载...'
      : (page.error || '暂无相关消息');
    return `<div class="empty-tip" style="padding-top:60px">${esc(tip)}</div>`;
  }
  if (page.category === 'link' || page.category === 'location') {
    return renderChatSearchMediaMessagesHtml(page);
  }
  if (page.category === 'file') {
    return renderChatSearchFilesHtml(page);
  }
  if (page.category === 'channels') {
    return renderChatSearchChannelsHtml(page);
  }
  const timeFor = (item) => (page.category === 'date'
    ? formatClockTime(item.createTime)
    : formatListTime(item.createTime));
  const itemsHtml = page.items.map((item) => chatSearchBrowseItemHtml(item, timeFor(item))).join('');
  const loadingHtml = page.loading
    ? '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>'
    : '';
  const errorHtml = page.error
    ? `<div class="search-page-error">${esc(page.error)}</div>`
    : '';
  return `<div class="chat-search-browse-list">${itemsHtml}${loadingHtml}${errorHtml}</div>`;
}

/** 按本地月份把图片/视频消息分组(升序,供整月插入与吸顶标题使用) */
function chatSearchGalleryItemsByMonth(items) {
  const groups = [];
  let current = null;
  for (const item of Array.isArray(items) ? items : []) {
    const time = Number(item.createTime) || 0;
    if (!time) continue;
    const date = new Date(time * 1000);
    if (!Number.isFinite(date.getTime())) continue;
    const month = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    if (!current || current.month !== month) {
      current = { month, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

function chatSearchGalleryTilesHtml(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const src = item.mediaPath ? mediaUrl(item.mediaPath) : '';
    if (!src) {
      return `<div class="chat-search-media-tile chat-search-media-tile--empty" data-chat-search-message-id="${item.id}"><span>${item.mediaKind === 'video' ? '视频' : '图片'}</span></div>`;
    }
    if (item.mediaKind === 'video') {
      return `<button class="chat-search-media-tile chat-search-media-tile--video" type="button"
              data-chat-search-video="${esc(src)}" data-chat-search-message-id="${item.id}" aria-label="播放视频">
        <span class="chat-search-media-play" aria-hidden="true">▶</span>
      </button>`;
    }
    return `<button class="chat-search-media-tile" type="button" data-chat-search-image="${esc(src)}" data-chat-search-message-id="${item.id}" aria-label="查看图片">
      <img src="${esc(src)}" alt="图片" loading="lazy" />
    </button>`;
  }).join('');
}

function chatSearchGalleryMonthHtml(group) {
  const items = (group && group.items ? group.items : []).filter(
    (item) => item.mediaKind === 'image' || item.mediaKind === 'video'
  );
  if (items.length === 0) return '';
  const tiles = chatSearchGalleryTilesHtml(items);
  return `<section class="chat-search-media-month" data-chat-search-month="${esc(group.month)}">
    <div class="chat-search-media-month-title">${esc(chatSearchMonthLabel(group.month))}</div>
    <div class="chat-search-media-grid">${tiles}</div>
  </section>`;
}

/** 给一个图片月份(或整页)绑定图片/视频点击和图片加载失败回退 */
function bindChatSearchGalleryTiles(root) {
  if (!root) return;
  root.querySelectorAll('[data-chat-search-image]').forEach((el) => {
    el.addEventListener('click', () => openImageViewer(el.dataset.chatSearchImage));
  });
  root.querySelectorAll('[data-chat-search-video]').forEach((el) => {
    el.addEventListener('click', () => openVideoViewer(el.dataset.chatSearchVideo));
  });
  root.querySelectorAll('.chat-search-media-tile img').forEach((img) => {
    img.addEventListener('error', () => {
      const tile = img.closest('.chat-search-media-tile');
      if (!tile) return;
      tile.classList.add('chat-search-media-tile--empty');
      tile.removeAttribute('data-chat-search-image');
      if ('disabled' in tile) tile.disabled = true;
      tile.innerHTML = '<span>图片</span>';
    });
  });
}

/** 只向月份列表头部插入一个新月份,保留已有图片 DOM,避免整页图片重建闪动 */
function prependChatSearchGalleryMonth(group) {
  const content = $('#chatSearchPageContent');
  const list = content ? content.querySelector('.chat-search-media-month-list') : null;
  if (!list) return false;
  const html = chatSearchGalleryMonthHtml(group);
  if (!html) return false;
  list.insertAdjacentHTML('afterbegin', html);
  const section = list.firstElementChild;
  if (section) bindChatSearchGalleryTiles(section);
  return true;
}

function renderChatSearchGalleryHtml(page) {
  let groups = Array.isArray(page.galleryGroups) ? page.galleryGroups : [];
  if (groups.length === 0 && Array.isArray(page.items) && page.items.length > 0) {
    // 兼容旧状态/回退:没有预分组时按本地月份自行分组。
    groups = chatSearchGalleryItemsByMonth(page.items);
  }
  const groupsHtml = groups.map(chatSearchGalleryMonthHtml).join('');

  if (!groupsHtml) {
    const tip = page.loading
      ? '正在加载...'
      : (page.error || '暂无图片或视频');
    return `<div class="empty-tip" style="padding-top:60px">${esc(tip)}</div>`;
  }

  // 图片/视频从最新月份开始,更早的内容整月插入顶部。
  // 加载提示作为列表第一行参与布局,和消息列表加载更早消息的视觉层级一致。
  const loadingRow = `<div id="chatSearchGalleryLoading" class="chat-search-gallery-loading-row${page.loading ? '' : ' hidden'}" role="status" aria-live="polite">
    <div class="loading-indicator"><span class="spinner"></span><span>正在加载更早的图片...</span></div>
  </div>`;
  const errorHtml = page.error ? `<div class="search-page-error">${esc(page.error)}</div>` : '';
  return `${loadingRow}${errorHtml}<div class="chat-search-media-month-list">${groupsHtml}</div>`;
}

function chatSearchMemberItemHtml(member) {
  const avatar = avatarUrl({
    avatar: member.avatar || '',
    nickname: member.name || member.username,
    hash: member.hash || member.username,
  });
  return `
    <div class="contact-item chat-search-member-item"
         data-chat-search-member="${esc(member.username)}"
         data-chat-search-member-name="${esc(member.name)}">
      <div class="contact-avatar" style="background-image:url('${avatar}')"></div>
      <div class="contact-info">
        <div class="contact-name-row">
          <div class="contact-name">${esc(member.name)}</div>
        </div>
      </div>
    </div>`;
}

function renderChatSearchGroupMembersHtml(page) {
  if (page.groupMembersLoading) {
    return '<div class="empty-tip" style="padding-top:60px">正在加载群成员...</div>';
  }
  if (page.groupMembersError) {
    return `<div class="empty-tip" style="padding-top:60px">${esc(page.groupMembersError)}</div>`;
  }
  if (!page.groupMembers || page.groupMembers.length === 0) {
    return '<div class="empty-tip" style="padding-top:60px">暂无群成员</div>';
  }
  const groupsHtml = page.groupMembers.map((group) => `
    <div class="contact-group">
      <div class="contact-group-header">${esc(group.letter)}</div>
      ${group.members.map(chatSearchMemberItemHtml).join('')}
    </div>`).join('');
  return `<div class="chat-search-member-groups">${groupsHtml}</div>`;
}

async function loadChatSearchGroupMembers() {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page || page.category !== 'members') return;
  const requestId = page.groupMembersRequestId + 1;
  page.groupMembersRequestId = requestId;
  page.groupMembersLoading = true;
  page.groupMembersError = '';
  try {
    const data = await api(`/api/contacts/${page.contactId}/members`);
    if (requestId !== page.groupMembersRequestId
      || page !== state.chatSearchPage
      || !state.chatSearchPageOpen
      || page.category !== 'members') return;
    page.groupMembers = Array.isArray(data.groups) ? data.groups : [];
    page.groupMembersTotal = Number(data.total) || 0;
    page.groupMembersLoading = false;
    renderChatSearchPage();
  } catch (err) {
    if (requestId === page.groupMembersRequestId
      && page === state.chatSearchPage
      && state.chatSearchPageOpen
      && page.category === 'members') {
      page.groupMembersLoading = false;
      page.groupMembersError = err.message || '群成员加载失败';
      renderChatSearchPage();
    }
  }
}

function openChatSearchMember(username, name) {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page || page.category !== 'members' || !username) return;
  clearTimeout(chatSearchPageTimer);
  state.chatSearchPageRequestId += 1;
  page.selectedMember = { username, name };
  page.items = [];
  page.total = 0;
  page.page = 0;
  page.hasMore = true;
  page.loading = false;
  page.error = '';
  const body = $('#chatSearchPageBody');
  page.memberListScrollTop = body ? body.scrollTop : 0;
  if (body) body.scrollTop = 0;
  pushChatSearchHistoryLevel(2);
  loadChatSearchPage(true);
}

function renderChatSearchBrowsePage(content, page) {
  let bodyHtml;
  if (page.category === 'date') {
    bodyHtml = page.selectedDate
      ? renderChatSearchCategoryMessagesHtml(page)
      : renderChatSearchCalendarHtml(page);
  } else if (page.category === 'image_video') {
    bodyHtml = renderChatSearchGalleryHtml(page);
  } else if (page.category === 'members' && !page.selectedMember) {
    bodyHtml = renderChatSearchGroupMembersHtml(page);
  } else {
    bodyHtml = renderChatSearchCategoryMessagesHtml(page);
  }
  // 分类页顶部导航移出滚动容器,只让内容滚动;避免 iOS 下拉回弹时导航跟着移动。
  const header = $('#chatSearchBrowseHeader');
  if (header) {
    header.innerHTML = chatSearchBrowseHeaderHtml(page);
    const backBtn = header.querySelector('[data-chat-search-browse-back]');
    if (backBtn) backBtn.addEventListener('click', handleChatSearchBrowseBack);
  }
  content.innerHTML = bodyHtml;

  if (page.category === 'image_video') {
    bindChatSearchGalleryTiles(content);
  }
  content.querySelectorAll('[data-chat-search-member]').forEach((el) => {
    el.addEventListener('click', () => {
      openChatSearchMember(
        el.dataset.chatSearchMember,
        el.dataset.chatSearchMemberName || el.dataset.chatSearchMember
      );
    });
  });
  content.querySelectorAll('.chat-search-media-thumb-img').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = img.getAttribute('data-fallback-src');
      if (fallback) {
        img.removeAttribute('data-fallback-src');
        img.src = fallback;
        return;
      }
      const thumb = img.closest('.chat-search-media-thumb');
      if (!thumb) {
        img.remove();
        return;
      }
      thumb.classList.add('chat-search-media-thumb--empty');
      thumb.innerHTML = chatSearchMediaThumbPlaceholder('link');
    });
  });
  content.querySelectorAll('.chat-search-channel-cover-img').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = img.getAttribute('data-fallback-src');
      if (fallback) {
        img.removeAttribute('data-fallback-src');
        img.src = fallback;
        return;
      }
      const cover = img.closest('.chat-search-channel-cover');
      if (cover) cover.outerHTML = chatSearchChannelCoverPlaceholderHtml();
    });
  });

  content.querySelectorAll('[data-chat-search-date]').forEach((el) => {
    el.addEventListener('click', () => {
      const current = state.chatSearchPage;
      if (!current || current.category !== 'date' || current.selectedDate) return;
      const dateKey = el.dataset.chatSearchDate;
      if (!dateKey) return;
      openChatDateWindow(dateKey);
    });
  });
}

/**
 * 进入日期消息页前保存原消息列表。日期页与原消息页使用两套 messages 状态,
 * 返回聊天页时恢复原列表、分页游标和视觉位置。
 */
function saveMessagePageSnapshot() {
  const contact = state.selected;
  if (!contact) return;
  if (savedMessagePageState && savedMessagePageState.contactId !== contact.id) {
    savedMessagePageState = null;
  }
  if (savedMessagePageState) return;

  const area = $('#messageArea');
  let firstVisibleId = null;
  let firstVisibleOffset = 0;
  if (area && state.messages.length > 0) {
    const areaTop = area.getBoundingClientRect().top;
    const rows = area.querySelectorAll('#messageList .msg-row');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > areaTop + 1) {
        const id = Number(row.dataset.messageId);
        if (Number.isFinite(id) && id > 0) {
          firstVisibleId = id;
          firstVisibleOffset = rect.top - areaTop;
        }
        break;
      }
    }
  }

  savedMessagePageState = {
    contactId: contact.id,
    chatSearch: state.chatSearch,
    chatSearchFilterTotal: state.chatSearchFilterTotal,
    selectedMessageId: state.selectedMessageId,
    pendingMessageFocusId: state.pendingMessageFocusId,
    messages: state.messages.slice(),
    messagePage: state.messagePage,
    messageHasMore: state.messageHasMore,
    messageHasNewer: state.messageHasNewer,
    messageDateMode: state.messageDateMode,
    messageOlderCursor: state.messageOlderCursor,
    messageNewerCursor: state.messageNewerCursor,
    messageAnchorId: state.messageAnchorId,
    messagesLoadArmed: state.messagesLoadArmed,
    messagesNewerArmed: state.messagesNewerArmed,
    messagesLastScrollTop: state.messagesLastScrollTop,
    scrollTop: area ? area.scrollTop : 0,
    firstVisibleId,
    firstVisibleOffset,
  };
}

/** 恢复进入日期页前的消息列表和位置;联系人已切换时直接丢弃 */
function restoreMessagePageSnapshot() {
  const snapshot = savedMessagePageState;
  savedMessagePageState = null;
  if (!snapshot) return false;
  const contact = state.selected;
  if (!contact || snapshot.contactId !== contact.id) return false;

  // 使日期窗口页仍在途的请求失效
  state.messagesRequestId += 1;
  state.messagesLoading = false;
  state.messagesLoadingNewer = false;
  state.messagesRestoringScroll = false;
  state.chatSearch = snapshot.chatSearch;
  state.chatSearchFilterTotal = snapshot.chatSearchFilterTotal;
  state.selectedMessageId = snapshot.selectedMessageId;
  state.pendingMessageFocusId = snapshot.pendingMessageFocusId;
  state.messages = snapshot.messages.slice();
  state.messagePage = snapshot.messagePage;
  state.messageHasMore = snapshot.messageHasMore;
  state.messageHasNewer = snapshot.messageHasNewer;
  state.messageDateMode = snapshot.messageDateMode;
  state.messageOlderCursor = snapshot.messageOlderCursor;
  state.messageNewerCursor = snapshot.messageNewerCursor;
  state.messageAnchorId = snapshot.messageAnchorId;
  state.messagesLoadArmed = snapshot.messagesLoadArmed;
  state.messagesOlderLoadLocked = false;
  state.messagesNewerArmed = snapshot.messagesNewerArmed;
  state.messagesLastScrollTop = snapshot.messagesLastScrollTop;
  updateChatSearchFilterBar();
  updateMessageLoading();
  renderMessages();

  const area = $('#messageArea');
  if (!area) return true;
  const applyPosition = () => {
    if (state.selected !== contact || state.dateJumpOpen || state.chatSearchPageOpen) return;
    let row = null;
    if (snapshot.firstVisibleId !== null) {
      row = area.querySelector(
        `#messageList .msg-row[data-message-id="${snapshot.firstVisibleId}"]`
      );
    }
    if (row) {
      const offset = row.getBoundingClientRect().top - area.getBoundingClientRect().top;
      area.scrollTop += offset - snapshot.firstVisibleOffset;
      setMessagesLayoutAnchor(row);
      ensureMessagesLayoutObserver();
    } else {
      area.scrollTop = snapshot.scrollTop;
    }
  };
  applyPosition();
  requestAnimationFrame(() => requestAnimationFrame(applyPosition));
  return true;
}

/** 引用跳转前保存当前消息列表、游标和视觉位置 */
function captureQuoteReturnState() {
  const contact = state.selected;
  if (!contact) return null;
  const area = $('#messageArea');
  let firstVisibleId = null;
  let firstVisibleOffset = 0;
  if (area && state.messages.length > 0) {
    const areaTop = area.getBoundingClientRect().top;
    const rows = area.querySelectorAll('#messageList .msg-row');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > areaTop + 1) {
        const id = Number(row.dataset.messageId);
        if (Number.isFinite(id) && id > 0) {
          firstVisibleId = id;
          firstVisibleOffset = rect.top - areaTop;
        }
        break;
      }
    }
  }
  return {
    contactId: contact.id,
    chatSearch: state.chatSearch,
    chatSearchFilterTotal: state.chatSearchFilterTotal,
    selectedMessageId: state.selectedMessageId,
    pendingMessageFocusId: state.pendingMessageFocusId,
    messages: state.messages.slice(),
    messagePage: state.messagePage,
    messageHasMore: state.messageHasMore,
    messageHasNewer: state.messageHasNewer,
    messageDateMode: state.messageDateMode,
    messageOlderCursor: state.messageOlderCursor,
    messageNewerCursor: state.messageNewerCursor,
    messageAnchorId: state.messageAnchorId,
    messagesLoadArmed: state.messagesLoadArmed,
    messagesNewerArmed: state.messagesNewerArmed,
    messagesLastScrollTop: state.messagesLastScrollTop,
    scrollTop: area ? area.scrollTop : 0,
    firstVisibleId,
    firstVisibleOffset,
  };
}

function captureQuoteViewportAnchor() {
  const contact = state.selected;
  if (!contact) return null;
  const area = $('#messageArea');
  let firstVisibleId = null;
  let firstVisibleOffset = 0;
  if (area && state.messages.length > 0) {
    const areaTop = area.getBoundingClientRect().top;
    const rows = area.querySelectorAll('#messageList .msg-row');
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > areaTop + 1) {
        const id = Number(row.dataset.messageId);
        if (Number.isFinite(id) && id > 0) {
          firstVisibleId = id;
          firstVisibleOffset = rect.top - areaTop;
        }
        break;
      }
    }
  }
  return {
    contactId: contact.id,
    scrollTop: area ? area.scrollTop : 0,
    firstVisibleId,
    firstVisibleOffset,
    armedAt: Date.now() + 150,
  };
}

function quoteAnchorRow(area, anchor) {
  if (!area || !anchor || anchor.firstVisibleId === null) return null;
  return area.querySelector(
    `#messageList .msg-row[data-message-id="${anchor.firstVisibleId}"]`
  );
}

function isAtQuoteViewportAnchor(anchor) {
  const area = $('#messageArea');
  if (!area || !anchor || state.selected?.id !== anchor.contactId) return false;
  if (Math.abs(area.scrollTop - anchor.scrollTop) <= 28) return true;
  const row = quoteAnchorRow(area, anchor);
  if (!row) return false;
  const offset = row.getBoundingClientRect().top - area.getBoundingClientRect().top;
  return Math.abs(offset - anchor.firstVisibleOffset) <= 28;
}

function maybeHideQuoteLoadedReturnButton() {
  const anchor = quoteLoadedReturnAnchor;
  if (!anchor || quoteJumpReturnState) return;
  if (Date.now() < anchor.armedAt) return;
  if (!isAtQuoteViewportAnchor(anchor)) return;
  quoteLoadedReturnAnchor = null;
  hideQuoteReturnButton();
}

function scrollToQuoteViewportAnchor(anchor) {
  const area = $('#messageArea');
  if (!area || !anchor) return;
  const row = quoteAnchorRow(area, anchor);
  if (row) {
    const offset = row.getBoundingClientRect().top - area.getBoundingClientRect().top;
    area.scrollTop += offset - anchor.firstVisibleOffset;
  } else {
    area.scrollTop = anchor.scrollTop;
  }
}

function showQuoteReturnButton() {
  const btn = $('#quoteReturnBtn');
  if (btn) btn.classList.remove('hidden');
}

function hideQuoteReturnButton() {
  const btn = $('#quoteReturnBtn');
  if (btn) btn.classList.add('hidden');
}

function clearQuoteJumpReturnState() {
  quoteJumpReturnState = null;
  quoteLoadedReturnAnchor = null;
  hideQuoteReturnButton();
}

function handleQuoteReturnClick() {
  if (quoteJumpReturnState) {
    restoreQuoteJumpReturnState();
    return;
  }
  const anchor = quoteLoadedReturnAnchor;
  if (!anchor) return;
  quoteLoadedReturnAnchor = null;
  hideQuoteReturnButton();
  scrollToQuoteViewportAnchor(anchor);
}

/** 回到引用跳转前的消息列表和滚动位置 */
function restoreQuoteJumpReturnState() {
  const snapshot = quoteJumpReturnState;
  quoteJumpReturnState = null;
  quoteLoadedReturnAnchor = null;
  hideQuoteReturnButton();
  if (!snapshot) return false;
  const contact = state.selected;
  if (!contact || snapshot.contactId !== contact.id) return false;

  state.messagesRequestId += 1;
  state.messagesLoading = false;
  state.messagesLoadingNewer = false;
  state.messagesRestoringScroll = false;
  state.chatSearch = snapshot.chatSearch;
  state.chatSearchFilterTotal = snapshot.chatSearchFilterTotal;
  state.selectedMessageId = snapshot.selectedMessageId;
  state.pendingMessageFocusId = snapshot.pendingMessageFocusId;
  state.messages = snapshot.messages.slice();
  state.messagePage = snapshot.messagePage;
  state.messageHasMore = snapshot.messageHasMore;
  state.messageHasNewer = snapshot.messageHasNewer;
  state.messageDateMode = snapshot.messageDateMode;
  state.messageOlderCursor = snapshot.messageOlderCursor;
  state.messageNewerCursor = snapshot.messageNewerCursor;
  state.messageAnchorId = snapshot.messageAnchorId;
  state.messagesLoadArmed = snapshot.messagesLoadArmed;
  state.messagesOlderLoadLocked = false;
  state.messagesNewerArmed = snapshot.messagesNewerArmed;
  state.messagesLastScrollTop = snapshot.messagesLastScrollTop;
  updateChatSearchFilterBar();
  updateMessageLoading();
  renderMessages();

  const area = $('#messageArea');
  if (!area) return true;
  const applyPosition = () => {
    if (state.selected !== contact) return;
    let row = null;
    if (snapshot.firstVisibleId !== null) {
      row = area.querySelector(
        `#messageList .msg-row[data-message-id="${snapshot.firstVisibleId}"]`
      );
    }
    if (row) {
      const offset = row.getBoundingClientRect().top - area.getBoundingClientRect().top;
      area.scrollTop += offset - snapshot.firstVisibleOffset;
      setMessagesLayoutAnchor(row);
      ensureMessagesLayoutObserver();
    } else {
      area.scrollTop = snapshot.scrollTop;
    }
  };
  applyPosition();
  requestAnimationFrame(() => requestAnimationFrame(applyPosition));
  return true;
}

/** 解析引用目标;已加载则直接定位,未加载则替换为前后 100 条窗口 */
async function locateQuotedMessage(messageId) {
  const contact = state.selected;
  const id = Number(messageId);
  if (!contact || !Number.isInteger(id) || id <= 0) return;
  try {
    const target = await api(`/api/messages/${id}/quote-target`);
    const targetId = Number(target && target.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      toast('未找到引用的原文', true);
      return;
    }
    if (state.selected !== contact) return;
    if (state.messages.some((message) => Number(message.id) === targetId)) {
      const anchor = !quoteJumpReturnState && !quoteLoadedReturnAnchor
        ? captureQuoteViewportAnchor()
        : null;
      state.pendingMessageFocusId = targetId;
      if (!focusPendingMessage()) {
        toast('未在当前列表中找到原文', true);
        return;
      }
      if (anchor) {
        quoteLoadedReturnAnchor = anchor;
        showQuoteReturnButton();
      }
      return;
    }
    if (quoteJumpReturnState) {
      toast('请先回到引用位置', true);
      return;
    }
    const snapshot = captureQuoteReturnState();
    if (!snapshot) return;
    quoteLoadedReturnAnchor = null;
    quoteJumpReturnState = snapshot;
    const ok = await loadDateWindow('', targetId, { fallback: false });
    const loaded = ok && state.messages.some((message) => Number(message.id) === targetId);
    if (!loaded) {
      restoreQuoteJumpReturnState();
      toast('加载引用的原文失败', true);
      return;
    }
    showQuoteReturnButton();
  } catch (err) {
    toast(err && err.message ? err.message : '未找到引用的原文', true);
  }
}

/** 点击日期:退出聊天内搜索,进入普通消息列表并定位到该日最早消息 */
function openChatDateWindow(dateKey) {
  const page = state.chatSearchPage;
  const contact = state.selected;
  if (!page || !contact || page.contactId !== contact.id) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return;
  clearQuoteJumpReturnState();
  clearTimeout(chatSearchPageTimer);
  saveMessagePageSnapshot();
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  updateChatSearchFilterBar();
  state.messageJumpSource = 'date';
  state.dateJumpOpen = true;
  const view = $('#chatSearchPageView');
  if (view) view.classList.add('hidden');
  pushDateJumpHistoryLevel();
  updateMobileChrome();
  loadDateWindow(dateKey);
}

/** 长按分类结果:进入独立消息页并定位到指定消息 */
function openChatMessageWindow(messageId) {
  const page = state.chatSearchPage;
  const contact = state.selected;
  const id = Number(messageId);
  if (!page || !contact || page.contactId !== contact.id) return;
  if (!Number.isInteger(id) || id <= 0) return;
  clearQuoteJumpReturnState();
  clearTimeout(chatSearchPageTimer);
  saveMessagePageSnapshot();
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  updateChatSearchFilterBar();
  state.messageJumpSource = 'category';
  state.dateJumpOpen = true;
  const view = $('#chatSearchPageView');
  if (view) view.classList.add('hidden');
  pushDateJumpHistoryLevel();
  updateMobileChrome();
  loadDateWindow('', id);
}

function openChatSearchCategory(categoryId) {
  const page = state.chatSearchPage;
  const meta = categoryId === 'members'
    ? { id: 'members', label: '群成员' }
    : CHAT_SEARCH_CATEGORIES.find((item) => item.id === categoryId);
  if (!state.chatSearchPageOpen || !page || !meta) return;
  if (categoryId === 'members' && (!state.selected || !state.selected.isChatroom)) return;
  clearTimeout(chatSearchPageTimer);
  state.chatSearchPageRequestId += 1;
  page.datesRequestId += 1;
  page.groupMembersRequestId += 1;
  page.query = '';
  page.category = categoryId;
  page.categoryLabel = meta.label;
  page.selectedDate = '';
  page.selectedMember = null;
  page.items = [];
  page.total = 0;
  page.page = 0;
  page.hasMore = false;
  page.loading = false;
  page.error = '';
  page.groupMembersLoading = false;
  page.groupMembersError = '';
  page.galleryScrollToBottom = categoryId === 'image_video';
  page.galleryLoadArmed = true;
  page.galleryAnchor = null;
  page.galleryScrollLocked = false;
  page.galleryProgrammaticScrollUntil = 0;
  page.galleryMonths = null;
  page.galleryGroups = [];
  page.galleryNextMonthIndex = -1;
  clearTimeout(page.galleryAutoFillTimer);
  page.galleryAutoFillTimer = null;
  setChatSearchGalleryLoading(false);
  page.scrollPointerActive = false;
  page.lastScrollAt = 0;
  page.wheelUntil = 0;
  const input = $('#chatSearchPageInput');
  if (input) {
    input.value = '';
    input.blur();
  }
  updateChatSearchPageClear();
  const body = $('#chatSearchPageBody');
  markChatSearchProgrammaticScroll(page);
  if (body) body.scrollTop = 0;
  pushChatSearchHistoryLevel(1);

  if (categoryId === 'date') {
    page.calendarScrollTop = null;
    page.calendarScrollToBottom = true;
    if (!page.dates) {
      page.datesLoading = true;
      page.datesError = '';
      renderChatSearchPage();
      loadChatSearchDates();
    } else {
      page.datesLoading = false;
      page.datesError = '';
      renderChatSearchPage();
    }
    return;
  }

  if (categoryId === 'members') {
    if (!page.groupMembers) {
      page.groupMembersLoading = true;
      renderChatSearchPage();
      loadChatSearchGroupMembers();
    } else {
      renderChatSearchPage();
    }
    return;
  }

  loadChatSearchPage(true);
}

function revertChatSearchDetailLevel() {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page) return false;
  clearTimeout(chatSearchPageTimer);
  state.chatSearchPageRequestId += 1;
  page.datesRequestId += 1;
  page.groupMembersRequestId += 1;
  if (page.category === 'members' && page.selectedMember) {
    const returnScrollTop = page.memberListScrollTop || 0;
    page.selectedMember = null;
    page.items = [];
    page.total = 0;
    page.page = 0;
    page.hasMore = false;
    page.loading = false;
    page.error = '';
    const body = $('#chatSearchPageBody');
    if (body) body.scrollTop = 0;
    renderChatSearchPage();
    if (body) {
      body.scrollTop = returnScrollTop;
      requestAnimationFrame(() => {
        if (state.chatSearchPage === page
          && page.category === 'members'
          && !page.selectedMember) {
          body.scrollTop = returnScrollTop;
        }
      });
    }
    return true;
  }
  if (page.category === 'date' && page.selectedDate) {
    const returnScrollTop = page.calendarScrollTop || 0;
    page.selectedDate = '';
    page.calendarScrollToBottom = false;
    page.items = [];
    page.total = 0;
    page.page = 0;
    page.hasMore = false;
    page.loading = false;
    page.error = '';
    const body = $('#chatSearchPageBody');
    if (body) body.scrollTop = 0;
    renderChatSearchPage();
    if (body) {
      body.scrollTop = returnScrollTop;
      requestAnimationFrame(() => {
        if (state.chatSearchPage === page
          && state.chatSearchPageOpen
          && page.category === 'date'
          && !page.selectedDate) {
          body.scrollTop = returnScrollTop;
        }
      });
    }
    return true;
  }
  return false;
}

function revertChatSearchCategoryLevel() {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page || !page.category) return false;
  clearTimeout(chatSearchPageTimer);
  state.chatSearchPageRequestId += 1;
  page.datesRequestId += 1;
  page.groupMembersRequestId += 1;
  page.category = null;
  page.categoryLabel = '';
  page.selectedDate = '';
  page.selectedMember = null;
  page.items = [];
  page.total = 0;
  page.page = 0;
  page.hasMore = false;
  page.loading = false;
  page.error = '';
  const body = $('#chatSearchPageBody');
  if (body) body.scrollTop = 0;
  renderChatSearchPage();
  return true;
}

function handleChatSearchBrowseBack() {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page || !page.category) return;
  const atDetail = (page.category === 'members' && page.selectedMember)
    || (page.category === 'date' && page.selectedDate);
  if (atDetail) {
    if (isMobileSinglePane() && chatSearchHistoryDepth >= 3) {
      history.back();
      return;
    }
    revertChatSearchDetailLevel();
    return;
  }
  if (isMobileSinglePane() && chatSearchHistoryDepth >= 2) {
    history.back();
    return;
  }
  revertChatSearchCategoryLevel();
}

async function loadChatSearchDates() {
  const page = state.chatSearchPage;
  if (!state.chatSearchPageOpen || !page || page.category !== 'date') return;
  const requestId = page.datesRequestId + 1;
  page.datesRequestId = requestId;
  page.datesLoading = true;
  page.datesError = '';
  try {
    const offset = -new Date().getTimezoneOffset() * 60;
    const data = await api(`/api/contacts/${page.contactId}/message-dates?offset=${offset}`);
    if (requestId !== page.datesRequestId
      || page !== state.chatSearchPage
      || !state.chatSearchPageOpen
      || page.category !== 'date') return;
    const dates = Array.isArray(data.dates) ? data.dates : [];
    page.dates = dates;
    page.dateCounts = new Map(dates.map((item) => [item.date, Number(item.count) || 0]));
    page.datesTotal = Number(data.total) || 0;
    page.earliestDate = String(data.earliest || (dates[0] ? dates[0].date : ''));
    page.latestDate = String(data.latest || (dates.length ? dates[dates.length - 1].date : ''));
    page.datesLoading = false;
    renderChatSearchPage();
  } catch (err) {
    if (requestId === page.datesRequestId
      && page === state.chatSearchPage
      && state.chatSearchPageOpen
      && page.category === 'date') {
      page.datesLoading = false;
      page.datesError = err.message || '日期加载失败';
      renderChatSearchPage();
    }
  }
}

/**
 * 浏览器把脚本设置 scrollTop 产生的 scroll 事件同样标记为 isTrusted,
 * 仅靠 event.isTrusted 无法区分用户滚动和渲染后的位置校正。这里显式记录
 * 一段“程序化滚动窗口”，窗口内的 scroll 事件不得重新武装加载。
 */
function markChatSearchProgrammaticScroll(page) {
  if (!page) return;
  page.galleryProgrammaticScrollUntil = performance.now() + 250;
}

function renderChatSearchPage() {
  const content = $('#chatSearchPageContent');
  const body = $('#chatSearchPageBody');
  if (!content) return;
  hideChatSearchContextMenu();
  cancelChatSearchLongPress();
  const page = state.chatSearchPage;
  if (!page) return;
  setPagingBusy(Boolean(page.loading && page.items.length > 0));
  markChatSearchProgrammaticScroll(page);
  const pageView = $('#chatSearchPageView');
  if (pageView) {
    pageView.classList.toggle('chat-search-page--browse', Boolean(page.category));
  }
  const browseHeader = $('#chatSearchBrowseHeader');
  if (browseHeader) browseHeader.classList.toggle('hidden', !page.category);
  const scrollTop = body ? body.scrollTop : 0;

  if (page.category) {
    renderChatSearchBrowsePage(content, page);
    if (body) {
      if (page.category === 'image_video'
        && page.galleryScrollToBottom
        && !page.loading
        && page.items.length > 0) {
        // 图片/视频首次进入时定位到最底部(最新内容)
        page.galleryScrollToBottom = false;
        markChatSearchProgrammaticScroll(page);
        body.scrollTop = body.scrollHeight;
        requestAnimationFrame(() => {
          if (state.chatSearchPage === page
            && state.chatSearchPageOpen
            && page.category === 'image_video'
            && page.galleryScrollToBottom === false) {
            markChatSearchProgrammaticScroll(page);
            body.scrollTop = body.scrollHeight;
          }
        });
      } else if (page.category === 'date'
        && !page.selectedDate
        && page.calendarScrollToBottom
        && page.datesLoading === false
        && page.dates
        && page.dates.length > 0) {
        // 首次进入日期页时定位到最底部(最新日期)
        page.calendarScrollToBottom = false;
        body.scrollTop = body.scrollHeight;
        requestAnimationFrame(() => {
          if (state.chatSearchPage === page
            && state.chatSearchPageOpen
            && page.category === 'date'
            && !page.selectedDate) {
            body.scrollTop = body.scrollHeight;
          }
        });
      } else {
        markChatSearchProgrammaticScroll(page);
        body.scrollTop = scrollTop;
      }
    }
    return;
  }

  if (!page.query) {
    renderChatSearchQuickPage(content, body);
    return;
  }

  if (page.items.length === 0) {
    const tip = page.loading
      ? '正在搜索...'
      : (page.error || '没有匹配的消息');
    content.innerHTML = `<div class="empty-tip" style="padding-top:80px">${esc(tip)}</div>`;
    if (body) body.scrollTop = 0;
    return;
  }

  const itemsHtml = page.items.map((item, index) => chatSearchMessageItemHtml(item, index)).join('');
  const loadingHtml = page.loading
    ? '<div class="loading-indicator search-page-more-loading"><span class="spinner"></span><span>加载中...</span></div>'
    : '';
  const errorHtml = page.error
    ? `<div class="search-page-error">${esc(page.error)}</div>`
    : '';
  content.innerHTML = `
    <div class="search-page-title">共 ${formatStatNumber(page.total)} 条消息</div>
    ${itemsHtml}
    ${loadingHtml}
    ${errorHtml}`;

  content.querySelectorAll('[data-chat-search-index]').forEach((el) => {
    el.addEventListener('click', () => {
      const messageId = Number(el.dataset.chatSearchMessageId);
      if (Number.isInteger(messageId) && messageId > 0) openChatMessageWindow(messageId);
    });
  });
  if (body) body.scrollTop = scrollTop;
}

function isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey) {
  return requestId === state.chatSearchPageRequestId
    && state.chatSearchPage === page
    && state.chatSearchPageOpen
    && Boolean(state.selected)
    && state.selected.id === contactId
    && page.category === 'image_video'
    && chatSearchPageModeKey(page) === modeKey;
}

async function fetchChatSearchGalleryMonths(page, contactId, requestId, modeKey) {
  const offset = -new Date().getTimezoneOffset() * 60;
  const params = new URLSearchParams({
    category: 'image_video',
    offset: String(offset),
  });
  const data = await api(`/api/contacts/${contactId}/media-months?${params}`);
  if (!isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return null;
  const months = (Array.isArray(data.months) ? data.months : [])
    .map((row) => ({
      month: String(row && row.month ? row.month : ''),
      count: Number(row && row.count) || 0,
    }))
    .filter((row) => /^\d{4}-\d{2}$/.test(row.month) && row.count > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  const total = Number(data.total);
  return {
    months,
    total: Number.isFinite(total) ? total : months.reduce((sum, row) => sum + row.count, 0),
  };
}

/**
 * 一次性取完一个本地自然月的全部图片/视频。
 * 服务端单次最多 500 条,因此按页取完后按时间升序合并;每页返回升序,
 * 后一页比前一页更早,所以新页要插到已收集数组前面。
 */
async function fetchChatSearchGalleryMonthItems(page, contactId, monthKey, requestId, modeKey) {
  const range = chatSearchMonthRange(monthKey);
  if (!range) throw new Error('月份无效');
  let items = [];
  let pageNo = 1;
  while (pageNo <= 200) {
    const params = new URLSearchParams({
      category: 'image_video',
      from: String(range.from),
      to: String(range.to),
      page: String(pageNo),
      pageSize: String(CHAT_SEARCH_GALLERY_MONTH_PAGE_SIZE),
    });
    const data = await api(`/api/contacts/${contactId}/messages?${params}`);
    if (!isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return null;
    const rows = Array.isArray(data.items) ? data.items.slice() : [];
    items = rows.concat(items);
    if (!data.hasMore) break;
    pageNo += 1;
  }
  return items;
}

/** 当最新月份内容不足以撑满视口时,自动加载上一个整月,避免无法触发滚动加载 */
function scheduleChatSearchGalleryAutoFill(page) {
  if (!page || page.category !== 'image_video' || !page.hasMore
    || page.loading || page.error) return;
  clearTimeout(page.galleryAutoFillTimer);
  page.galleryAutoFillTimer = setTimeout(() => {
    page.galleryAutoFillTimer = null;
    if (state.chatSearchPage !== page
      || !state.chatSearchPageOpen
      || page.category !== 'image_video'
      || page.loading
      || page.galleryScrollLocked
      || !page.hasMore
      || page.error) return;
    const body = $('#chatSearchPageBody');
    const view = $('#chatSearchPageView');
    if (!body || !view || view.classList.contains('hidden') || body.clientHeight <= 0) return;
    if (body.scrollHeight > body.clientHeight + 1) return;
    if (isChatSearchScrollActive(page)) {
      scheduleChatSearchGalleryAutoFill(page);
      return;
    }
    loadChatSearchPage(false);
  }, 320);
}

async function loadChatSearchGalleryMonths(reset) {
  const page = state.chatSearchPage;
  if (!page || page.category !== 'image_video' || !state.chatSearchPageOpen) return;
  if (!reset && (page.loading || !page.hasMore)) return;

  const contactId = page.contactId;
  const modeKey = chatSearchPageModeKey(page);
  const requestId = state.chatSearchPageRequestId + 1;
  state.chatSearchPageRequestId = requestId;
  let prependedIncrementally = false;
  page.loading = true;
  page.error = '';
  clearTimeout(page.galleryAutoFillTimer);
  page.galleryAutoFillTimer = null;

  if (!reset) {
    setChatSearchGalleryLoading(true);
    page.galleryLoadArmed = false;
    page.galleryScrollLocked = true;
    page.galleryAnchor = null;
  }

  if (reset) {
    setChatSearchGalleryLoading(false);
    page.items = [];
    page.page = 0;
    page.total = 0;
    page.hasMore = true;
    page.galleryMonths = null;
    page.galleryGroups = [];
    page.galleryNextMonthIndex = -1;
    page.galleryScrollToBottom = true;
    page.galleryLoadArmed = true;
    page.galleryScrollLocked = false;
    const body = $('#chatSearchPageBody');
    markChatSearchProgrammaticScroll(page);
    if (body) body.scrollTop = 0;
    renderChatSearchPage();
  }

  try {
    if (reset) {
      const meta = await fetchChatSearchGalleryMonths(page, contactId, requestId, modeKey);
      if (!meta || !isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return;
      page.galleryMonths = meta.months;
      page.total = meta.total;
      if (meta.months.length === 0) {
        page.items = [];
        page.galleryGroups = [];
        page.galleryNextMonthIndex = -1;
        page.hasMore = false;
        page.page = 0;
        return;
      }

      const latest = meta.months[meta.months.length - 1];
      const items = await fetchChatSearchGalleryMonthItems(
        page, contactId, latest.month, requestId, modeKey
      );
      if (items === null || !isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return;
      page.galleryGroups = [{ month: latest.month, items }];
      page.galleryNextMonthIndex = meta.months.length - 2;
      page.items = items.slice();
      page.page = 1;
      page.hasMore = page.galleryNextMonthIndex >= 0;
      return;
    }

    const months = page.galleryMonths;
    const nextIndex = Number(page.galleryNextMonthIndex);
    if (!Array.isArray(months) || nextIndex < 0) {
      page.hasMore = false;
      return;
    }
    const month = months[nextIndex];
    const items = await fetchChatSearchGalleryMonthItems(
      page, contactId, month.month, requestId, modeKey
    );
    if (items === null || !isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return;

    // 整月插入前先等用户停止滚动,记录旧高度/视口位置,渲染后补偿 scrollTop。
    await waitForChatSearchScrollIdle(page);
    if (!isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) return;
    const body = $('#chatSearchPageBody');
    page.galleryAnchor = {
      top: body ? body.scrollTop : 0,
      height: body ? body.scrollHeight : 0,
    };
    page.galleryGroups.unshift({ month: month.month, items });
    page.galleryNextMonthIndex = nextIndex - 1;
    page.items = page.galleryGroups.flatMap((group) => group.items);
    page.page = page.galleryGroups.length;
    page.hasMore = page.galleryNextMonthIndex >= 0;
    // 只插入新月份节点,不重建已有月份/图片 DOM,避免每次加载后整页图片闪空。
    prependedIncrementally = prependChatSearchGalleryMonth({ month: month.month, items });
  } catch (err) {
    if (isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) {
      page.error = err.message || '搜索失败';
      page.hasMore = false;
      toast(page.error, true);
    }
  } finally {
    if (isChatSearchGalleryRequestValid(page, contactId, requestId, modeKey)) {
      page.loading = false;
      setChatSearchGalleryLoading(false);
      // 成功插入新月份时保留已有图片 DOM;只有错误/回退时才整页重绘。
      if (!prependedIncrementally) renderChatSearchPage();
      if (!reset && page.galleryAnchor) {
        const body = $('#chatSearchPageBody');
        if (body) {
          markChatSearchProgrammaticScroll(page);
          body.scrollTop = page.galleryAnchor.top
            + Math.max(0, body.scrollHeight - page.galleryAnchor.height);
        }
        page.galleryAnchor = null;
      }
      page.galleryScrollLocked = false;
      scheduleChatSearchGalleryAutoFill(page);
    }
  }
}

async function loadChatSearchPage(reset) {
  const page = state.chatSearchPage;
  if (page && page.category === 'image_video') {
    return loadChatSearchGalleryMonths(reset);
  }
  const isDateMessages = page
    && page.category === 'date'
    && Boolean(page.selectedDate);
  const isMemberMessages = page
    && page.category === 'members'
    && Boolean(page.selectedMember && page.selectedMember.username);
  const isCategory = page
    && page.category
    && page.category !== 'date'
    && page.category !== 'members';
  if (!state.chatSearchPageOpen || !page
    || (!page.query && !isDateMessages && !isCategory && !isMemberMessages)) return;
  if (!reset && (page.loading || !page.hasMore)) return;
  const contactId = page.contactId;
  const modeKey = chatSearchPageModeKey(page);
  const pageNo = reset ? 1 : page.page + 1;
  const requestId = state.chatSearchPageRequestId + 1;
  state.chatSearchPageRequestId = requestId;
  page.loading = true;
  page.error = '';
  if (!reset) setPagingBusy(true);
  if (reset) {
    page.items = [];
    page.page = 0;
    page.hasMore = true;
    page.total = 0;
    const body = $('#chatSearchPageBody');
    markChatSearchProgrammaticScroll(page);
    if (body) body.scrollTop = 0;
    // 首屏/重置才立即重绘;追加分页要等滚动停止和接口返回后一次性渲染,
    // 避免加载中重建列表造成闪屏。
    renderChatSearchPage();
  }

  try {
    const params = new URLSearchParams({
      page: pageNo,
      pageSize: MESSAGE_PAGE_SIZE,
    });
    if (page.query) {
      params.set('search', page.query);
    } else if (isDateMessages) {
      const range = chatSearchDateRange(page.selectedDate);
      if (!range) throw new Error('日期无效');
      params.set('from', range.from);
      params.set('to', range.to);
    } else if (isMemberMessages) {
      params.set('sender', page.selectedMember.username);
    } else {
      params.set('category', page.category);
    }
    const data = await api(`/api/contacts/${contactId}/messages?${params}`);
    if (requestId !== state.chatSearchPageRequestId
      || state.chatSearchPage !== page
      || !state.chatSearchPageOpen
      || !state.selected
      || state.selected.id !== contactId
      || chatSearchPageModeKey(page) !== modeKey) return;
    if (!reset) {
      // 其他聊天搜索分类追加更早一页时,等用户滚动停止后再插入/重排,
      // 避免滚动惯性中调整列表造成闪屏。
      await waitForChatSearchScrollIdle(page);
      if (requestId !== state.chatSearchPageRequestId
        || state.chatSearchPage !== page
        || !state.chatSearchPageOpen
        || !state.selected
        || state.selected.id !== contactId
        || chatSearchPageModeKey(page) !== modeKey) return;
    }
    const rows = Array.isArray(data.items) ? data.items.slice() : [];
    const items = rows.reverse();
    page.items = reset ? items : page.items.concat(items);
    page.page = Number(data.page) || pageNo;
    page.hasMore = Boolean(data.hasMore);
    page.total = Number(data.total) || 0;
  } catch (err) {
    if (requestId === state.chatSearchPageRequestId
      && state.chatSearchPage === page
      && chatSearchPageModeKey(page) === modeKey) {
      page.error = err.message || '搜索失败';
      page.hasMore = false;
      toast(page.error, true);
    }
  } finally {
    if (requestId === state.chatSearchPageRequestId
      && state.chatSearchPage === page
      && chatSearchPageModeKey(page) === modeKey) {
      page.loading = false;
      renderChatSearchPage();
    }
  }
}

function openChatSearchPage(initialQuery = '') {
  if (!state.selected || state.view !== 'chats') return;
  if (state.chatSearchPageOpen) {
    const current = $('#chatSearchPageInput');
    if (current) current.focus();
    return;
  }
  const query = String(initialQuery || '').trim();
  const contactId = state.selected.id;
  state.chatSearchPageOpen = true;
  state.chatSearchPage = {
    contactId,
    query: '',
    category: null,
    categoryLabel: '',
    selectedDate: '',
    calendarScrollTop: null,
    calendarScrollToBottom: false,
    dates: null,
    dateCounts: null,
    datesTotal: 0,
    datesLoading: false,
    datesError: '',
    datesRequestId: 0,
    earliestDate: '',
    latestDate: '',
    groupMembers: null,
    groupMembersLoading: false,
    groupMembersError: '',
    groupMembersRequestId: 0,
    groupMembersTotal: 0,
    selectedMember: null,
    memberListScrollTop: 0,
    galleryScrollToBottom: false,
    galleryLoadArmed: true,
    galleryAnchor: null,
    galleryScrollLocked: false,
    galleryProgrammaticScrollUntil: 0,
    galleryMonths: null,
    galleryGroups: [],
    galleryNextMonthIndex: -1,
    galleryAutoFillTimer: null,
    scrollPointerActive: false,
    lastScrollAt: 0,
    wheelUntil: 0,
    items: [],
    total: 0,
    page: 0,
    pageSize: MESSAGE_PAGE_SIZE,
    hasMore: false,
    loading: false,
    error: '',
  };
  state.chatSearchPageRequestId += 1;
  chatSearchHistoryDepth = 0;

  const view = $('#chatSearchPageView');
  if (view) {
    view.classList.toggle('chat-search-page--fullscreen', isMobileSinglePane());
    view.classList.remove('hidden', 'chat-search-page--browse');
  }
  const input = $('#chatSearchPageInput');
  if (input) input.value = query;
  updateChatSearchPageClear();
  const body = $('#chatSearchPageBody');
  if (body) body.scrollTop = 0;
  renderChatSearchPage();

  if (isMobileSinglePane()) {
    try {
      history.pushState({ wepoChatSearch: true }, '', location.href);
      chatSearchHistoryDepth = 1;
    } catch (err) {
      chatSearchHistoryDepth = 0;
    }
  }

  if (input) input.focus();
  if (query) {
    state.chatSearchPage.query = query;
    loadChatSearchPage(true);
  }
}

function closeChatSearchPage(options = {}) {
  if (!state.chatSearchPageOpen) return;
  clearTimeout(chatSearchPageTimer);
  cancelChatSearchLongPress();
  hideChatSearchContextMenu();
  state.messageJumpSource = '';
  const fromHistory = options.fromHistory === true;
  const restoreMessagePage = options.restoreMessagePage === true;
  const historyDepth = chatSearchHistoryDepth;
  chatSearchHistoryDepth = 0;
  if (!fromHistory && historyDepth > 0) {
    armIgnoreNextPop();
    try {
      history.go(-historyDepth);
    } catch (err) {
      consumeIgnoreNextPop();
    }
  }
  state.chatSearchPageOpen = false;
  if (state.chatSearchPage) clearTimeout(state.chatSearchPage.galleryAutoFillTimer);
  state.chatSearchPage = null;
  state.chatSearchPageRequestId += 1;
  setPagingBusy(false);
  setChatSearchGalleryLoading(false);
  state.dateJumpOpen = false;
  dateJumpHistoryPushed = false;

  const view = $('#chatSearchPageView');
  if (view) {
    view.classList.add('hidden');
    view.classList.remove('chat-search-page--fullscreen', 'chat-search-page--browse');
  }
  const input = $('#chatSearchPageInput');
  if (input) {
    input.blur();
    input.value = '';
  }
  updateChatSearchPageClear();
  const body = $('#chatSearchPageBody');
  if (body) body.scrollTop = 0;
  const content = $('#chatSearchPageContent');
  if (content) content.innerHTML = '';
  if (restoreMessagePage) restoreMessagePageSnapshot();
  else savedMessagePageState = null;
  updateMobileChrome();
}

function clearChatSearchFilter() {
  if (!state.chatSearch) return;
  state.chatSearch = '';
  state.chatSearchFilterTotal = 0;
  state.selectedMessageId = null;
  state.pendingMessageFocusId = null;
  updateChatSearchFilterBar();
  loadMessages(true);
}

// ---------- 聊天视图 ----------

function renderChat(contact) {
  const name = displayName(contact);
  const sub = [];
  if (contact.isChatroom && contact.members) sub.push(`${contact.members.length} 名成员`);
  sub.push(`${contact.messageCount || 0} 条消息`);
  $('#chatTitle').innerHTML = `${esc(name)}${sub.length ? `<span class="title-sub">${esc(sub.join(' · '))}</span>` : ''}`;
}

/** 判断消息区是否仍处于触摸/惯性/滚轮滚动中 */
function isMessageScrollActive() {
  const now = performance.now();
  return state.messagesPointerActive
    || now - Number(state.messagesLastScrollAt || 0) < 140
    || now < Number(state.messagesWheelUntil || 0);
}

/** 等用户停止滚动后再插入上一页,避免滚动惯性下强制调整 scrollTop 造成闪动 */
function waitForMessageScrollIdle(maxMs = 4000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const check = () => {
      if (!isMessageScrollActive() || performance.now() - startedAt >= maxMs) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

async function loadMessages(reset) {
  if (!state.selected) return;
  if (reset) {
    stopAllAudioPlayback();
    state.messagesScrollRestoreToken += 1;
  }
  if (!reset && (!state.messagesLoadArmed || state.messagesLoading || state.messagesRestoringScroll || state.messagesOlderLoadLocked)) return;
  if (reset) clearQuoteJumpReturnState();
  const contact = state.selected;
  const requestId = state.messagesRequestId + 1;
  state.messagesRequestId = requestId;
  state.messagesLoading = true;
  state.messagesLoadingNewer = false;
  if (reset) {
    state.messagesRestoringScroll = false;
    state.messagesLoadArmed = true;
    state.messagesOlderLoadLocked = false;
    state.messagesNewerArmed = false;
    state.messagesLastScrollTop = 0;
    state.messagesLayoutAnchor = null;
    state.messagesLayoutAnchorTop = 0;
    state.messageDateMode = false;
    state.messageHasNewer = false;
    state.messageOlderCursor = null;
    state.messageNewerCursor = null;
    state.messageAnchorId = null;
  } else {
    state.messagesLoadArmed = false;
    state.messagesOlderLoadLocked = true;
  }
  updateMessageLoading();
  if (reset) {
    state.messages = [];
    renderMessages();
  }
  try {
    const params = new URLSearchParams({ page: reset ? 1 : state.messagePage + 1, pageSize: MESSAGE_PAGE_SIZE });
    if (state.chatSearch) params.set('search', state.chatSearch);
    const data = await api(`/api/contacts/${contact.id}/messages?${params}`);
    if (requestId !== state.messagesRequestId) return;
    if (!reset) {
      await waitForMessageScrollIdle();
      if (requestId !== state.messagesRequestId || state.selected !== contact) return;
    }
    state.messagePage = data.page;
    state.messageHasMore = data.hasMore;
    // 列表使用轻量合并摘要;打开完整会话后以消息接口的去重 total 修正标题计数
    const exactCount = Number(data.total);
    if (reset && !state.chatSearch && Number.isFinite(exactCount)) {
      contact.messageCount = exactCount;
      state.selected.messageCount = exactCount;
      const listed = state.contacts.find((item) => item.id === contact.id);
      if (listed) listed.messageCount = exactCount;
      renderChat(contact);
    }

    if (reset) {
      state.messages = data.items;
      renderMessages();
    } else {
      const existingFirstKey = state.messages.length
        ? formatDayKey(state.messages[0].createTime)
        : '';
      state.messages = data.items.concat(state.messages);
      prependOlderMessages(data.items, existingFirstKey);
    }

    state.messagesLoading = false;
    updateMessageLoading();
    // 首次加载/搜索时滚动到最新消息(等布局/媒体尺寸稳定后再次定位)
    if (reset) {
      const focusId = state.pendingMessageFocusId;
      if (focusId) {
        // 从搜索结果进入时优先定位到被点击的消息;不在当前页再回到底部
        requestAnimationFrame(() => {
          if (!focusPendingMessage()) scrollMessagesToBottom();
        });
        setTimeout(() => {
          if (state.pendingMessageFocusId === focusId) {
            if (!focusPendingMessage()) scrollMessagesToBottom();
          }
        }, 120);
      } else {
        scrollMessagesToBottom();
        requestAnimationFrame(scrollMessagesToBottom);
        setTimeout(scrollMessagesToBottom, 120);
      }
      setTimeout(maybeLoadMoreMessages, 180);
    }
  } catch (err) {
    if (requestId === state.messagesRequestId) toast(err.message, true);
  } finally {
    if (requestId === state.messagesRequestId && state.messagesLoading) {
      state.messagesLoading = false;
      updateMessageLoading();
    }
  }
}

/** 从聊天内搜索跳转到消息列表:日期最早消息或指定消息 + 前 50 条 + 后 49 条 */
async function loadDateWindow(dateKey, messageId = 0, options = {}) {
  const contact = state.selected;
  const anchorMessageId = Number(messageId) || 0;
  if (!contact) return false;
  stopAllAudioPlayback();
  if (!anchorMessageId && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return false;
  const requestId = state.messagesRequestId + 1;
  state.messagesRequestId = requestId;
  state.messagesScrollRestoreToken += 1;
  state.messagesLoading = true;
  state.messagesLoadingNewer = false;
  state.messagesRestoringScroll = false;
  state.messagesLoadArmed = false;
  state.messagesOlderLoadLocked = false;
  state.messagesNewerArmed = false;
  state.messagesLastScrollTop = 0;
  state.messagesLayoutAnchor = null;
  state.messagesLayoutAnchorTop = 0;
  state.messageDateMode = true;
  state.messageHasMore = false;
  state.messageHasNewer = false;
  state.messageOlderCursor = null;
  state.messageNewerCursor = null;
  state.messageAnchorId = null;
  state.messagePage = 1;
  state.messages = [];
  state.pendingMessageFocusId = null;
  updateMessageLoading();
  renderMessages();

  try {
    const params = new URLSearchParams({
      before: String(MESSAGE_DATE_BEFORE),
      after: String(MESSAGE_DATE_AFTER),
    });
    if (anchorMessageId) {
      params.set('anchorId', String(anchorMessageId));
    } else {
      params.set('anchorDate', dateKey);
      params.set('offset', String(-new Date().getTimezoneOffset() * 60));
    }
    const data = await api(`/api/contacts/${contact.id}/messages?${params}`);
    if (requestId !== state.messagesRequestId || state.selected !== contact) return false;
    const items = Array.isArray(data.items) ? data.items : [];
    state.messages = items;
    state.messageHasMore = Boolean(data.hasOlder);
    state.messageHasNewer = Boolean(data.hasNewer);
    state.messageOlderCursor = items.length ? items[0].id : null;
    state.messageNewerCursor = items.length ? items[items.length - 1].id : null;
    state.messageAnchorId = Number(data.anchorId) || null;
    state.pendingMessageFocusId = state.messageAnchorId;
    state.messagesLoading = false;
    state.messagesLoadArmed = true;
    state.messagesNewerArmed = true;
    updateMessageLoading();
    renderMessages();
    if (items.length === 0) return false;

    const focusId = state.pendingMessageFocusId;
    const focus = () => {
      if (!focusPendingMessage()) {
        const area = $('#messageArea');
        if (area) area.scrollTop = 0;
      }
    };
    requestAnimationFrame(focus);
    setTimeout(() => {
      if (state.pendingMessageFocusId === focusId) focus();
    }, 120);
    return true;
  } catch (err) {
    if (requestId !== state.messagesRequestId) return false;
    state.messagesLoading = false;
    state.messageDateMode = false;
    updateMessageLoading();
    if (options.fallback !== false) {
      toast(err.message, true);
      loadMessages(true);
    }
    return false;
  }
}

/** 日期窗口模式:向上加载更早消息 */
async function loadOlderDateWindowMessages() {
  const contact = state.selected;
  if (!contact || !state.messageDateMode || state.messagesLoading || state.messagesRestoringScroll
    || state.messagesOlderLoadLocked || !state.messageHasMore || !state.messageOlderCursor) return;
  const cursor = state.messageOlderCursor;
  const requestId = state.messagesRequestId + 1;
  state.messagesRequestId = requestId;
  state.messagesLoading = true;
  state.messagesLoadingNewer = false;
  state.messagesLoadArmed = false;
  state.messagesOlderLoadLocked = true;
  updateMessageLoading();
  const existingFirstKey = state.messages.length
    ? formatDayKey(state.messages[0].createTime)
    : '';

  try {
    const params = new URLSearchParams({
      beforeId: String(cursor),
      limit: String(MESSAGE_DATE_PAGE_SIZE),
    });
    const data = await api(`/api/contacts/${contact.id}/messages?${params}`);
    if (requestId !== state.messagesRequestId
      || state.selected !== contact
      || !state.messageDateMode) return;
    await waitForMessageScrollIdle();
    if (requestId !== state.messagesRequestId
      || state.selected !== contact
      || !state.messageDateMode) return;
    const items = Array.isArray(data.items) ? data.items : [];
    state.messageHasMore = Boolean(data.hasOlder);
    if (items.length > 0) {
      state.messages = items.concat(state.messages);
      state.messageOlderCursor = items[0].id;
      prependOlderMessages(items, existingFirstKey);
    }
    state.messagesLoading = false;
    updateMessageLoading();
  } catch (err) {
    if (requestId === state.messagesRequestId) toast(err.message, true);
  } finally {
    if (requestId === state.messagesRequestId) {
      state.messagesLoading = false;
      updateMessageLoading();
    }
  }
}

/** 日期窗口模式:滑到底部时向下载入更新的消息 */
async function loadNewerDateWindowMessages() {
  const contact = state.selected;
  if (!contact || !state.messageDateMode || state.messagesLoading
    || !state.messageHasNewer || !state.messageNewerCursor) return;
  const cursor = state.messageNewerCursor;
  const requestId = state.messagesRequestId + 1;
  state.messagesRequestId = requestId;
  state.messagesLoading = true;
  state.messagesLoadingNewer = true;
  state.messagesNewerArmed = false;
  updateMessageLoading();
  const existingLastKey = state.messages.length
    ? formatDayKey(state.messages[state.messages.length - 1].createTime)
    : '';

  try {
    const params = new URLSearchParams({
      afterId: String(cursor),
      limit: String(MESSAGE_DATE_PAGE_SIZE),
    });
    const data = await api(`/api/contacts/${contact.id}/messages?${params}`);
    if (requestId !== state.messagesRequestId
      || state.selected !== contact
      || !state.messageDateMode) return;
    const items = Array.isArray(data.items) ? data.items : [];
    state.messageHasNewer = Boolean(data.hasNewer);
    if (items.length > 0) {
      state.messages = state.messages.concat(items);
      state.messageNewerCursor = items[items.length - 1].id;
      appendNewerMessages(items, existingLastKey);
    }
    state.messagesLoading = false;
    state.messagesLoadingNewer = false;
    updateMessageLoading();
  } catch (err) {
    if (requestId === state.messagesRequestId) toast(err.message, true);
  } finally {
    if (requestId === state.messagesRequestId) {
      state.messagesLoading = false;
      state.messagesLoadingNewer = false;
      updateMessageLoading();
    }
  }
}

/** 聊天搜索页(图片/视频网格)的滚动活动状态 */
function isChatSearchScrollActive(page) {
  if (!page) return false;
  const now = performance.now();
  return Boolean(page.scrollPointerActive)
    || now - Number(page.lastScrollAt || 0) < 140
    || now < Number(page.wheelUntil || 0);
}

function waitForChatSearchScrollIdle(page, maxMs = 4000) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const check = () => {
      if (!isChatSearchScrollActive(page) || performance.now() - startedAt >= maxMs) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/** 消息列表接近顶部时自动加载更早的一页 */
function maybeLoadMoreMessages() {
  if (!state.selected || !state.messagesLoadArmed || state.messagesLoading
    || state.messagesRestoringScroll || state.messagesOlderLoadLocked || !state.messageHasMore) return;
  const area = $('#messageArea');
  if (area && area.scrollTop < MESSAGE_LOAD_TOP) {
    if (state.messageDateMode) loadOlderDateWindowMessages();
    else loadMessages(false);
  }
}

function memberName(contact, username) {
  if (!username) return '';
  const members = contact.members || [];
  const m = members.find((x) => x.username === username);
  return m ? m.displayName || m.username : username;
}

function voiceDurationMeta(m, extra) {
  const length = Number(extra && extra.voiceLength) || 0;
  let seconds = length > 0 ? Math.max(1, Math.round(length / 1000)) : 0;
  if (!seconds) {
    const match = String(m.content || '').match(/(\d+)\s*[″"]/);
    seconds = match ? Number(match[1]) : 0;
  }
  let label = String((extra && extra.durationText) || '').trim();
  if (label) label = label.replace(/″/g, '"');
  else if (seconds) label = `${seconds}"`;
  else label = '语音';
  // 宽度分段:2s 最小;2→10s 线性到最大宽度的 80%;11→60s 线性到 100%。
  const minWidth = 110;
  const maxWidth = 220;
  const widthSeconds = seconds > 0 ? Math.max(1, Math.min(60, seconds)) : 0;
  let width = 160;
  if (widthSeconds) {
    if (widthSeconds <= 2) {
      width = minWidth;
    } else if (widthSeconds <= 10) {
      width = minWidth + ((widthSeconds - 2) / 8) * (maxWidth * 0.8 - minWidth);
    } else {
      width = maxWidth * 0.8 + ((widthSeconds - 11) / 49) * (maxWidth * 0.2);
    }
    width = Math.round(width);
  }
  return { seconds, label, width };
}

function renderVoiceCard(m, extra) {
  const meta = voiceDurationMeta(m, extra);
  const durationLabel = meta.seconds ? `${meta.seconds}秒` : '语音';
  return `<div class="msg-voice" role="button" tabindex="0" aria-pressed="false" aria-label="播放语音，${esc(durationLabel)}" style="--voice-width:${meta.width}px">
    <audio class="msg-voice-audio" preload="none" src="${esc(mediaUrl(m.mediaPath))}" aria-hidden="true" tabindex="-1"></audio>
    <span class="msg-voice-wave" aria-hidden="true">
      <svg viewBox="0 0 20 22" focusable="false">
        <path class="voice-wave-core" d="M3.6 11 L6.42 8.46 A3.8 3.8 0 0 1 6.42 13.54 Z"></path>
        <path class="voice-wave-arc voice-wave-arc--1" d="M9.10 6.05 A7.4 7.4 0 0 1 9.10 15.95"></path>
        <path class="voice-wave-arc voice-wave-arc--2" d="M12.44 3.04 A11.9 11.9 0 0 1 12.44 18.96"></path>
      </svg>
    </span>
    <span class="msg-voice-duration">${esc(meta.label)}</span>
  </div>`;
}

function toggleVoiceCard(card) {
  if (!card) return;
  const audio = card.querySelector('audio.msg-voice-audio');
  if (!audio) return;
  if (!audio.paused) {
    audio.pause();
    return;
  }
  const list = $('#messageList');
  if (list) {
    list.querySelectorAll('audio.msg-voice-audio').forEach((other) => {
      if (other !== audio) other.pause();
    });
  }
  if (audio.ended) {
    try { audio.currentTime = 0; } catch (err) { /* ignore */ }
  }
  const promise = audio.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      card.classList.remove('is-playing');
      card.setAttribute('aria-pressed', 'false');
    });
  }
}

function messageHtml(m, contact) {
  const isSelf = m.isSent;
  const senderName = !isSelf && contact.isChatroom
    ? (m.senderName || memberName(contact, m.sender) || m.sender)
    : '';
  const time = formatMsgTime(m.createTime);

  const systemHtml = systemRowHtml(m);
  if (systemHtml) return systemHtml;

  let avatar;
  if (isSelf) {
    const user = currentUser();
    avatar = user ? userAvatarUrl(user) : fallbackAvatar('我', contact.owner || 'me');
  } else if (contact.isChatroom) {
    avatar = avatarUrl({
      avatar: m.senderAvatar || '',
      nickname: senderName || m.sender || '群成员',
      hash: m.sender || contact.hash,
    });
  } else {
    avatar = avatarUrl(contact);
  }

  let contentHtml;
  let afterBubbleHtml = '';
  let isCardMessage = false;
  const isImageMessage = m.mediaKind === 'image' && Boolean(m.mediaPath);
  const isVoiceMessage = m.mediaKind === 'voice' && Boolean(m.mediaPath);
  const isEmojiMessage = m.type === 47 && Boolean(m.emojiPath);
  const appExtra = m.extra && typeof m.extra === 'object' ? m.extra : null;
  const imageWidth = Number(appExtra && appExtra.width);
  const imageHeight = Number(appExtra && appExtra.height);
  const hasImageSize = isImageMessage && imageWidth > 0 && imageHeight > 0;
  const imageSizeClass = hasImageSize ? ' msg-image--sized' : '';
  const imageSizeStyle = hasImageSize
    ? ` style="--img-w:${imageWidth};--img-h:${imageHeight};--img-natural-width:${imageWidth}px;--img-ratio:${(imageWidth / imageHeight).toFixed(6)}"`
    : '';
  const quoteWithRefer = m.type === 49
    && appExtra
    && Number(appExtra.appType) === 57
    && appExtra.refer
    && typeof appExtra.refer === 'object';
  const legacyQuote = m.type === 49
    && appExtra
    && Number(appExtra.appType) === 57
    && !quoteWithRefer;
  if (isEmojiMessage) {
    contentHtml = `<img class="msg-emoji" src="${esc(mediaUrl(m.emojiPath))}" loading="lazy" alt="表情" />`;
  } else if (isImageMessage) {
    contentHtml = `<img class="msg-image${imageSizeClass}" src="${esc(mediaUrl(m.mediaPath))}" loading="lazy" alt="图片"${imageSizeStyle} />`;
  } else if (isVoiceMessage) {
    contentHtml = renderVoiceCard(m, appExtra);
  } else if (m.mediaKind === 'video' && m.mediaPath) {
    contentHtml = `<video controls src="${esc(mediaUrl(m.mediaPath))}"></video>`;
  } else if (m.type === 49 && quoteWithRefer) {
    const quote = renderQuoteParts(m);
    contentHtml = quote.replyHtml;
    afterBubbleHtml = quote.refHtml;
  } else if (m.type === 49 && !legacyQuote) {
    contentHtml = renderAppCard(m);
    isCardMessage = true;
  } else if (m.type === 42 || m.type === 66) {
    contentHtml = renderContactCard(m);
    isCardMessage = true;
  } else if (m.type === 48) {
    contentHtml = renderLocationCard(m);
    isCardMessage = true;
  } else if (m.type === 1 || legacyQuote) {
    contentHtml = renderTextWithEmoji(m.content);
  } else {
    contentHtml = esc(m.content);
  }

  const voiceText = isVoiceMessage && appExtra
    ? String(appExtra.voiceText || '').trim()
    : '';
  if (voiceText) {
    afterBubbleHtml = `<div class="msg-voice-transcript">${esc(voiceText)}</div>`;
  }
  const bubbleType = isImageMessage
    ? ' msg-bubble--image'
    : (isEmojiMessage
      ? ' msg-bubble--emoji'
      : (isVoiceMessage
        ? ' msg-bubble--voice'
        : (isCardMessage ? ' msg-bubble--card' : '')));
  const rowClasses = [
    isSelf ? 'right' : '',
    m.type === 48 ? 'msg-row--location' : '',
    m.type === 49 && contentHtml.includes('msg-card--link') ? 'msg-row--link' : '',
    m.type === 49 && contentHtml.includes('msg-card--miniapp') ? 'msg-row--miniapp' : '',
    m.type === 49 && contentHtml.includes('msg-card--channels') ? 'msg-row--channels' : '',
    m.type === 49 && contentHtml.includes('msg-card--record') ? 'msg-row--record' : '',
    m.type === 49 && contentHtml.includes('msg-card--pay') ? 'msg-row--pay' : '',
    isVoiceMessage ? 'msg-row--voice' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="msg-row ${rowClasses}" data-message-id="${m.id}">
      <div class="msg-avatar" style="background-image:url('${avatar}')"></div>
      <div class="msg-body">
        ${senderName ? `<div class="msg-sender">${esc(senderName)}</div>` : ''}
        <div class="msg-bubble${bubbleType}" title="${esc(time)}"><div class="msg-content">${contentHtml}</div></div>
        ${afterBubbleHtml}
        <div class="msg-time">${esc(time)}</div>
      </div>
    </div>`;
}

/** 滚动消息区到底部 */
function scrollMessagesToBottom() {
  const area = $('#messageArea');
  if (area) area.scrollTop = area.scrollHeight;
}

function buildMessagesHtml(messages) {
  let html = '';
  let lastDay = '';
  for (const m of messages) {
    const dayKey = formatDayKey(m.createTime);
    if (dayKey !== lastDay) {
      html += `<div class="msg-day">${esc(formatDay(m.createTime))}</div>`;
      lastDay = dayKey;
    }
    html += messageHtml(m, state.selected);
  }
  return { html, lastDay };
}

/** 锚点在滚动内容中的位置(与当前 scrollTop 无关) */
function messagesLayoutOffset(anchor, area) {
  return anchor.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
}

function setMessagesLayoutAnchor(anchor) {
  const area = $('#messageArea');
  if (!area || !anchor || !anchor.isConnected) return;
  state.messagesLayoutAnchor = anchor;
  state.messagesLayoutAnchorTop = messagesLayoutOffset(anchor, area);
}

/**
 * 更早消息里的图片/贴纸可能在上方异步变大;用 ResizeObserver 根据锚点
 * 在文档中的位移补偿 scrollTop,避免加载完成后视口被顶到新内容顶部。
 */
function restoreMessagesLayoutAnchor() {
  const area = $('#messageArea');
  const anchor = state.messagesLayoutAnchor;
  if (!area || !anchor || state.messagesRestoringScroll) return;
  if (!anchor.isConnected) {
    state.messagesLayoutAnchor = null;
    return;
  }
  const currentTop = messagesLayoutOffset(anchor, area);
  const delta = currentTop - state.messagesLayoutAnchorTop;
  if (Math.abs(delta) < 0.5) return;
  area.scrollTop += delta;
  state.messagesLayoutAnchorTop = currentTop;
}

function ensureMessagesLayoutObserver() {
  if (state.messagesLayoutObserver || typeof ResizeObserver === 'undefined') return;
  const list = $('#messageList');
  if (!list) return;
  state.messagesLayoutObserver = new ResizeObserver(restoreMessagesLayoutAnchor);
  state.messagesLayoutObserver.observe(list);
}

/** 用户滚动后把锚点更新为视口顶部附近的消息,避免为视口下方的内容变化补偿 */
function updateMessagesLayoutAnchorFromViewport() {
  if (state.messagesRestoringScroll || !state.messagesLayoutAnchor) return;
  const area = $('#messageArea');
  if (!area) return;
  const rect = area.getBoundingClientRect();
  const el = document.elementFromPoint(
    rect.left + Math.min(20, rect.width / 2),
    rect.top + Math.min(12, rect.height / 2)
  );
  const row = el && el.closest ? el.closest('#messageList .msg-row') : null;
  if (row) setMessagesLayoutAnchor(row);
}

/** 只向列表头部插入更早消息,保留已有 DOM,避免整表重建导致闪烁 */
function prependOlderMessages(items, existingFirstKey) {
  if (items.length === 0) return;
  const area = $('#messageArea');
  const list = $('#messageList');
  const firstExistingDay = list.querySelector('.msg-day');
  const anchor = list.querySelector('.msg-row');
  const anchorViewportTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const prevScrollHeight = area.scrollHeight;
  const prevScrollTop = area.scrollTop;
  const restoreToken = ++state.messagesScrollRestoreToken;
  state.messagesRestoringScroll = true;
  const built = buildMessagesHtml(items);

  list.insertAdjacentHTML('afterbegin', built.html);
  // 新旧分页落在同一天时,去掉旧的第一天分隔条,保留新插入的那一条
  if (firstExistingDay && existingFirstKey && built.lastDay === existingFirstKey) {
    firstExistingDay.remove();
  }

  const keepAnchor = () => {
    if (!anchor || !anchor.isConnected) return;
    const delta = anchor.getBoundingClientRect().top - anchorViewportTop;
    if (Math.abs(delta) >= 0.5) area.scrollTop += delta;
  };
  area.scrollTop = prevScrollTop + Math.max(0, area.scrollHeight - prevScrollHeight);
  keepAnchor();
  state.messagesLastScrollTop = area.scrollTop;
  ensureMessagesLayoutObserver();

  // 触摸惯性/异步图片布局可能在普通 scrollTop 补偿之后继续改变位置。
  // 在加载完成后的短暂窗口内持续用视口锚点校正,直到滚动位置稳定。
  const startedAt = performance.now();
  const finish = () => {
    if (restoreToken !== state.messagesScrollRestoreToken) return;
    state.messagesRestoringScroll = false;
    state.messagesLastScrollTop = area.scrollTop;
    setMessagesLayoutAnchor(anchor);
  };
  const step = () => {
    if (restoreToken !== state.messagesScrollRestoreToken) return;
    if (!anchor || !anchor.isConnected) {
      finish();
      return;
    }
    keepAnchor();
    state.messagesLastScrollTop = area.scrollTop;
    if (performance.now() - startedAt < 900) requestAnimationFrame(step);
    else finish();
  };
  requestAnimationFrame(step);
  // requestAnimationFrame 在后台标签页可能暂停,保留一个兜底解锁
  setTimeout(finish, 1300);
}

/** 只向列表尾部追加更新消息,保留已有 DOM 和滚动位置 */
function appendNewerMessages(items, existingLastKey) {
  if (items.length === 0) return;
  const list = $('#messageList');
  if (!list) return;
  const dayHeaders = list.querySelectorAll('.msg-day');
  const lastExistingDay = dayHeaders.length > 0 ? dayHeaders[dayHeaders.length - 1] : null;
  const built = buildMessagesHtml(items);
  list.insertAdjacentHTML('beforeend', built.html);
  // 新旧分页落在同一天时,去掉旧的最后一天分隔条,保留新插入的那一条
  if (lastExistingDay && existingLastKey
    && formatDayKey(items[0].createTime) === existingLastKey) {
    lastExistingDay.remove();
  }
  ensureMessagesLayoutObserver();
}

/** 定位并短暂高亮聊天记录搜索点击的那条消息 */
function focusPendingMessage() {
  const id = state.pendingMessageFocusId;
  if (!id) return false;
  const el = document.querySelector(`#messageList .msg-row[data-message-id="${id}"]`);
  state.pendingMessageFocusId = null;
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('msg-row--search-hit');
  setTimeout(() => el.classList.remove('msg-row--search-hit'), 2400);
  return true;
}

function renderMessages() {
  const area = $('#messageArea');
  const list = $('#messageList');
  updateMessageLoading();

  if (state.messages.length === 0) {
    list.innerHTML = `<div class="empty-tip" style="padding:60px 0">${
      state.messagesLoading ? '正在加载...' : state.chatSearch ? '没有匹配的消息' : '暂无聊天记录'
    }</div>`;
    return;
  }

  const prevScroll = area.scrollHeight;
  list.innerHTML = buildMessagesHtml(state.messages).html;
  // 加载更早消息后保持视口位置
  if (state.messagePage > 1 && prevScroll > 0) {
    area.scrollTop = area.scrollHeight - prevScroll;
  }
}

// ---------- 通讯录详情 ----------

let contactDetailTagsRequestId = 0;

function contactDetailHtml(contact, options = {}) {
  const rows = [];
  const pushRow = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(`<div class="contact-detail-row"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`);
  };
  // 备注优先作为显示名;备注存在且与微信昵称不同时,再补充一行昵称。
  const detailName = contact.remark || contact.nickname || contact.username || contact.hash;
  const nicknameLine = contact.remark
    && contact.nickname
    && contact.nickname !== contact.remark
    ? contact.nickname
    : '';
  const wxId = contact.isChatroom ? '' : (contact.wxName || '');
  const metaLines = [];
  if (nicknameLine) metaLines.push(`昵称：${esc(nicknameLine)}`);
  if (contact.isChatroom) metaLines.push('群聊');
  else if (wxId) metaLines.push(`微信号：${esc(wxId)}`);
  if (contact.region) metaLines.push(`地区：${esc(contact.region)}`);

  pushRow('电话', contact.phone);
  rows.push(`
    <div class="contact-detail-row hidden" data-contact-detail-tags>
      <div class="label">标签</div>
      <div class="value member-chips"></div>
    </div>`);
  pushRow('消息数', contact.messageCount);
  pushRow('最近消息', contact.lastMessageTime ? formatMsgTime(contact.lastMessageTime) : '');

  let membersHtml = '';
  if (contact.isChatroom && contact.members && contact.members.length > 0) {
    membersHtml = `
      <div class="contact-detail-row">
        <div class="label">群成员</div>
        <div class="value member-chips">
          ${contact.members.map((m) => `<span class="member-chip">${esc(m.displayName || m.username)}</span>`).join('')}
        </div>
      </div>`;
  }

  const actionHtml = options.fromChat
    ? ''
    : `<div class="detail-action">
      <button class="green-btn contact-goto-chat-btn" type="button">查看聊天记录</button>
    </div>`;

  return `
    <div class="contact-detail-card">
      <div class="contact-detail-head">
        <div class="contact-detail-avatar" style="background-image:url('${avatarUrl(contact)}')"></div>
        <div class="contact-detail-main">
          <div class="contact-detail-name">${esc(detailName)}</div>
          ${metaLines.length ? `<div class="contact-detail-meta">
            ${metaLines.map((line) => `<div class="contact-detail-meta-line">${line}</div>`).join('')}
          </div>` : ''}
        </div>
      </div>
      ${rows.join('')}
      ${membersHtml}
    </div>
    ${actionHtml}`;
}

async function loadContactDetailTags(contact, tagsRow) {
  if (!contact || !contact.id || !tagsRow) return;
  const requestId = contactDetailTagsRequestId + 1;
  contactDetailTagsRequestId = requestId;
  try {
    const data = await api(`/api/contacts/${contact.id}/tags`);
    if (requestId !== contactDetailTagsRequestId || !tagsRow.isConnected) return;
    const tags = Array.isArray(data.tags) ? data.tags.filter(Boolean) : [];
    if (tags.length === 0) return;
    const value = tagsRow.querySelector('.value');
    if (!value) return;
    value.innerHTML = tags
      .map((tag) => `<span class="member-chip">${esc(tag)}</span>`)
      .join('');
    tagsRow.classList.remove('hidden');
  } catch (err) {
    /* 标签加载失败不影响详情页其他信息 */
  }
}

function renderContactDetail(contact, options = {}) {
  const targetSelector = options.target || '#contactDetail';
  const container = $(targetSelector);
  if (!container) return;

  container.innerHTML = contactDetailHtml(contact, options);
  const gotoBtn = container.querySelector('.contact-goto-chat-btn');
  if (gotoBtn) {
    gotoBtn.addEventListener('click', () => openChatFromContactDetail(contact));
  }
  const tagsRow = container.querySelector('[data-contact-detail-tags]');
  if (tagsRow) loadContactDetailTags(contact, tagsRow);
}

/** 从私聊打开联系人详情页,聊天状态保留在下面,返回后不重新加载 */
function openChatContactDetail() {
  const contact = state.selected;
  if (!contact || state.view !== 'chats' || contact.isChatroom) return;
  // 日期消息页是从聊天内搜索的深层进入的独立页面。打开联系人资料时
  // 只叠加一层,不能关闭下面的搜索/日期层:closeChatSearchPage 会一次
  // 回退多条 history,导致之后返回层级错乱、无法回到会话列表。
  if (state.chatSearchPageOpen && !state.dateJumpOpen) {
    closeChatSearchPage({ restoreMessagePage: true });
  }
  if (state.chatContactDetailOpen) return;

  state.chatContactDetailOpen = true;
  renderContactDetail(contact, { target: '#chatContactDetailBody', fromChat: true });
  $('#chatContactDetailPage').classList.remove('hidden');
  if (isMobileSinglePane() && !chatContactDetailHistoryPushed) {
    try {
      history.pushState({ wepoChatContactDetail: true }, '', location.href);
      chatContactDetailHistoryPushed = true;
    } catch (err) {
      chatContactDetailHistoryPushed = false;
    }
  }
  updateMobileChrome();
}

function closeChatContactDetail(options = {}) {
  if (!state.chatContactDetailOpen) return;
  const fromHistory = options.fromHistory === true;
  if (!fromHistory && chatContactDetailHistoryPushed) {
    chatContactDetailHistoryPushed = false;
    armIgnoreNextPop();
    try {
      history.back();
    } catch (err) {
      consumeIgnoreNextPop();
    }
  }
  chatContactDetailHistoryPushed = false;
  state.chatContactDetailOpen = false;
  contactDetailTagsRequestId += 1;
  $('#chatContactDetailPage').classList.add('hidden');
  $('#chatContactDetailBody').innerHTML = '';
  updateMobileChrome();
}

// ---------- “我”页(账号 / 外观 / 数据统计) ----------

const THEME_OPTIONS = [
  ['system', '自动'],
  ['light', '浅色'],
  ['dark', '深色'],
];

/** 外观设置卡片:左侧标题,右侧选项 */
function appearanceHtml() {
  return `
    <div class="settings-card appearance-card">
      <div class="settings-card-heading">
        <span class="settings-card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="10" cy="10" r="8.5"></circle>
            <path d="M10 1.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"></path>
          </svg>
        </span>
        <h3>外观</h3>
      </div>
      <div class="segmented" id="themeSegmented">
        ${THEME_OPTIONS.map(([value, label]) => `
          <button data-theme-choice="${value}" class="${state.theme === value ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    </div>`;
}

/** 绑定外观选择器 */
function bindAppearance() {
  const segmented = $('#themeSegmented');
  if (!segmented) return;
  segmented.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.theme = btn.dataset.themeChoice;
      localStorage.setItem(THEME_KEY, state.theme);
      applyTheme();
      segmented.querySelectorAll('[data-theme-choice]').forEach((item) => {
        item.classList.toggle('active', item === btn);
      });
    });
  });
}

// ---------- 账号(我页面) ----------

/** 当前账号对象 */
function currentUser() {
  if (!state.currentOwner) return null;
  return state.users.find((user) => user.username === state.currentOwner) || null;
}

function userDisplayName(user) {
  return user.displayName || user.username;
}

function userAvatarUrl(user) {
  return avatarUrl({
    nickname: userDisplayName(user),
    hash: user.username,
    avatar: user.avatar,
  });
}

/** 左侧栏顶部显示当前账号头像 */
function updateNavAvatar() {
  const el = $('#navAvatar');
  if (!el) return;
  const user = currentUser();
  el.style.backgroundImage = `url('${user ? userAvatarUrl(user) : fallbackAvatar('微', 'wechat')}')`;
  el.title = user ? userDisplayName(user) : '微信聊天记录';
}

/** 拉取所有导入中出现过的账号,并确定当前账号 */
async function loadUsers() {
  try {
    const previousOwner = state.currentOwner;
    const data = await api('/api/users');
    state.users = Array.isArray(data.items) ? data.items : [];
    const saved = state.currentOwner || localStorage.getItem('wepo.owner') || '';
    const matched = state.users.find((user) => user.username === saved);
    state.currentOwner = matched
      ? matched.username
      : (state.users[0] ? state.users[0].username : '');
    if (state.currentOwner !== previousOwner) {
      // 账号变化后旧的列表/统计缓存一律作废
      invalidateListCaches();
      state.contactsLoaded = false;
    }
    if (state.currentOwner) {
      localStorage.setItem('wepo.owner', state.currentOwner);
    } else {
      localStorage.removeItem('wepo.owner');
    }
    updateNavAvatar();
    return true;
  } catch (err) {
    // 保留已有账号列表;网络/鉴权错误由 toast/登录遮罩提示
    toast(err.message, true);
    return false;
  }
}

/** “我”页面顶部账号卡片 */
function accountHtml() {
  const user = currentUser();
  const name = user ? userDisplayName(user) : '未导入账号';
  const sub = user
    ? `微信号: ${user.username}`
    : '请使用桌面客户端导入备份';
  const avatar = user ? userAvatarUrl(user) : fallbackAvatar('我', 'me');
  const action = user ? (state.users.length > 1 ? '切换账号' : '账号') : '';
  const interactive = Boolean(user);

  return `
    <div class="settings-card account-card${interactive ? '' : ' account-card--empty'}" id="accountCard"${interactive ? ' role="button" tabindex="0"' : ' aria-disabled="true"'}>
      <div class="account-avatar" style="background-image:url('${avatar}')"></div>
      <div class="account-info">
        <div class="account-name">${esc(name)}</div>
        <div class="account-sub">${esc(sub)}</div>
      </div>
      ${action ? `<div class="account-action">${esc(action)} ›</div>` : ''}
    </div>`;
}

function bindAccountCard() {
  const card = $('#accountCard');
  if (!card || !currentUser()) return;
  const open = () => openUserSwitcher();
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

function renderUserSwitcher() {
  const list = $('#userList');
  if (!state.users.length) {
    list.innerHTML = '<div class="user-empty">暂无账号,请先导入备份</div>';
    return;
  }
  list.innerHTML = state.users.map((user) => {
    const active = user.username === state.currentOwner;
    return `
      <button class="user-item${active ? ' active' : ''}" type="button" data-username="${esc(user.username)}">
        <div class="user-item-avatar" style="background-image:url('${userAvatarUrl(user)}')"></div>
        <div class="user-item-info">
          <div class="user-item-name">${esc(userDisplayName(user))}</div>
          <div class="user-item-sub">${esc(user.username)}</div>
        </div>
        ${active ? '<span class="user-check">✓</span>' : ''}
      </button>`;
  }).join('');

  list.querySelectorAll('.user-item').forEach((btn) => {
    btn.addEventListener('click', () => selectUser(btn.dataset.username));
  });
}

async function openUserSwitcher() {
  if (!currentUser()) return;
  const beforeOwner = state.currentOwner;
  const loaded = await loadUsers();
  if (!loaded) return;
  if (!state.users.length) {
    if (state.view === 'data' && state.currentOwner !== beforeOwner) {
      renderDataManager();
    }
    toast('暂无账号,请先导入备份');
    return;
  }
  if (state.currentOwner !== beforeOwner) {
    // 保存的账号已不存在,已回退到第一个账号:同步刷新列表与统计
    invalidateListCaches();
    resetListViewForOwnerChange();
    clearDetailViewForOwnerChange();
    if (state.view === 'data') {
      renderDataManager();
    } else {
      await loadContacts(true);
    }
  }
  renderUserSwitcher();
  $('#userSwitcher').classList.remove('hidden');
}

function closeUserSwitcher() {
  $('#userSwitcher').classList.add('hidden');
}

async function selectUser(username) {
  const user = state.users.find((item) => item.username === username);
  if (!user) return;
  if (username === state.currentOwner) {
    closeUserSwitcher();
    return;
  }

  invalidateListCaches();
  state.currentOwner = username;
  localStorage.setItem('wepo.owner', username);
  updateNavAvatar();
  resetListViewForOwnerChange();
  clearDetailViewForOwnerChange();

  closeUserSwitcher();

  if (state.view === 'data') {
    renderDataManager();
  } else {
    updateMobileChrome();
    await loadContacts(true);
  }
  toast(`已切换到 ${userDisplayName(user)}`);
}

/** 统计数据加千分位,避免千万级数字难以阅读 */
function formatStatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : String(value ?? '');
}

/** 打开退出登录确认弹窗 */
function openLogoutDialog() {
  const dialog = $('#logoutDialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  const cancel = $('#logoutCancelBtn');
  if (cancel) cancel.focus();
}

function closeLogoutDialog() {
  const dialog = $('#logoutDialog');
  if (dialog) dialog.classList.add('hidden');
  const btn = $('#logoutBtn');
  if (btn) btn.focus();
}

/** 清除登录相关的内存/本地缓存并回到 Secret 输入页 */
function performLogout() {
  try {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith('wepo.')) storage.removeItem(key);
      }
    }
  } catch (err) {
    /* 存储不可用时仍继续退出并刷新 */
  }
  // 清空当前内存中的账号/密钥状态;刷新会重建全部列表、搜索、统计缓存
  state.secret = '';
  state.currentOwner = '';
  state.users = [];
  state.searchCache.clear();
  state.listCache = { chats: null, contacts: null };
  state.dataCache = null;
  window.location.reload();
}

function bindLogoutButton() {
  const btn = $('#logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', openLogoutDialog);
}

function bindLogoutDialog() {
  const dialog = $('#logoutDialog');
  if (!dialog) return;
  $('#logoutCancelBtn').addEventListener('click', closeLogoutDialog);
  $('#logoutConfirmBtn').addEventListener('click', performLogout);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeLogoutDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dialog.classList.contains('hidden')) {
      closeLogoutDialog();
    }
  });
}

function dataContentHtml(cache) {
  if (!cache.hasBackups) {
    return '<div class="empty-tip" style="padding:8px 0 0">暂无数据,请使用桌面客户端导入备份</div>';
  }
  const totals = cache.totals || {};
  return `
    <div class="data-list">
      <div class="data-row"><span class="label">联系人</span><span class="value">${formatStatNumber(totals.contacts)}</span></div>
      <div class="data-row"><span class="label">聊天消息</span><span class="value">${formatStatNumber(totals.messages)}</span></div>
      <div class="data-row"><span class="label">媒体文件</span><span class="value">${formatStatNumber(totals.media)}</span></div>
    </div>`;
}

// ---------- “我”页 → 数据源(服务端 NAS 备份导入) ----------

function formatDataSourceDate(value) {
  if (!value) return '备份时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '备份时间未知';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function dataSourceItemStatus(item) {
  if (item.parseError) return { label: '无法读取', disabled: true, kind: 'error' };
  const job = state.serverImportJob;
  const active = serverImportJobActive(job);
  const importing = active && job && (
    (job.sourceKey && job.sourceKey === item.key)
    || (job.backupId && item.import && job.backupId === item.import.backupId)
  );
  if (importing) return { label: '导入中', disabled: true, kind: 'importing' };
  if (item.import && item.import.completedAt) {
    return { label: '已导入', disabled: true, kind: 'imported' };
  }
  if (active) return { label: '导入', disabled: true, kind: 'blocked' };
  if (item.import && item.import.incomplete) {
    return { label: '继续导入', disabled: false, kind: 'ready' };
  }
  return { label: '导入', disabled: false, kind: 'ready' };
}

function dataSourceItemMeta(item) {
  const bits = [];
  if (item.iosVersion) bits.push(`iOS ${item.iosVersion}`);
  bits.push(formatDataSourceDate(item.backupDate));
  const info = item.import;
  if (info) {
    if (info.incomplete) bits.push('未完成导入');
    else if (info.messageCount) bits.push(`${formatStatNumber(info.messageCount)} 条消息`);
  }
  return bits.join(' · ');
}

function dataSourceItemHtml(item) {
  const status = dataSourceItemStatus(item);
  const title = item.deviceName || item.folderName || item.key;
  const meta = dataSourceItemMeta(item);
  return `
    <div class="data-source-item data-source-item--${status.kind}">
      <div class="data-source-item-main">
        <div class="data-source-item-name">${esc(title)}</div>
        <div class="data-source-item-meta">${esc(meta)}</div>
        ${item.parseError
          ? `<div class="data-source-item-error">${esc(item.parseError)}</div>`
          : `<div class="data-source-item-key">${esc(item.folderName || item.key)}</div>`}
      </div>
      <button class="green-btn data-source-import-btn data-source-import-btn--${status.kind}"
              type="button" data-source-import-key="${esc(item.key)}"
              ${status.disabled ? 'disabled' : ''}>${esc(status.label)}</button>
    </div>`;
}

function dataSourceListHtml() {
  if (state.dataSourceLoading) {
    return '<div class="empty-tip data-source-empty"><span class="spinner"></span> 正在读取服务器备份...</div>';
  }
  if (state.dataSourceError) {
    return `<div class="empty-tip data-source-empty">${esc(state.dataSourceError)}</div>`;
  }
  if (!state.dataSourceItems.length) {
    return '<div class="empty-tip data-source-empty">服务器备份目录中没有找到有效的 iOS 备份</div>';
  }
  return `<div class="data-source-list">${state.dataSourceItems.map(dataSourceItemHtml).join('')}</div>`;
}

function dataSourceProgressHtml() {
  const job = state.serverImportJob;
  if (!job || !job.id || job.status === 'idle') return '';
  const active = serverImportJobActive(job);
  const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
  const recentlyFinished = Number.isFinite(finishedAt)
    && Date.now() - finishedAt < IMPORT_BANNER_VISIBLE_MS;
  // 刷新后的页面不再回放旧的完成进度;只有本次会话见过任务运行才展示。
  if (!active && !(state.serverImportSeenActive && recentlyFinished)) return '';
  const percent = active && job.percent !== null && job.percent !== undefined
    ? `${job.percent}%`
    : (job.status === 'completed' ? '100%' : '');
  const indeterminate = active && (job.percent === null || job.percent === undefined);
  const fillWidth = active
    ? (percent ? `${job.percent}%` : '')
    : (job.status === 'completed' ? '100%' : '0%');
  const device = [job.deviceName, job.iosVersion ? `iOS ${job.iosVersion}` : '']
    .filter(Boolean).join(' · ');
  return `
    <div class="data-source-progress" data-status="${esc(job.status)}">
      <div class="data-source-progress-head">
        <span class="data-source-progress-title">${esc(serverImportStatusTitle(job))}</span>
        <span class="data-source-progress-percent">${esc(percent)}</span>
      </div>
      ${device ? `<div class="data-source-progress-device">${esc(device)}</div>` : ''}
      <div class="server-import-track"><div class="data-source-progress-fill${indeterminate ? ' is-indeterminate' : ''}" style="width:${fillWidth}"></div></div>
      <div class="data-source-progress-text">${esc(
        active
          ? (job.text || '正在准备导入...')
          : (job.status === 'completed'
            ? `已导入 ${formatStatNumber((job.stats || {}).contactCount)} 个联系人、${formatStatNumber((job.stats || {}).messageCount)} 条消息`
            : (job.error || job.text || ''))
      )}</div>
    </div>`;
}

function renderDataSourcePage() {
  const el = $('#dataBody');
  if (!el) return;
  el.innerHTML = `
    <div class="settings-card data-source-page">
      <div class="data-source-head">
        <button class="data-source-refresh" id="dataSourceRefreshBtn" type="button">刷新</button>
      </div>
      <div class="data-source-root">${esc(
        state.dataSourceRoot
          ? `服务器备份目录：${state.dataSourceRoot}`
          : '正在读取服务器备份目录...'
      )}</div>
      <div id="dataSourceProgress">${dataSourceProgressHtml()}</div>
      <div id="dataSourceList">${dataSourceListHtml()}</div>
      <div class="data-source-tip">导入由 NAS 服务端执行，默认包含媒体文件；导入期间客户端可继续查看进度。</div>
    </div>`;
  const refreshBtn = $('#dataSourceRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadDataSourceItems());
  el.querySelectorAll('[data-source-import-key]').forEach((btn) => {
    btn.addEventListener('click', () => startDataSourceImport(btn.dataset.sourceImportKey));
  });
}

function updateDataSourceProgress() {
  const el = $('#dataSourceProgress');
  if (el) el.innerHTML = dataSourceProgressHtml();
}

function updateDataSourceButtons() {
  if (!state.dataSourceOpen) return;
  document.querySelectorAll('[data-source-import-key]').forEach((btn) => {
    const item = state.dataSourceItems.find((entry) => entry.key === btn.dataset.sourceImportKey);
    if (!item) return;
    const status = dataSourceItemStatus(item);
    btn.className = `green-btn data-source-import-btn data-source-import-btn--${status.kind}`;
    btn.textContent = status.label;
    btn.disabled = status.disabled;
  });
}

async function loadDataSourceItems({ silent = false } = {}) {
  const requestId = state.dataSourceRequestId + 1;
  state.dataSourceRequestId = requestId;
  if (!silent) {
    state.dataSourceLoading = true;
    state.dataSourceError = '';
    renderDataSourcePage();
  }
  try {
    const data = await api('/api/import/sources');
    if (requestId !== state.dataSourceRequestId || !state.dataSourceOpen) return;
    state.dataSourceRoot = String(data.root || '');
    state.dataSourceItems = Array.isArray(data.items) ? data.items : [];
    state.dataSourceError = data.exists === false
      ? String(data.error || '服务器备份目录不存在')
      : '';
  } catch (err) {
    if (requestId !== state.dataSourceRequestId || !state.dataSourceOpen) return;
    state.dataSourceItems = [];
    state.dataSourceError = err.message || '读取服务器备份目录失败';
  } finally {
    if (requestId === state.dataSourceRequestId && state.dataSourceOpen) {
      state.dataSourceLoading = false;
      renderDataSourcePage();
    }
  }
}

async function openDataSourcePage() {
  if (!state.secret) {
    showAuthOverlay('请先输入 Secret');
    return;
  }
  if (!state.dataSourceOpen && isMobileSinglePane() && !dataSourceHistoryPushed) {
    try {
      history.pushState({ wepoDataSource: true }, '', location.href);
      dataSourceHistoryPushed = true;
    } catch (err) {
      dataSourceHistoryPushed = false;
    }
  }
  state.dataSourceOpen = true;
  state.dataSourceItems = [];
  state.dataSourceRoot = '';
  state.dataSourceError = '';
  state.dataSourceLoading = true;
  renderDataSourcePage();
  updateMobileChrome();
  startServerImportPolling();
  await loadDataSourceItems();
}

function closeDataSourcePage(options = {}) {
  const fromHistory = options.fromHistory === true;
  if (!fromHistory && dataSourceHistoryPushed) {
    dataSourceHistoryPushed = false;
    armIgnoreNextPop();
    try {
      history.back();
    } catch (err) {
      consumeIgnoreNextPop();
    }
  }
  dataSourceHistoryPushed = false;
  if (!state.dataSourceOpen) return;
  state.dataSourceOpen = false;
  state.dataSourceItems = [];
  state.dataSourceRoot = '';
  state.dataSourceError = '';
  state.dataSourceLoading = false;
  state.dataSourceRequestId += 1;
  renderDataManager();
  updateMobileChrome();
}

async function startDataSourceImport(key) {
  if (!state.secret) {
    showAuthOverlay('请先输入 Secret');
    return;
  }
  if (serverImportJobActive()) {
    toast('服务器正在导入备份，请等待完成', true);
    return;
  }
  const item = state.dataSourceItems.find((entry) => entry.key === key);
  if (!item) return;
  const status = dataSourceItemStatus(item);
  if (status.disabled) return;
  try {
    const data = await api('/api/import/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: item.key, includeMedia: true }),
    });
    state.serverImportJob = data.job || null;
    state.serverImportSeenActive = true;
    renderDataSourcePage();
    renderServerImportBanner();
    startServerImportPolling();
    toast('已通知服务器开始导入');
  } catch (err) {
    toast(err.message || '启动服务器导入失败', true);
    startServerImportPolling();
    updateDataSourceButtons();
  }
}

function bindDataSourceEntry() {
  const entry = $('#dataSourceEntry');
  if (!entry) return;
  const open = () => openDataSourcePage();
  entry.addEventListener('click', open);
  entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

async function renderDataManager() {
  if (state.dataSourceOpen) {
    renderDataSourcePage();
    return;
  }
  const owner = state.currentOwner;
  const requestId = state.dataRequestId + 1;
  state.dataRequestId = requestId;
  const cached = state.dataCache && state.dataCache.owner === owner
    ? state.dataCache
    : null;
  const el = $('#dataBody');
  el.innerHTML = `${accountHtml()}${appearanceHtml()}
    <div class="settings-card data-source-entry" id="dataSourceEntry" role="button" tabindex="0">
      <div class="data-source-entry-main">
        <span class="settings-card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="10" cy="5.5" rx="8" ry="2.5"></ellipse>
            <path d="M2 5.5v4.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5.5"></path>
            <path d="M2 10v4.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V10"></path>
          </svg>
        </span>
        <span>数据源</span>
      </div>
      <span class="data-source-entry-arrow" aria-hidden="true">›</span>
    </div>
    <div class="settings-card data-card">
      <div class="settings-card-heading">
        <span class="settings-card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 18h16" stroke-width="1.6"></path>
            <rect x="4.2" y="13" width="2.8" height="5" rx="1.4" fill="currentColor" stroke="none"></rect>
            <rect x="8.6" y="4" width="2.8" height="14" rx="1.4" fill="currentColor" stroke="none"></rect>
            <rect x="13" y="8" width="2.8" height="10" rx="1.4" fill="currentColor" stroke="none"></rect>
          </svg>
        </span>
        <h3>已导入数据</h3>
      </div>
      <div id="dataContent">${
        cached ? dataContentHtml(cached) : '<div class="empty-tip">正在统计导入数据...</div>'
      }</div>
    </div>
    <button id="logoutBtn" class="logout-btn" type="button">退出登录</button>`;
  bindAccountCard();
  bindAppearance();
  bindDataSourceEntry();
  bindLogoutButton();
  if (cached) return;

  const content = $('#dataContent');
  try {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    params.set('summary', '1');
    const data = await api(`/api/stats?${params}`);
    if (requestId !== state.dataRequestId || owner !== state.currentOwner) return;
    const cache = {
      owner,
      hasBackups: Array.isArray(data.backups) && data.backups.length > 0,
      totals: data.totals || {},
    };
    state.dataCache = cache;
    content.innerHTML = dataContentHtml(cache);
  } catch (err) {
    if (requestId === state.dataRequestId && owner === state.currentOwner) {
      content.innerHTML = `<div class="empty-tip">${esc(err.message || '加载失败')}</div>`;
    }
  }
}

// ---------- 事件绑定 ----------

function bindNav() {
  document.querySelectorAll('.nav-btn, .tab-item').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  $('#mobileBackBtn').addEventListener('click', () => {
    if (state.chatContactDetailOpen) closeChatContactDetail();
    else if (state.view === 'data' && state.dataSourceOpen) closeDataSourcePage();
    else if (state.dateJumpOpen) handleDateJumpBack();
    else if (state.chatFromContactDetail && state.view === 'chats') handleChatFromContactBack();
    else if ($('#app').classList.contains('detail-open')) closeDetail();
    else if (state.contactSubpage) backContactSubpage();
  });
  const dataPanelBackBtn = $('#dataPanelBackBtn');
  if (dataPanelBackBtn) dataPanelBackBtn.addEventListener('click', closeDataSourcePage);
  const chatBackBtn = $('#chatDateJumpBackBtn');
  if (chatBackBtn) {
    chatBackBtn.addEventListener('click', () => {
      if (state.dateJumpOpen) handleDateJumpBack();
      else if (state.chatFromContactDetail) handleChatFromContactBack();
    });
  }
  $('#userSwitcherClose').addEventListener('click', closeUserSwitcher);
  $('#userSwitcher').addEventListener('click', (event) => {
    if (event.target.id === 'userSwitcher') closeUserSwitcher();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#userSwitcher').classList.contains('hidden')) {
      closeUserSwitcher();
    }
  });
  updateNavAvatar();
}

let listSearchTimer = null;
const SEARCH_DEBOUNCE_MS = 200;
let chatSearchPageTimer = null;

function updateListSearchClear() {
  const input = $('#searchBox');
  const btn = $('#listSearchClearBtn');
  if (!input || !btn) return;
  btn.classList.toggle('hidden', !input.value);
}

/** 清空列表面板搜索状态;tab 切换和清空按钮共用 */
function clearListSearch() {
  clearTimeout(listSearchTimer);
  const input = $('#searchBox');
  if (input) input.value = '';
  state.contactsSearch = '';
  if (state.searchMode === 'inline') {
    exitInlineSearch({ clearInput: true });
  } else {
    updateSearchPlaceholder();
    updateListSearchClear();
  }
  state.contactsLoading = false;
  state.contactsHasMore = false;
  updateListLoading();
}

function bindListEvents() {
  const input = $('#searchBox');
  const clearBtn = $('#listSearchClearBtn');
  const backBtn = $('#listBackBtn');

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (state.searchMode === 'inline' && state.searchPage) closeSearchCategory();
    });
  }

  const subpageBackBtn = $('#contactSubpageBackBtn');
  if (subpageBackBtn) subpageBackBtn.addEventListener('click', backContactSubpage);
  const subpageBody = $('#contactSubpageBody');
  if (subpageBody) {
    subpageBody.addEventListener('scroll', () => {
      if (subpageBody.scrollHeight - subpageBody.scrollTop - subpageBody.clientHeight < 180) {
        loadMoreContactSubpage();
      }
    });
  }

  // 移动端会话列表搜索框只作为独立搜索页入口;PC/分栏留在列表内搜索
  const openMobileListSearch = () => {
    if (state.view !== 'chats' || state.searchOverlayOpen || state.chatSearchPageOpen) return;
    if (isMobileSinglePane()) openSearchOverlay(input.value.trim());
  };
  input.addEventListener('focus', openMobileListSearch);
  input.addEventListener('click', openMobileListSearch);

  input.addEventListener('input', () => {
    if (state.view === 'contacts') {
      // 通讯录页保留就地好友搜索
      updateListSearchClear();
      clearTimeout(listSearchTimer);
      listSearchTimer = setTimeout(() => {
        state.contactsSearch = input.value.trim();
        loadContacts(true);
      }, 300);
      return;
    }
    if (state.view !== 'chats') return;

    if (isMobileSinglePane()) {
      openSearchOverlay(input.value.trim());
      return;
    }

    updateListSearchClear();
    clearTimeout(listSearchTimer);
    listSearchTimer = setTimeout(() => {
      if (state.view !== 'chats' || isMobileSinglePane()) return;
      const query = input.value.trim();
      if (query) {
        startInlineSearch(query);
      } else {
        if (state.searchMode === 'inline') exitInlineSearch({ clearInput: false });
        loadContacts(true);
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  clearBtn.addEventListener('click', () => {
    const isMobileChats = state.view === 'chats' && isMobileSinglePane();
    clearListSearch();
    if (!isMobileChats) {
      loadContacts(true);
      input.focus();
    }
  });

  window.addEventListener('resize', () => {
    const searchView = $('#searchPageView');
    if (searchView) searchView.classList.toggle('search-page--fullscreen', state.searchOverlayOpen && isMobileSinglePane());
    const chatSearchView = $('#chatSearchPageView');
    if (chatSearchView) {
      chatSearchView.classList.toggle(
        'chat-search-page--fullscreen',
        state.chatSearchPageOpen && isMobileSinglePane()
      );
    }
  });

  updateListSearchClear();
}

let searchPageTimer = null;

/** 搜索页内的事件:输入、清空、返回、分类页滚动加载 */
function bindSearchPageEvents() {
  const input = $('#searchPageInput');
  const clearBtn = $('#searchPageClearBtn');
  const backBtn = $('#searchPageBackBtn');
  const body = $('#searchPageBody');
  const inlineBody = $('#contactList');

  // 全局搜索分类页(独立搜索页或 PC 列表内搜索)也做滚动活动跟踪;
  // 分页结果只在滚动停止后追加,避免与惯性滚动叠加造成闪屏。
  const setSearchScrollPointer = (active) => {
    const page = state.searchPage;
    if (page) page.scrollPointerActive = active;
  };
  [body, inlineBody].forEach((el) => {
    if (!el) return;
    el.addEventListener('pointerdown', () => setSearchScrollPointer(true), { passive: true });
    el.addEventListener('touchstart', () => setSearchScrollPointer(true), { passive: true });
    el.addEventListener('pointerup', () => setSearchScrollPointer(false), { passive: true });
    el.addEventListener('pointercancel', () => setSearchScrollPointer(false), { passive: true });
    el.addEventListener('touchend', () => setSearchScrollPointer(false), { passive: true });
    el.addEventListener('touchcancel', () => setSearchScrollPointer(false), { passive: true });
    el.addEventListener('wheel', () => {
      const page = state.searchPage;
      if (page) page.wheelUntil = performance.now() + 160;
    }, { passive: true });
    el.addEventListener('scroll', () => {
      const page = state.searchPage;
      if (page) page.lastScrollAt = performance.now();
    }, { passive: true });
  });

  input.addEventListener('input', () => {
    updateSearchPageClear();
    state.searchRequestId += 1;
    state.searchPageRequestId += 1;
    clearTimeout(searchPageTimer);
    searchPageTimer = setTimeout(() => {
      const nextSearch = input.value.trim();
      state.searchQuery = nextSearch;
      state.selectedMessageId = null;
      state.pendingMessageFocusId = null;

      if (!nextSearch) {
        if (state.searchPage) {
          state.searchPage.query = '';
          state.searchPage.items = [];
          state.searchPage.page = 0;
          state.searchPage.hasMore = false;
          state.searchPage.loading = false;
          state.searchPage.error = '';
          if (state.searchPage.section !== 'messages') state.searchPage.total = 0;
          if (body) body.scrollTop = 0;
          renderSearchPage();
          if (state.searchHistoryDepth >= 2) history.back();
          else closeSearchCategory();
        } else {
          state.searchResults = null;
          state.searchLoading = false;
          if (body) body.scrollTop = 0;
          renderSearchResults();
        }
        return;
      }

      if (state.searchPage) {
        state.searchPage.query = nextSearch;
        state.searchPage.items = [];
        state.searchPage.page = 0;
        state.searchPage.hasMore = true;
        state.searchPage.error = '';
        if (state.searchPage.section !== 'messages') state.searchPage.total = 0;
        if (body) body.scrollTop = 0;
        loadSearchPage(true);
        return;
      }

      state.searchResults = null;
      state.searchLoading = false;
      if (body) body.scrollTop = 0;
      loadSearchResults();
    }, SEARCH_DEBOUNCE_MS);
  });

  clearBtn.addEventListener('click', () => {
    clearTimeout(searchPageTimer);
    input.value = '';
    updateSearchPageClear();
    state.searchQuery = '';
    state.selectedMessageId = null;
    state.pendingMessageFocusId = null;
    state.searchRequestId += 1;
    state.searchPageRequestId += 1;

    if (state.searchPage) {
      state.searchPage.query = '';
      state.searchPage.items = [];
      state.searchPage.page = 0;
      state.searchPage.hasMore = false;
      state.searchPage.loading = false;
      state.searchPage.error = '';
      if (state.searchPage.section !== 'messages') state.searchPage.total = 0;
      if (body) body.scrollTop = 0;
      renderSearchPage();
      if (state.searchHistoryDepth >= 2) history.back();
      else closeSearchCategory();
    } else {
      state.searchResults = null;
      state.searchLoading = false;
      if (body) body.scrollTop = 0;
      renderSearchResults();
    }
    input.focus();
  });

  backBtn.addEventListener('click', handleSearchPageBack);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') handleSearchPageBack();
  });

  body.addEventListener('scroll', () => {
    const page = state.searchPage;
    if (!state.searchOverlayOpen || !page || page.loading || !page.hasMore) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 180) {
      loadSearchPage(false);
    }
  }, { passive: true });
}

/** 列表滚动到边界时自动加载下一页 */
function bindInfiniteScroll() {
  let contactsScheduled = false;
  const contactList = $('#contactList');
  contactList.addEventListener('scroll', () => {
    if (contactsScheduled) return;
    contactsScheduled = true;
    setTimeout(() => {
      contactsScheduled = false;
      const nearBottom = contactList.scrollHeight - contactList.scrollTop - contactList.clientHeight < 180;
      if (state.searchMode === 'inline') {
        const page = state.searchPage;
        if (page && !page.loading && page.hasMore && nearBottom) loadSearchPage(false);
        return;
      }
      if (state.contactsLoading || !state.contactsHasMore) return;
      if (nearBottom) loadContacts(false);
    }, 60);
  }, { passive: true });

  let messagesScheduled = false;
  const messageArea = $('#messageArea');
  let messageGestureActive = false;
  // 加载完一页后，需要一次新的触摸/滚轮/指针操作才能再加载，避免惯性滚动连续翻页。
  // 新触摸手势允许在顶部再次下拉;滚轮必须先把位置离开顶部才重新武装。
  const armMessageLoading = (fromGesture = false) => {
    if (state.messagesLoading || state.messagesRestoringScroll) return;
    if (!fromGesture && messageArea.scrollTop <= MESSAGE_REARM_DISTANCE) return;
    if (state.messageHasMore) state.messagesLoadArmed = true;
    if (state.messageDateMode && state.messageHasNewer) state.messagesNewerArmed = true;
  };
  const beginMessageGesture = () => {
    state.messagesPointerActive = true;
    // 用户主动开始新手势时,停止上一页加载后的滚动锚点恢复,允许立即滚动。
    if (state.messagesRestoringScroll) {
      state.messagesScrollRestoreToken += 1;
      state.messagesRestoringScroll = false;
      state.messagesLayoutAnchor = null;
    }
    messageGestureActive = true;
    if (!state.messagesLoading) {
      state.messagesOlderLoadLocked = false;
    }
    armMessageLoading(true);
  };
  const endMessageGesture = () => {
    messageGestureActive = false;
    state.messagesPointerActive = false;
  };
  let lastWheelAt = 0;
  messageArea.addEventListener('touchstart', beginMessageGesture, { passive: true });
  messageArea.addEventListener('pointerdown', beginMessageGesture, { passive: true });
  messageArea.addEventListener('touchend', endMessageGesture, { passive: true });
  messageArea.addEventListener('touchcancel', endMessageGesture, { passive: true });
  messageArea.addEventListener('pointerup', endMessageGesture, { passive: true });
  messageArea.addEventListener('pointercancel', endMessageGesture, { passive: true });
  messageArea.addEventListener('wheel', () => {
    if (messageGestureActive) return;
    const now = Date.now();
    state.messagesWheelUntil = now + 160;
    const newBurst = now - lastWheelAt > MESSAGE_WHEEL_GAP;
    lastWheelAt = now;
    if (!newBurst) return;
    if (messageArea.scrollTop <= MESSAGE_REARM_DISTANCE) return;
    if (!state.messagesLoading && !state.messagesRestoringScroll) {
      state.messagesOlderLoadLocked = false;
    }
    armMessageLoading(false);
  }, { passive: true });

  messageArea.addEventListener('scroll', () => {
    state.messagesLastScrollAt = performance.now();
  }, { passive: true });

  let layoutAnchorScheduled = false;
  messageArea.addEventListener('scroll', () => {
    if (layoutAnchorScheduled || state.messagesRestoringScroll) return;
    layoutAnchorScheduled = true;
    setTimeout(() => {
      layoutAnchorScheduled = false;
      updateMessagesLayoutAnchorFromViewport();
    }, 100);
  }, { passive: true });

  messageArea.addEventListener('scroll', () => {
    if (messagesScheduled) return;
    messagesScheduled = true;
    setTimeout(() => {
      messagesScheduled = false;
      if (state.messagesLoading || state.messagesRestoringScroll || state.messagesOlderLoadLocked || !state.messageHasMore) return;
      const scrollTop = messageArea.scrollTop;
      if (!state.messagesLoadArmed) {
        // 滚动条/键盘等没有手势事件时，向下离开顶部区域也视为重新开始
        if (scrollTop <= MESSAGE_REARM_DISTANCE || scrollTop <= state.messagesLastScrollTop) {
          state.messagesLastScrollTop = scrollTop;
          return;
        }
        state.messagesLoadArmed = true;
      }
      state.messagesLastScrollTop = scrollTop;
      if (scrollTop < MESSAGE_LOAD_TOP) {
        if (state.messageDateMode) loadOlderDateWindowMessages();
        else loadMessages(false);
      }
    }, 60);
  }, { passive: true });

  // 日期窗口模式:滑到底部继续加载更新的消息
  let newerScheduled = false;
  messageArea.addEventListener('scroll', () => {
    if (!state.messageDateMode || newerScheduled) return;
    newerScheduled = true;
    setTimeout(() => {
      newerScheduled = false;
      if (!state.messageDateMode || state.messagesLoading || state.messagesRestoringScroll) return;
      const nearBottom = messageArea.scrollHeight - messageArea.scrollTop
        - messageArea.clientHeight < MESSAGE_LOAD_BOTTOM;
      if (!nearBottom) {
        if (state.messageHasNewer) state.messagesNewerArmed = true;
        return;
      }
      if (!state.messagesNewerArmed || !state.messageHasNewer) return;
      state.messagesNewerArmed = false;
      loadNewerDateWindowMessages();
    }, 60);
  }, { passive: true });
}

function bindChatEvents() {
  // 链接卡强制在新窗口/新标签页打开;普通左键交给 window.open,
  // 带修饰键或中键的点击保留浏览器默认行为。
  document.addEventListener('click', (e) => {
    const link = e.target && e.target.closest
      ? e.target.closest('a.msg-card--link[href]')
      : null;
    if (!link) return;
    if (e.defaultPrevented || e.button !== 0
      || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  });

  // 语音卡片点击播放/暂停,不依赖浏览器原生 audio 控件
  const messageList = $('#messageList');
  messageList.addEventListener('click', (e) => {
    const voice = e.target.closest && e.target.closest('.msg-voice');
    if (voice) {
      e.preventDefault();
      toggleVoiceCard(voice);
      return;
    }
    if (e.target.classList.contains('msg-image')) {
      openImageViewer(e.target.src);
      return;
    }
    const card = e.target.closest && e.target.closest('.msg-card--record[data-chat-record-message-id]');
    if (!card) return;
    const row = card.closest('.msg-row');
    const id = row ? Number(row.dataset.messageId) : Number(card.dataset.chatRecordMessageId);
    const message = state.messages.find((item) => Number(item.id) === id);
    if (!message) return;
    e.preventDefault();
    openChatRecordDetail(message);
  });
  messageList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const voice = e.target.closest && e.target.closest('.msg-voice');
    if (voice) {
      e.preventDefault();
      toggleVoiceCard(voice);
      return;
    }
    const card = e.target.closest && e.target.closest('.msg-card--record[data-chat-record-message-id]');
    if (!card) return;
    e.preventDefault();
    const row = card.closest('.msg-row');
    const id = row ? Number(row.dataset.messageId) : Number(card.dataset.chatRecordMessageId);
    const message = state.messages.find((item) => Number(item.id) === id);
    if (message) openChatRecordDetail(message);
  });
  const syncVoiceCardState = (event) => {
    const audio = event.target;
    if (!audio || !audio.classList || !audio.classList.contains('msg-voice-audio')) return;
    const card = audio.closest('.msg-voice');
    if (!card) return;
    if (event.type === 'play') {
      messageList.querySelectorAll('audio.msg-voice-audio').forEach((other) => {
        if (other !== audio) other.pause();
      });
      messageList.querySelectorAll('.msg-voice.is-playing').forEach((other) => {
        if (other !== card) other.classList.remove('is-playing');
      });
      card.classList.remove('is-error');
      card.classList.add('is-playing');
      card.setAttribute('aria-pressed', 'true');
    } else {
      card.classList.remove('is-playing');
      card.setAttribute('aria-pressed', 'false');
      if (event.type === 'error') card.classList.add('is-error');
    }
  };
  ['play', 'pause', 'ended', 'error'].forEach((type) => {
    messageList.addEventListener(type, syncVoiceCardState, true);
  });
  const chatRecordBack = $('#chatRecordDetailBackBtn');
  if (chatRecordBack) {
    chatRecordBack.addEventListener('click', navigateBackChatRecordDetail);
  }
  const recordBody = $('#chatRecordDetailBody');
  if (recordBody) {
    recordBody.addEventListener('click', (e) => {
      const nested = e.target.closest && e.target.closest('.chat-record-nested-record-card[data-chat-record-nested-index]');
      if (nested) {
        e.preventDefault();
        openNestedChatRecord(Number(nested.dataset.chatRecordNestedIndex));
        return;
      }
      const img = e.target.closest && e.target.closest('img.chat-record-image');
      if (!img) return;
      openImageViewer(img.dataset.fullSrc || img.src);
    });
    recordBody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const nested = e.target.closest && e.target.closest('.chat-record-nested-record-card[data-chat-record-nested-index]');
      if (!nested) return;
      e.preventDefault();
      openNestedChatRecord(Number(nested.dataset.chatRecordNestedIndex));
    });
    const markMediaLoaded = (target) => {
      const frame = target && target.closest ? target.closest('.chat-record-media-frame') : null;
      if (frame) frame.classList.add('is-loaded');
    };
    recordBody.addEventListener('load', (e) => markMediaLoaded(e.target), true);
    recordBody.addEventListener('loadeddata', (e) => markMediaLoaded(e.target), true);
    recordBody.addEventListener('error', (e) => {
      const target = e.target;
      if (!target || !target.classList) return;
      const frame = target.closest ? target.closest('.chat-record-media-frame') : null;
      if (frame) {
        frame.classList.remove('is-loaded');
        target.style.display = 'none';
      }
    }, true);
  }
  // 表情 CDN 失败时退回文字占位
  $('#messageList').addEventListener('error', (e) => {
    const img = e.target;
    if (!img || !img.classList) return;
    if (img.classList.contains('msg-card-cover-img')) {
      const fallback = img.getAttribute('data-fallback-src');
      if (fallback) {
        img.removeAttribute('data-fallback-src');
        img.src = fallback;
        return;
      }
      const cover = img.closest('.miniapp-card-cover');
      if (cover) cover.remove();
      return;
    }
    if (img.classList.contains('link-card-thumb-img')) {
      const fallback = img.getAttribute('data-fallback-src');
      if (fallback) {
        img.removeAttribute('data-fallback-src');
        img.src = fallback;
        return;
      }
      const thumb = img.closest('.link-card-thumb');
      if (thumb) thumb.remove();
      else img.remove();
      return;
    }
    if (!img.classList.contains('msg-emoji')) return;
    const fallback = document.createElement('span');
    fallback.className = 'msg-emoji-fallback';
    fallback.textContent = '[表情]';
    img.replaceWith(fallback);
  }, true);

  bindQuoteLongPress();
  const quoteReturnBtn = $('#quoteReturnBtn');
  if (quoteReturnBtn) {
    quoteReturnBtn.addEventListener('click', handleQuoteReturnClick);
  }
}

/** 会话内搜索页:入口、输入、清空、取消、滚动加载和过滤条 */
// 链接/位置分类长按菜单
let chatSearchLongPressTimer = null;
let chatSearchLongPressStart = null;
let chatSearchLongPressTriggered = false;
let chatSearchSuppressClickUntil = 0;
let chatSearchContextMessageId = 0;
let chatSearchContextAction = null;
let chatSearchContextMenuEl = null;
let chatSearchContextBackdropEl = null;

function ensureChatSearchContextMenu() {
  if (chatSearchContextMenuEl) return;
  chatSearchContextBackdropEl = document.createElement('div');
  chatSearchContextBackdropEl.className = 'chat-search-context-backdrop hidden';
  chatSearchContextBackdropEl.addEventListener('pointerdown', hideChatSearchContextMenu, { passive: true });

  chatSearchContextMenuEl = document.createElement('div');
  chatSearchContextMenuEl.className = 'chat-search-context-menu hidden';
  chatSearchContextMenuEl.setAttribute('role', 'menu');
  chatSearchContextMenuEl.innerHTML = `
    <button type="button" role="menuitem">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"></circle>
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
      </svg>
      <span class="chat-search-context-label">定位到聊天位置</span>
    </button>`;
  chatSearchContextMenuEl.querySelector('button').addEventListener('click', () => {
    const action = chatSearchContextAction;
    const messageId = chatSearchContextMessageId;
    hideChatSearchContextMenu();
    if (action) action();
    else if (messageId) openChatMessageWindow(messageId);
  });
  document.body.append(chatSearchContextBackdropEl, chatSearchContextMenuEl);
}

function hideChatSearchContextMenu() {
  chatSearchContextMessageId = 0;
  chatSearchContextAction = null;
  if (chatSearchContextMenuEl) {
    chatSearchContextMenuEl.classList.add('hidden');
    chatSearchContextMenuEl.classList.remove(
      'chat-search-context-menu--above',
      'chat-search-context-menu--below'
    );
  }
  if (chatSearchContextBackdropEl) chatSearchContextBackdropEl.classList.add('hidden');
}

function showChatSearchContextMenu(messageId, clientX, clientY, options = {}) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return;
  ensureChatSearchContextMenu();
  chatSearchContextMessageId = id;
  chatSearchContextAction = typeof options.onSelect === 'function' ? options.onSelect : null;
  const menu = chatSearchContextMenuEl;
  const label = menu.querySelector('.chat-search-context-label');
  if (label) label.textContent = options.label || '定位到聊天位置';
  const backdrop = chatSearchContextBackdropEl;
  backdrop.classList.remove('hidden');
  menu.classList.remove('hidden');

  const margin = 8;
  const gap = 8;
  const width = menu.offsetWidth || 156;
  const height = menu.offsetHeight || 44;
  const x = Number(clientX) || 0;
  const y = Number(clientY) || 0;
  const anchor = options.anchor && document.contains(options.anchor)
    ? options.anchor
    : null;
  const rect = anchor ? anchor.getBoundingClientRect() : null;
  const centerX = rect ? rect.left + rect.width / 2 : x;
  const anchorTop = rect ? rect.top : y;
  const anchorBottom = rect ? rect.bottom : y;
  const left = Math.min(
    Math.max(margin, centerX - width / 2),
    window.innerWidth - width - margin
  );
  // 优先放在元素上方;顶部空间不足时放在元素下方
  let above = anchorTop - margin >= height + gap;
  let top = above ? anchorTop - height - gap : anchorBottom + gap;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }
  if (top < margin) top = margin;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.setProperty(
    '--arrow-x',
    `${Math.round(Math.min(Math.max(16, centerX - left), width - 16))}px`
  );
  menu.classList.toggle('chat-search-context-menu--above', above);
  menu.classList.toggle('chat-search-context-menu--below', !above);
}

function cancelChatSearchLongPress() {
  clearTimeout(chatSearchLongPressTimer);
  chatSearchLongPressTimer = null;
  chatSearchLongPressStart = null;
}

function endChatSearchLongPress() {
  const triggered = chatSearchLongPressTriggered;
  chatSearchLongPressTriggered = false;
  cancelChatSearchLongPress();
  if (triggered) chatSearchSuppressClickUntil = Date.now() + 500;
}

function bindChatSearchLongPress() {
  const content = $('#chatSearchPageContent');
  const body = $('#chatSearchPageBody');
  if (!content) return;

  content.addEventListener('pointerdown', (event) => {
    if (!state.chatSearchPageOpen || state.dateJumpOpen) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const item = event.target && event.target.closest
      ? event.target.closest('[data-chat-search-message-id]')
      : null;
    if (!item) return;
    // 关键词结果点击即定位到聊天位置,不再提供长按定位菜单。
    if (item.hasAttribute('data-chat-search-index')) return;
    cancelChatSearchLongPress();
    chatSearchLongPressStart = {
      x: event.clientX,
      y: event.clientY,
      messageId: Number(item.dataset.chatSearchMessageId),
      anchor: item,
    };
    chatSearchLongPressTimer = setTimeout(() => {
      const start = chatSearchLongPressStart;
      chatSearchLongPressStart = null;
      chatSearchLongPressTimer = null;
      if (!start || !start.messageId) return;
      chatSearchLongPressTriggered = true;
      if (navigator.vibrate) navigator.vibrate(8);
      showChatSearchContextMenu(start.messageId, start.x, start.y, { anchor: start.anchor });
    }, 500);
  }, { passive: true });

  document.addEventListener('pointermove', (event) => {
    const start = chatSearchLongPressStart;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelChatSearchLongPress();
    }
  }, { passive: true });
  document.addEventListener('pointerup', endChatSearchLongPress, { passive: true });
  document.addEventListener('pointercancel', endChatSearchLongPress, { passive: true });

  // 长按弹出菜单后阻止随后的 click 打开结果/图片
  content.addEventListener('click', (event) => {
    if (Date.now() >= chatSearchSuppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  content.addEventListener('contextmenu', (event) => {
    if (!state.chatSearchPageOpen || state.dateJumpOpen) return;
    const item = event.target && event.target.closest
      ? event.target.closest('[data-chat-search-message-id]')
      : null;
    if (!item) return;
    // 关键词结果的点击行为已经是定位,右键/长按菜单仅保留给分类列表。
    if (item.hasAttribute('data-chat-search-index')) return;
    event.preventDefault();
    cancelChatSearchLongPress();
    showChatSearchContextMenu(
      Number(item.dataset.chatSearchMessageId),
      event.clientX,
      event.clientY,
      { anchor: item }
    );
  });

  if (body) {
    body.addEventListener('scroll', () => {
      cancelChatSearchLongPress();
      hideChatSearchContextMenu();
    }, { passive: true });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideChatSearchContextMenu();
  });
  window.addEventListener('resize', hideChatSearchContextMenu);
}

// 引用消息长按/右键菜单
let quoteLongPressTimer = null;
let quoteLongPressStart = null;

function cancelQuoteLongPress() {
  clearTimeout(quoteLongPressTimer);
  quoteLongPressTimer = null;
  quoteLongPressStart = null;
}

function quoteRefMessageId(refEl) {
  const row = refEl && refEl.closest
    ? refEl.closest('.msg-row[data-message-id]')
    : null;
  const id = row ? Number(row.dataset.messageId) : 0;
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function showQuoteContextMenu(refEl, clientX, clientY) {
  const messageId = quoteRefMessageId(refEl);
  if (!messageId) return;
  showChatSearchContextMenu(messageId, clientX, clientY, {
    label: '定位到原文位置',
    onSelect: () => locateQuotedMessage(messageId),
    anchor: refEl,
  });
}

function bindQuoteLongPress() {
  const list = $('#messageList');
  const area = $('#messageArea');
  if (!list) return;

  list.addEventListener('pointerdown', (event) => {
    if (state.chatSearchPageOpen || state.dateJumpOpen) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const ref = event.target && event.target.closest
      ? event.target.closest('.msg-quote-ref')
      : null;
    if (!ref) return;
    cancelQuoteLongPress();
    quoteLongPressStart = { x: event.clientX, y: event.clientY, ref };
    quoteLongPressTimer = setTimeout(() => {
      const start = quoteLongPressStart;
      quoteLongPressStart = null;
      quoteLongPressTimer = null;
      if (!start || !start.ref || !document.contains(start.ref)) return;
      if (navigator.vibrate) navigator.vibrate(8);
      showQuoteContextMenu(start.ref, start.x, start.y);
    }, 500);
  }, { passive: true });

  document.addEventListener('pointermove', (event) => {
    const start = quoteLongPressStart;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelQuoteLongPress();
    }
  }, { passive: true });
  document.addEventListener('pointerup', cancelQuoteLongPress, { passive: true });
  document.addEventListener('pointercancel', cancelQuoteLongPress, { passive: true });

  list.addEventListener('contextmenu', (event) => {
    if (state.chatSearchPageOpen || state.dateJumpOpen) return;
    const ref = event.target && event.target.closest
      ? event.target.closest('.msg-quote-ref')
      : null;
    if (!ref) return;
    event.preventDefault();
    cancelQuoteLongPress();
    showQuoteContextMenu(ref, event.clientX, event.clientY);
  });

  if (area) {
    area.addEventListener('scroll', () => {
      cancelQuoteLongPress();
      hideChatSearchContextMenu();
      maybeHideQuoteLoadedReturnButton();
    }, { passive: true });
  }
}

function bindChatSearchEvents() {
  const openBtn = $('#chatSearchOpenBtn');
  const mobileOpenBtn = $('#mobileChatSearchBtn');
  const input = $('#chatSearchPageInput');
  const clearBtn = $('#chatSearchPageClearBtn');
  const cancelBtn = $('#chatSearchPageCancelBtn');
  const body = $('#chatSearchPageBody');
  const filterClearBtn = $('#chatSearchFilterClearBtn');

  const openCurrentChatSearch = () => openChatSearchPage(state.chatSearch || '');
  if (openBtn) openBtn.addEventListener('click', openCurrentChatSearch);
  if (mobileOpenBtn) mobileOpenBtn.addEventListener('click', openCurrentChatSearch);
  if (filterClearBtn) filterClearBtn.addEventListener('click', clearChatSearchFilter);

  const contactDetailBtn = $('#chatContactDetailBtn');
  const mobileContactDetailBtn = $('#mobileContactDetailBtn');
  const contactDetailBackBtn = $('#chatContactDetailBackBtn');
  if (contactDetailBtn) contactDetailBtn.addEventListener('click', openChatContactDetail);
  if (mobileContactDetailBtn) mobileContactDetailBtn.addEventListener('click', openChatContactDetail);
  if (contactDetailBackBtn) contactDetailBackBtn.addEventListener('click', () => closeChatContactDetail());

  input.addEventListener('input', () => {
    if (!state.chatSearchPageOpen) return;
    updateChatSearchPageClear();
    clearTimeout(chatSearchPageTimer);
    state.chatSearchPageRequestId += 1;
    const page = state.chatSearchPage;
    if (page) {
      page.loading = false;
      page.datesRequestId += 1;
      page.groupMembersRequestId += 1;
    }
    chatSearchPageTimer = setTimeout(() => {
      const current = state.chatSearchPage;
      if (!state.chatSearchPageOpen || !current) return;
      const query = input.value.trim();
      current.query = query;
      current.category = null;
      current.categoryLabel = '';
      current.selectedDate = '';
      current.selectedMember = null;
      current.items = [];
      current.total = 0;
      current.page = 0;
      current.hasMore = Boolean(query);
      current.loading = false;
      current.error = '';
      const scrollBody = $('#chatSearchPageBody');
      if (scrollBody) scrollBody.scrollTop = 0;
      if (!query) {
        renderChatSearchPage();
        return;
      }
      loadChatSearchPage(true);
    }, 300);
  });

  clearBtn.addEventListener('click', () => {
    clearTimeout(chatSearchPageTimer);
    state.chatSearchPageRequestId += 1;
    input.value = '';
    updateChatSearchPageClear();
    const page = state.chatSearchPage;
    if (page) {
      page.query = '';
      page.category = null;
      page.categoryLabel = '';
      page.selectedDate = '';
      page.selectedMember = null;
      page.datesRequestId += 1;
      page.groupMembersRequestId += 1;
      page.items = [];
      page.total = 0;
      page.page = 0;
      page.hasMore = false;
      page.loading = false;
      page.error = '';
    }
    if (body) body.scrollTop = 0;
    renderChatSearchPage();
    input.focus();
  });

  cancelBtn.addEventListener('click', () => closeChatSearchPage({ restoreMessagePage: true }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeChatSearchPage({ restoreMessagePage: true });
  });

  const trackChatSearchPointer = (active) => {
    const current = state.chatSearchPage;
    if (current) current.scrollPointerActive = active;
  };
  // 一次新的触摸/滚轮手势重新武装上一月加载。不能只看 scrollTop>220:
  // 月度内容只比视口略高时，滚到顶部也到不了 220，会导致再也加载不出更早月份。
  const armChatSearchGalleryByGesture = () => {
    const current = state.chatSearchPage;
    if (!state.chatSearchPageOpen || !current || current.category !== 'image_video') return;
    if (current.loading || current.galleryScrollLocked) return;
    current.galleryLoadArmed = true;
  };
  let lastChatSearchGalleryWheelAt = 0;
  const beginChatSearchPointer = () => {
    trackChatSearchPointer(true);
    armChatSearchGalleryByGesture();
  };
  body.addEventListener('pointerdown', beginChatSearchPointer, { passive: true });
  body.addEventListener('touchstart', beginChatSearchPointer, { passive: true });
  body.addEventListener('pointerup', () => trackChatSearchPointer(false), { passive: true });
  body.addEventListener('pointercancel', () => trackChatSearchPointer(false), { passive: true });
  body.addEventListener('touchend', () => trackChatSearchPointer(false), { passive: true });
  body.addEventListener('touchcancel', () => trackChatSearchPointer(false), { passive: true });
  body.addEventListener('wheel', () => {
    const current = state.chatSearchPage;
    if (!current) return;
    current.wheelUntil = performance.now() + 160;
    if (current.category !== 'image_video' || current.loading || current.galleryScrollLocked) return;
    const now = performance.now();
    if (now - lastChatSearchGalleryWheelAt > 250) {
      current.galleryLoadArmed = true;
    }
    lastChatSearchGalleryWheelAt = now;
  }, { passive: true });

  body.addEventListener('scroll', (event) => {
    const page = state.chatSearchPage;
    if (!state.chatSearchPageOpen || !page) return;
    page.lastScrollAt = performance.now();
    if (page.category === 'image_video') {
      // 图片/视频:在顶部向下拉时加载更早的一页。
      // 注意:浏览器对脚本设置 scrollTop 触发的 scroll 事件同样会标记
      // isTrusted=true,不能只靠 isTrusted 区分。渲染/校正前会打开
      // galleryProgrammaticScrollUntil 屏蔽窗口,避免重新武装后一次手势翻多页。
      if (!event.isTrusted
        || page.loading
        || page.galleryScrollLocked
        || performance.now() < Number(page.galleryProgrammaticScrollUntil || 0)) return;
      if (body.scrollTop > 220) {
        page.galleryLoadArmed = true;
      } else if (body.scrollTop < 160 && page.galleryLoadArmed && page.hasMore) {
        page.galleryLoadArmed = false;
        loadChatSearchPage(false);
      }
      return;
    }
    if (page.loading || !page.hasMore) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 180) {
      loadChatSearchPage(false);
    }
  }, { passive: true });

  bindChatSearchLongPress();
}

// ---------- 大图查看器 ----------

const imageViewerState = {
  open: false,
  scale: 1,
  x: 0,
  y: 0,
  startScale: 1,
  startDist: 0,
  startX: 0,
  startY: 0,
  startTranslateX: 0,
  startTranslateY: 0,
  touchStartedAt: 0,
  moved: false,
  pinching: false,
  lastTapAt: 0,
  lastTapX: 0,
  lastTapY: 0,
  closeTimer: null,
  suppressClickUntil: 0,
};

function applyImageViewerTransform(animate) {
  const img = $('#imageViewerImg');
  if (!img) return;
  img.style.transition = animate ? 'transform 180ms ease' : 'none';
  img.style.transform = `translate3d(${imageViewerState.x}px, ${imageViewerState.y}px, 0) scale(${imageViewerState.scale})`;
}

function openImageViewer(src) {
  const overlay = $('#imageViewer');
  const img = $('#imageViewerImg');
  if (!overlay || !img || !src) return;
  clearTimeout(imageViewerState.closeTimer);
  imageViewerState.closeTimer = null;
  imageViewerState.open = true;
  imageViewerState.scale = 1;
  imageViewerState.x = 0;
  imageViewerState.y = 0;
  imageViewerState.lastTapAt = 0;
  imageViewerState.moved = false;
  imageViewerState.pinching = false;
  img.style.transition = 'none';
  img.style.transform = 'translate3d(0, 0, 0) scale(1)';
  img.src = src;
  overlay.classList.remove('hidden');
  document.body.classList.add('image-viewer-open');
  overlay.focus({ preventScroll: true });
}

function closeImageViewer() {
  if (!imageViewerState.open) return;
  const overlay = $('#imageViewer');
  const img = $('#imageViewerImg');
  clearTimeout(imageViewerState.closeTimer);
  imageViewerState.closeTimer = null;
  imageViewerState.open = false;
  imageViewerState.scale = 1;
  imageViewerState.x = 0;
  imageViewerState.y = 0;
  imageViewerState.pinching = false;
  imageViewerState.moved = false;
  imageViewerState.lastTapAt = 0;
  if (overlay) overlay.classList.add('hidden');
  if (img) {
    img.removeAttribute('src');
    img.style.transition = 'none';
    img.style.transform = '';
  }
  document.body.classList.remove('image-viewer-open');
}

/** 双击/双触:未放大时以触点为中心放大到 2.5 倍,已放大则复原 */
function toggleImageViewerZoom(clientX, clientY) {
  const img = $('#imageViewerImg');
  if (!imageViewerState.open || !img) return;
  if (imageViewerState.scale > 1.05) {
    imageViewerState.scale = 1;
    imageViewerState.x = 0;
    imageViewerState.y = 0;
    applyImageViewerTransform(true);
    return;
  }
  const rect = img.getBoundingClientRect();
  const cx = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const cy = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const target = 2.5;
  imageViewerState.scale = target;
  imageViewerState.x = -(cx - centerX) * (target - 1);
  imageViewerState.y = -(cy - centerY) * (target - 1);
  applyImageViewerTransform(true);
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function bindImageViewer() {
  const overlay = $('#imageViewer');
  const img = $('#imageViewerImg');
  if (!overlay || !img || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';

  overlay.addEventListener('click', (event) => {
    if (!imageViewerState.open || Date.now() < imageViewerState.suppressClickUntil) return;
    if (imageViewerState.closeTimer) {
      clearTimeout(imageViewerState.closeTimer);
      imageViewerState.closeTimer = null;
      toggleImageViewerZoom(event.clientX, event.clientY);
      return;
    }
    imageViewerState.closeTimer = setTimeout(() => {
      imageViewerState.closeTimer = null;
      closeImageViewer();
    }, 300);
  });

  overlay.addEventListener('touchstart', (event) => {
    if (!imageViewerState.open) return;
    if (imageViewerState.closeTimer) {
      clearTimeout(imageViewerState.closeTimer);
      imageViewerState.closeTimer = null;
    }
    if (event.touches.length >= 2) {
      event.preventDefault();
      imageViewerState.pinching = true;
      imageViewerState.moved = true;
      imageViewerState.lastTapAt = 0;
      imageViewerState.startScale = imageViewerState.scale;
      imageViewerState.startDist = touchDistance(event.touches);
      imageViewerState.startTranslateX = imageViewerState.x;
      imageViewerState.startTranslateY = imageViewerState.y;
      imageViewerState.suppressClickUntil = Date.now() + 600;
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const continuingPinch = imageViewerState.pinching;
    imageViewerState.pinching = false;
    imageViewerState.startX = touch.clientX;
    imageViewerState.startY = touch.clientY;
    imageViewerState.startTranslateX = imageViewerState.x;
    imageViewerState.startTranslateY = imageViewerState.y;
    imageViewerState.touchStartedAt = Date.now();
    imageViewerState.moved = continuingPinch;
  }, { passive: false });

  overlay.addEventListener('touchmove', (event) => {
    if (!imageViewerState.open) return;
    if (event.touches.length >= 2) {
      event.preventDefault();
      if (!imageViewerState.pinching) {
        imageViewerState.pinching = true;
        imageViewerState.moved = true;
        imageViewerState.startScale = imageViewerState.scale;
        imageViewerState.startDist = touchDistance(event.touches);
      }
      if (imageViewerState.startDist > 0) {
        imageViewerState.scale = Math.min(4, Math.max(1, imageViewerState.startScale * (touchDistance(event.touches) / imageViewerState.startDist)));
        if (imageViewerState.scale <= 1.01) {
          imageViewerState.x = 0;
          imageViewerState.y = 0;
        }
        applyImageViewerTransform(false);
      }
      imageViewerState.suppressClickUntil = Date.now() + 600;
      return;
    }
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const dx = touch.clientX - imageViewerState.startX;
      const dy = touch.clientY - imageViewerState.startY;
      if (imageViewerState.scale > 1.01) {
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          imageViewerState.moved = true;
          imageViewerState.x = imageViewerState.startTranslateX + dx;
          imageViewerState.y = imageViewerState.startTranslateY + dy;
          event.preventDefault();
          applyImageViewerTransform(false);
        }
      } else if (Math.abs(dx) + Math.abs(dy) > 8) {
        imageViewerState.moved = true;
        event.preventDefault();
      }
    }
  }, { passive: false });

  overlay.addEventListener('touchend', (event) => {
    if (!imageViewerState.open) return;
    if (event.touches.length === 1) {
      if (imageViewerState.pinching) {
        imageViewerState.pinching = false;
        imageViewerState.moved = true;
      }
      const touch = event.touches[0];
      imageViewerState.startX = touch.clientX;
      imageViewerState.startY = touch.clientY;
      imageViewerState.startTranslateX = imageViewerState.x;
      imageViewerState.startTranslateY = imageViewerState.y;
      imageViewerState.suppressClickUntil = Date.now() + 600;
      return;
    }
    if (event.touches.length > 1) return;

    const wasPinching = imageViewerState.pinching;
    imageViewerState.pinching = false;
    if (wasPinching || imageViewerState.moved) {
      if (imageViewerState.scale <= 1.01) {
        imageViewerState.scale = 1;
        imageViewerState.x = 0;
        imageViewerState.y = 0;
      }
      applyImageViewerTransform(true);
      imageViewerState.suppressClickUntil = Date.now() + 600;
      event.preventDefault();
      return;
    }

    const touch = event.changedTouches[0];
    if (!touch) return;
    const now = Date.now();
    if (now - imageViewerState.touchStartedAt > 350) return;
    const isDouble = imageViewerState.lastTapAt
      && now - imageViewerState.lastTapAt < 320
      && Math.abs(touch.clientX - imageViewerState.lastTapX) < 30
      && Math.abs(touch.clientY - imageViewerState.lastTapY) < 30;
    imageViewerState.suppressClickUntil = now + 600;
    event.preventDefault();
    if (isDouble) {
      clearTimeout(imageViewerState.closeTimer);
      imageViewerState.closeTimer = null;
      imageViewerState.lastTapAt = 0;
      toggleImageViewerZoom(touch.clientX, touch.clientY);
      return;
    }
    imageViewerState.lastTapAt = now;
    imageViewerState.lastTapX = touch.clientX;
    imageViewerState.lastTapY = touch.clientY;
    clearTimeout(imageViewerState.closeTimer);
    imageViewerState.closeTimer = setTimeout(() => {
      imageViewerState.closeTimer = null;
      closeImageViewer();
    }, 320);
  }, { passive: false });

  overlay.addEventListener('touchcancel', () => {
    if (!imageViewerState.open) return;
    imageViewerState.pinching = false;
    imageViewerState.moved = true;
    imageViewerState.suppressClickUntil = Date.now() + 600;
    applyImageViewerTransform(true);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && imageViewerState.open) {
      closeImageViewer();
    }
  });
}

// ---------- 视频查看器 ----------

function openVideoViewer(src) {
  const overlay = $('#videoViewer');
  const video = $('#videoViewerVideo');
  if (!overlay || !video || !src) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('video-viewer-open');
  video.src = src;
  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
}

function closeVideoViewer() {
  const overlay = $('#videoViewer');
  const video = $('#videoViewerVideo');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  overlay.classList.add('hidden');
  document.body.classList.remove('video-viewer-open');
}

function bindVideoViewer() {
  const overlay = $('#videoViewer');
  const closeBtn = $('#videoViewerClose');
  if (!overlay || !closeBtn || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';
  closeBtn.addEventListener('click', closeVideoViewer);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeVideoViewer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.classList.contains('hidden')) {
      closeVideoViewer();
    }
  });
}

// ---------- 服务器端导入进度 ----------

const IMPORT_BANNER_VISIBLE_MS = 15 * 60 * 1000;
const SERVER_IMPORT_STAGE_TITLES = {
  starting: '正在启动导入',
  extract: '正在解压备份',
  parse: '正在解析备份',
  meta: '正在上传备份信息',
  resume: '正在检查导入进度',
  'user-avatars': '正在上传账号头像',
  contacts: '正在上传联系人',
  tags: '正在上传联系人标签',
  'contact-avatars': '正在检查联系人头像',
  messages: '正在上传聊天记录',
  verify: '正在校验聊天记录',
  repair: '正在补传缺失媒体',
  avatars: '正在补齐联系人头像',
  complete: '正在生成导入统计',
};

function serverImportJobActive(job = state.serverImportJob) {
  return Boolean(job && (job.status === 'starting' || job.status === 'running'));
}

function serverImportStatusTitle(job) {
  if (job.status === 'completed') return '备份导入完成';
  if (job.status === 'failed') return '备份导入失败';
  if (job.status === 'interrupted') return '备份导入已中断';
  if (job.status === 'cancelled') return '备份导入已停止';
  return SERVER_IMPORT_STAGE_TITLES[job.stage] || '服务器正在导入备份';
}

function renderServerImportBanner() {
  const banner = $('#serverImportBanner');
  const fill = $('#serverImportFill');
  const title = $('#serverImportTitle');
  const percentEl = $('#serverImportPercent');
  const deviceEl = $('#serverImportDevice');
  const textEl = $('#serverImportText');
  const refreshBtn = $('#serverImportRefreshBtn');
  if (!banner || !fill || !title || !percentEl || !deviceEl || !textEl) return;

  const job = state.serverImportJob;
  const active = serverImportJobActive(job);
  const finishedAt = job && job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
  const recentlyFinished = Number.isFinite(finishedAt)
    && Date.now() - finishedAt < IMPORT_BANNER_VISIBLE_MS;
  // 刷新后的页面不再回放旧的完成进度;只有本次会话见过任务运行才展示。
  const showFinished = state.serverImportSeenActive && recentlyFinished;
  if (!job || !job.id || job.status === 'idle' || (!active && !showFinished)) {
    banner.classList.add('hidden');
    fill.classList.remove('is-indeterminate');
    fill.style.width = '0%';
    return;
  }

  banner.classList.remove('hidden');
  banner.dataset.status = job.status;
  title.textContent = serverImportStatusTitle(job);
  deviceEl.textContent = [job.deviceName, job.iosVersion ? `iOS ${job.iosVersion}` : '']
    .filter(Boolean)
    .join(' · ');

  if (active && job.percent !== null && job.percent !== undefined) {
    fill.classList.remove('is-indeterminate');
    fill.style.width = `${job.percent}%`;
    percentEl.textContent = `${job.percent}%`;
  } else if (active) {
    fill.classList.add('is-indeterminate');
    fill.style.width = '';
    percentEl.textContent = '';
  } else {
    fill.classList.remove('is-indeterminate');
    fill.style.width = job.status === 'completed' ? '100%' : '0%';
    percentEl.textContent = job.status === 'completed' ? '100%' : '';
  }

  if (active) {
    textEl.textContent = job.text || '正在准备导入...';
  } else if (job.status === 'completed') {
    const stats = job.stats || {};
    textEl.textContent = `${formatStatNumber(stats.contactCount)} 个联系人,`
      + `${formatStatNumber(stats.messageCount)} 条消息,`
      + `${formatStatNumber(stats.mediaCount)} 个媒体文件`
      + (Number(stats.pendingMedia) > 0
        ? `;${formatStatNumber(stats.pendingMedia)} 个媒体没有可用源文件`
        : '');
  } else {
    textEl.textContent = job.error || job.text || '';
  }
  if (refreshBtn) refreshBtn.classList.toggle('hidden', job.status !== 'completed');
}

async function pollServerImportStatus() {
  if (state.serverImportPolling) return;
  state.serverImportPolling = true;
  state.serverImportTimer = null;
  try {
    if (!state.secret || !state.appStarted) return;
    if (!document.hidden) {
      const previous = state.serverImportJob;
      try {
        const data = await api('/api/import/current');
        state.serverImportJob = data.job || null;
        const previousActive = serverImportJobActive(previous);
        const nextActive = serverImportJobActive(state.serverImportJob);
        if (previousActive || nextActive) state.serverImportSeenActive = true;
        renderServerImportBanner();
        if (state.dataSourceOpen) {
          updateDataSourceProgress();
          if (previousActive && !nextActive && state.serverImportJob
            && state.serverImportJob.status === 'completed') {
            // 完成后重新读取 sources,把对应备份切换为“已导入”。
            loadDataSourceItems({ silent: true });
          } else {
            updateDataSourceButtons();
          }
        }
        if (previousActive && state.serverImportJob
          && !nextActive && state.serverImportJob.status === 'completed') {
          toast('服务器备份导入完成，刷新页面可查看新数据');
        }
      } catch (err) {
        /* 轮询失败不影响浏览;Secret 失效时 api() 会弹出登录遮罩 */
      }
    }
  } finally {
    state.serverImportPolling = false;
    if (state.secret && state.appStarted) {
      const delay = serverImportJobActive() ? 1800 : 5000;
      state.serverImportTimer = setTimeout(pollServerImportStatus, delay);
    }
  }
}

function startServerImportPolling() {
  if (state.serverImportTimer) clearTimeout(state.serverImportTimer);
  state.serverImportTimer = null;
  pollServerImportStatus();
}

function bindServerImportBanner() {
  const refreshBtn = $('#serverImportRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => window.location.reload());
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.appStarted) startServerImportPolling();
  });
}

// ---------- 鉴权 ----------

function showAuthOverlay(message) {
  const overlay = $('#authOverlay');
  overlay.classList.remove('hidden');
  const errEl = $('#authError');
  if (message) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  } else {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  $('#authSecretInput').focus();
  $('#authSecretInput').select();
}

async function submitAuth() {
  const secret = $('#authSecretInput').value.trim();
  if (!secret) {
    showAuthOverlay('请输入 Secret');
    return;
  }
  const btn = $('#authSubmitBtn');
  btn.disabled = true;
  btn.textContent = '校验中...';
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (res.ok) {
      state.secret = secret;
      localStorage.setItem('wepo.secret', secret);
      $('#authOverlay').classList.add('hidden');
      if (state.appStarted) {
        // 会话中 Secret 失效后重新登录:刷新账号与当前数据
        await loadUsers();
        if (state.view !== 'data') loadContacts(true);
        if (state.selected) loadMessages(true);
        if (state.view === 'data') renderDataManager();
        startServerImportPolling();
      } else {
        startApp();
      }
    } else {
      showAuthOverlay('Secret 校验失败,请检查后重试');
    }
  } catch (err) {
    showAuthOverlay(`无法连接服务器: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '进入';
  }
}

function bindAuth() {
  $('#authSubmitBtn').addEventListener('click', submitAuth);
  $('#authSecretInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuth();
  });
}

/** 尝试用本地保存的 Secret 自动登录 */
async function tryAutoAuth() {
  if (!state.secret) {
    showAuthOverlay();
    return;
  }
  try {
    // 用轻量的受保护接口验证 Secret;不要用 /api/stats,大数据量下它会做全量合并统计
    await api('/api/users');
    startApp();
  } catch (err) {
    // Secret 无效时 api() 已显示登录遮罩;网络错误给出提示
    if (!err.message.startsWith('未授权')) {
      showAuthOverlay(`无法连接服务器: ${err.message}`);
    }
  }
}

// ---------- PWA ----------

/** 注册 Service Worker(需要 HTTPS 或 localhost;HTTP 局域网访问会静默失败) */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] Service Worker 注册失败:', err.message);
    });
  });
}

// ---------- 初始化 ----------

async function startApp() {
  if (state.appStarted) return;
  state.appStarted = true;
  showView('chats');
  await loadWxEmojiMap();
  await loadUsers();
  loadContacts(true);
  if (state.view === 'data') renderDataManager();
  startServerImportPolling();
}

function bindMobileZoomLock() {
  // iOS Safari 会忽略部分 viewport 的 user-scalable,这里再拦截手势缩放
  if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
  const prevent = (event) => event.preventDefault();
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('gesturechange', prevent, { passive: false });
}

function init() {
  setupTheme();
  bindNav();
  bindListEvents();
  bindSearchPageEvents();
  bindChatEvents();
  bindChatSearchEvents();
  bindLogoutDialog();
  bindInfiniteScroll();
  bindImageViewer();
  bindVideoViewer();
  bindMobileZoomLock();
  bindHistoryBack();
  bindServerImportBanner();
  bindAuth();
  tryAutoAuth();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
