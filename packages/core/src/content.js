/**
 * 微信消息内容解析:把各类型消息的原始 content 解析为可读文本摘要。
 */

const { XMLParser } = require('fast-xml-parser');
const { MSG_TYPE } = require('./types');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  cdataPropName: '__cdata',
});

/** 兼容 fast-xml-parser 对重复标签返回数组的情况 */
function first(node) {
  return Array.isArray(node) ? node[0] : node;
}

/** 解析消息 XML 内容,失败返回 null */
function tryParseXml(content) {
  if (typeof content !== 'string' || content === '') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('<')) return null;
  try {
    return xmlParser.parse(trimmed);
  } catch (err) {
    return null;
  }
}

/** 从 XML 节点取字符串值(兼容 cdata) */
function nodeText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '__cdata' in node) return String(node.__cdata);
  return '';
}

/** 解码 recordinfo CDATA 中残留的数字/XML 实体(如 &#x20; / &#x0A; / &amp;) */
function decodeXmlEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 语音时长(毫秒)→ "n″" */
function voiceLengthText(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  return `${seconds}″`;
}

/**
 * 解析单条消息内容。
 * @param {number} type 消息类型(见 types.js MSG_TYPE)
 * @param {string} content 原始 content 字段
 * @returns {{text:string, extra:Object|null, mediaKind:string|null}}
 *   text: 可读文本摘要;mediaKind: image|voice|video,表示有对应媒体文件
 */
function parseMessageContent(type, content) {
  const xml = tryParseXml(content);
  const msg = xml ? first(xml.msg) : null;

  switch (type) {
    case MSG_TYPE.TEXT:
      return { text: content || '', extra: null, mediaKind: null };

    case MSG_TYPE.IMAGE: {
      const img = msg ? first(msg.img) : null;
      const extra = img
        ? {
            width: img.cdnthumbwidth,
            height: img.cdnthumbheight,
            aeskey: img.aeskey,
            cdnbigimgurl: img.cdnbigimgurl,
          }
        : null;
      return { text: '[图片]', extra, mediaKind: 'image' };
    }

    case MSG_TYPE.VOICE: {
      const voice = msg ? first(msg.voicemsg) : null;
      const extra = voice
        ? {
            voiceLength: Number(voice.voicelength) || 0,
            voiceFormat: voice.voiceformat || '',
            durationText: voiceLengthText(voice.voicelength),
          }
        : null;
      return {
        text: `[语音] ${extra ? extra.durationText : ''}`.trim(),
        extra,
        mediaKind: 'voice',
      };
    }

    case MSG_TYPE.VIDEO:
    case MSG_TYPE.MICROVIDEO: {
      const video = msg ? first(msg.videomsg) : null;
      const isMicro = type === MSG_TYPE.MICROVIDEO;
      const extra = video
        ? {
            playLength: video.playlength,
            width: video.cdnthumbwidth,
            height: video.cdnthumbheight,
            aeskey: video.aeskey,
          }
        : null;
      return { text: isMicro ? '[小视频]' : '[视频]', extra, mediaKind: 'video' };
    }

    case MSG_TYPE.EMOTICON: {
      const emoji = msg ? first(msg.emoji) : null;
      const extra = emoji
        ? {
            md5: emoji.md5,
            cdnurl: emoji.cdnurl,
            thumburl: emoji.thumburl,
            encrypturl: emoji.encrypturl,
            aeskey: emoji.aeskey,
            productid: emoji.productid,
            designerid: emoji.designerid,
            desc: emoji.desc,
          }
        : null;
      // 有 cdnurl 的是动图表情,否则可能是 emoji 字符
      const animated = Boolean(extra && extra.cdnurl);
      return { text: animated ? '[动画表情]' : '[表情]', extra, mediaKind: null };
    }

    case MSG_TYPE.LOCATION: {
      const loc = msg ? first(msg.location) : null;
      const poiName = loc ? nodeText(loc.poiname) : '';
      const label = loc ? (nodeText(loc.label) || poiName) : '';
      const extra = loc
        ? {
            latitude: Number(loc.y),
            longitude: Number(loc.x),
            label,
            poiname: poiName,
          }
        : null;
      const posText = extra && extra.latitude ? ` (${extra.latitude.toFixed(6)}, ${extra.longitude.toFixed(6)})` : '';
      return { text: `[位置] ${label}${posText}`.trim(), extra, mediaKind: null };
    }

    case MSG_TYPE.APP:
      return parseAppMsg(msg);

    case MSG_TYPE.SHARECARD:
    case MSG_TYPE.IMCARD: {
      const extra = msg
        ? { username: msg.username, nickname: msg.nickname, showNickName: msg.shownickname }
        : null;
      const name = extra ? extra.showNickName || extra.nickname || extra.username || '' : '';
      return { text: `[名片] ${name}`.trim(), extra, mediaKind: null };
    }

    case MSG_TYPE.VOIPMSG:
    case MSG_TYPE.VOIPNOTIFY:
    case MSG_TYPE.VOIPINVITE:
      return { text: '[通话]', extra: null, mediaKind: null };

    case MSG_TYPE.STATUSNOTIFY: {
      // 状态通知:XML 里只有 code 时给出提示,否则按文本
      const status = msg ? first(msg.statusnotify) : null;
      if (status && msg && Object.keys(msg).length === 1) {
        return { text: '[状态通知]', extra: { code: status.code }, mediaKind: null };
      }
      return { text: content || '[状态通知]', extra: null, mediaKind: null };
    }

    case MSG_TYPE.PUSHMAIL:
      return { text: content || '[邮件提醒]', extra: null, mediaKind: null };

    case MSG_TYPE.VERIFYMSG:
      return { text: content || '[好友验证]', extra: null, mediaKind: null };

    case MSG_TYPE.POSSIBLEFRIEND:
      return { text: '[好友推荐]', extra: null, mediaKind: null };

    case MSG_TYPE.NOTICE:
    case MSG_TYPE.SYSNOTICE:
      return { text: content || '[系统通知]', extra: null, mediaKind: null };

    case MSG_TYPE.RECALLED:
      return { text: '[撤回了一条消息]', extra: null, mediaKind: null };

    case MSG_TYPE.SYS: {
      const sysmsg = msg ? first(msg.sysmsg) : null;
      const sysType = sysmsg ? sysmsg.type : '';
      return {
        text: `[系统消息]${sysType ? ` (${sysType})` : ''}`,
        extra: sysType ? { sysType } : null,
        mediaKind: null,
      };
    }

    default:
      // 未知类型:有 XML 时尽量取文本,否则原样返回
      return { text: content || `[消息类型 ${type}]`, extra: null, mediaKind: null };
  }
}

/** 解析合并转发记录中的单个 dataitem */
function parseRecordItem(item, depth = 0) {
  if (!item || typeof item !== 'object' || depth > 3) return null;
  const dataType = Number(nodeText(item.datatype)) || 0;
  const dataId = nodeText(item.dataid);
  const subType = nodeText(item.subtype);
  const source = first(item.dataitemsource);
  const sourceName = decodeXmlEntities(nodeText(item.sourcename))
    || (source ? decodeXmlEntities(nodeText(source.realchatname) || nodeText(source.fromusr)) : '');
  const sourceHeadUrl = decodeXmlEntities(nodeText(item.sourceheadurl));
  const sourceTime = decodeXmlEntities(nodeText(item.sourcetime));
  const srcMsgCreateTime = Number(nodeText(item.srcMsgCreateTime)) || 0;
  const dataTitle = decodeXmlEntities(nodeText(item.datatitle));
  let dataDesc = decodeXmlEntities(nodeText(item.datadesc));
  const dataFormat = decodeXmlEntities(nodeText(item.dataformat));
  const web = first(item.weburlitem);
  const loc = first(item.locitem);
  const finderNode = first(item.finderFeed);
  const finderNameCard = first(item.finderShareNameCard);
  const finderName = finderNode ? decodeXmlEntities(nodeText(finderNode.nickname)) : '';
  let text = '';
  let title = dataTitle;
  let desc = dataDesc;
  let url = '';
  let thumbUrl = '';
  let location = null;
  let finder = null;
  let records = null;

  if (web) {
    title = title || decodeXmlEntities(nodeText(web.title));
    desc = desc || decodeXmlEntities(nodeText(web.desc));
    url = decodeXmlEntities(nodeText(web.link) || nodeText(web.streamweburl));
    thumbUrl = decodeXmlEntities(nodeText(web.thumburl));
  }
  if (loc) {
    location = {
      label: decodeXmlEntities(nodeText(loc.label)),
      poiname: decodeXmlEntities(nodeText(loc.poiname)),
      latitude: Number(nodeText(loc.lat)) || 0,
      longitude: Number(nodeText(loc.lng)) || 0,
    };
  }
  if (finderNode) {
    finder = {
      nickname: finderName,
      username: decodeXmlEntities(nodeText(finderNode.username)),
      avatar: decodeXmlEntities(nodeText(finderNode.avatar)),
      desc: decodeXmlEntities(nodeText(finderNode.desc)),
      objectId: decodeXmlEntities(nodeText(finderNode.objectId)),
    };
  } else if (finderNameCard) {
    finder = {
      nickname: decodeXmlEntities(nodeText(finderNameCard.nickname)),
      username: decodeXmlEntities(nodeText(finderNameCard.username)),
      avatar: decodeXmlEntities(nodeText(finderNameCard.avatar)),
    };
  }

  // 名片/企业名片子项的 datadesc 是 XML,不要在详情页直接显示原始标签。
  if ((dataType === 16 || dataType === 31) && dataDesc.trim().startsWith('<')) {
    const cardXml = tryParseXml(dataDesc);
    const cardMsg = cardXml ? first(cardXml.msg) : null;
    if (cardMsg) {
      const cardName = decodeXmlEntities(
        nodeText(cardMsg.nickname) || nodeText(cardMsg.displayname) || nodeText(cardMsg.username)
      );
      const cardDesc = decodeXmlEntities(
        nodeText(cardMsg.sign) || nodeText(cardMsg.openimdesc) || nodeText(cardMsg.desc)
      );
      if (cardName) title = title || cardName;
      if (cardDesc) desc = cardDesc;
      dataDesc = cardDesc || cardName || '';
    }
  }

  switch (dataType) {
    case 1: text = dataDesc; break;
    case 2: text = '[图片]'; break;
    case 4: text = '[视频]'; break;
    case 5: text = `[链接] ${title || desc || url}`.trim(); break;
    case 6: text = `[位置] ${(location && (location.poiname || location.label)) || ''}`.trim(); break;
    case 8: text = `[文件] ${title || desc}`.trim(); break;
    case 16: text = `[名片] ${desc || title || dataDesc}`.trim(); break;
    case 31: text = `[名片] ${desc || title || dataDesc}`.trim(); break;
    case 17: {
      // 新版备份把嵌套 recordinfo 放在 <recordxml><recordinfo> 中,
      // 旧格式则直接放在 <recordinfo> 中。
      const nestedWrap = first(item.recordinfo) || first(item.recordxml);
      let nested = nestedWrap;
      if (nested && typeof nested === 'object' && nested.recordinfo) {
        nested = first(nested.recordinfo);
      }
      if (nested) records = parseRecordInfo(nested, depth + 1);
      text = `[聊天记录] ${desc || title}`.trim();
      break;
    }
    case 19: text = `[小程序] ${title || desc}`.trim(); break;
    case 22: text = `[视频号] ${(finder && (finder.desc || finder.nickname)) || desc || title}`.trim(); break;
    case 26: text = `[视频号] ${(finder && finder.nickname) || desc || title}`.trim(); break;
    default: text = desc || title || '[聊天记录]'; break;
  }

  const record = {
    dataType,
    dataId,
    subType,
    sourceName: sourceName || '',
    sourceHeadUrl: sourceHeadUrl || '',
    sourceTime: sourceTime || '',
    createTime: srcMsgCreateTime,
    dataFormat: dataFormat || '',
    text: text || '[聊天记录]',
    title: title || '',
    desc: desc || '',
    url: url || '',
    thumbUrl: thumbUrl || '',
  };
  if (location) record.location = location;
  if (finder) record.finder = finder;
  if (records && records.items && records.items.length) {
    record.records = records.items;
    record.recordTitle = records.title || title || '';
  }
  return record;
}

/** 解析 <recordinfo> 内的 datalist */
function parseRecordInfo(recordInfo, depth = 0) {
  if (!recordInfo || depth > 3) return null;
  let root = recordInfo;
  if (root && typeof root === 'object' && typeof root.__cdata === 'string') {
    root = root.__cdata;
  }
  if (typeof root === 'string') {
    const parsed = tryParseXml(root);
    root = parsed ? first(parsed.recordinfo) : null;
  }
  if (root && typeof root === 'object' && !root.datalist && root.recordinfo) {
    root = first(root.recordinfo);
  }
  if (!root || typeof root !== 'object') return null;
  const list = first(root.datalist);
  if (!list) return null;
  const rawItems = list.dataitem;
  const items = (Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []))
    .map((item) => parseRecordItem(item, depth))
    .filter(Boolean);
  return {
    title: decodeXmlEntities(nodeText(root.title)) || '',
    desc: decodeXmlEntities(nodeText(root.desc)) || '',
    items,
  };
}

/** 解析应用消息(type 49) */
function parseAppMsg(msg) {
  if (!msg) return { text: '[链接]', extra: null, mediaKind: null };
  const appmsg = first(msg.appmsg);
  if (!appmsg) return { text: '[链接]', extra: null, mediaKind: null };

  const title = nodeText(appmsg.title);
  const des = nodeText(appmsg.des);
  const url = nodeText(appmsg.url);
  const appType = Number(nodeText(appmsg.type));
  const attach = first(appmsg.appattach);
  const weappInfo = first(appmsg.weappinfo);
  const weappId = weappInfo ? nodeText(weappInfo.appid) : '';
  const weappUsername = weappInfo ? nodeText(weappInfo.username) : '';
  const weappPath = weappInfo ? nodeText(weappInfo.pagepath) : '';
  const weappAppName = weappInfo
    ? (nodeText(weappInfo.sourcedisplayname) || nodeText(weappInfo.appname))
    : '';
  const weappIconUrl = weappInfo
    ? (nodeText(weappInfo.weappiconurl)
      || nodeText(weappInfo.appiconurl)
      || nodeText(weappInfo.iconurl))
    : '';
  const weappServiceType = weappInfo ? nodeText(weappInfo.appservicetype) : '';
  const referNode = first(appmsg.refermsg);
  const payNode = first(appmsg.wcpayinfo);

  // 视频号分享(appType 51)的标题经常只是“当前版本不支持展示该内容”
  // 之类的占位文字,真正的封面、作者、视频标题在 finderFeed 中。
  const finderNode = first(appmsg.finderFeed);
  const finderNameCard = first(appmsg.findernamecard);
  const finderMediaList = finderNode ? first(finderNode.mediaList) : null;
  const finderMedia = finderMediaList ? first(finderMediaList.media) : null;
  let finder = null;
  if (finderNode) {
    finder = {
      objectId: nodeText(finderNode.objectId),
      objectNonceId: nodeText(finderNode.objectNonceId),
      nickname: nodeText(finderNode.nickname) || (finderNameCard ? nodeText(finderNameCard.nickname) : ''),
      username: nodeText(finderNode.username) || (finderNameCard ? nodeText(finderNameCard.username) : ''),
      avatar: nodeText(finderNode.avatar) || (finderNameCard ? nodeText(finderNameCard.avatar) : ''),
      desc: nodeText(finderNode.desc),
      mediaCount: Number(nodeText(finderNode.mediaCount)) || 0,
      feedType: Number(nodeText(finderNode.feedType)) || 0,
      liveId: nodeText(finderNode.liveId),
      mediaType: Number(finderMedia ? nodeText(finderMedia.mediaType) : 0) || 0,
      thumbUrl: finderMedia ? (nodeText(finderMedia.thumbUrl) || nodeText(finderMedia.coverUrl)) : '',
      coverUrl: finderMedia ? nodeText(finderMedia.coverUrl) : '',
      videoUrl: finderMedia ? nodeText(finderMedia.url) : '',
      width: Number(finderMedia ? nodeText(finderMedia.width) : 0) || 0,
      height: Number(finderMedia ? nodeText(finderMedia.height) : 0) || 0,
      duration: Number(finderMedia ? nodeText(finderMedia.videoPlayDuration) : 0) || 0,
    };
  }

  const extra = {
    appType,
    title,
    des,
    url,
    thumburl: nodeText(appmsg.thumburl),
    sourceDisplayName: nodeText(appmsg.sourcedisplayname),
    sourceUsername: nodeText(appmsg.sourceusername),
    fileExt: attach ? nodeText(attach.fileext) : '',
    fileSize: attach ? Number(nodeText(attach.totallen)) || 0 : 0,
    fileName: attach ? nodeText(attach.fileext) : undefined,
  };
  if (finder) {
    extra.finder = finder;
    extra.thumburl = extra.thumburl || finder.thumbUrl || finder.coverUrl;
    extra.sourceDisplayName = extra.sourceDisplayName || finder.nickname;
    extra.sourceUsername = extra.sourceUsername || finder.username;
    extra.avatarUrl = finder.avatar || '';
    if (appType === 51) {
      // 占位标题不应出现在视频号卡片上;优先使用视频描述,其次作者昵称。
      const placeholder = /不支持|不支援|升级|升級|最新版本|latest version|update/i.test(title);
      extra.title = finder.desc
        || (placeholder ? '' : title)
        || (finder.nickname ? `${finder.nickname}的视频` : '视频号');
    }
  }

  // 合并转发的聊天记录:appmsg.recorditem 是 CDATA 包裹的 recordinfo。
  if (appType === 19) {
    const recordItem = first(appmsg.recorditem);
    const recordInfo = parseRecordInfo(recordItem, 0);
    if (recordInfo && recordInfo.items.length) {
      extra.records = recordInfo.items;
      extra.recordTitle = recordInfo.title || title;
    }
  }

  if (referNode) {
    const referType = Number(nodeText(referNode.type)) || 0;
    let referContent = nodeText(referNode.content);
    if (referType === 3) referContent = '[图片]';
    else if (referType === 43 || referType === 62) referContent = '[视频]';
    else if (referType === 49) {
      const subMsg = tryParseXml(referContent);
      const subMsgNode = subMsg ? first(subMsg.msg) : null;
      const subApp = subMsgNode ? first(subMsgNode.appmsg) : null;
      referContent = subApp ? nodeText(subApp.title) : referContent;
    }
    extra.refer = {
      type: referType,
      displayName: nodeText(referNode.displayname),
      content: referContent,
      svrid: nodeText(referNode.svrid),
      fromusr: nodeText(referNode.fromusr),
      chatusr: nodeText(referNode.chatusr),
      createTime: Number(nodeText(referNode.createtime)) || 0,
    };
  }
  if (payNode) {
    extra.pay = {
      receiveTitle: nodeText(payNode.receivertitle),
      senderTitle: nodeText(payNode.sendertitle),
      senderDesc: nodeText(payNode.senderdes),
      receiverDesc: nodeText(payNode.receiverdes),
      sceneText: nodeText(payNode.scenetext),
      payerUsername: nodeText(payNode.payer_username),
      receiverUsername: nodeText(payNode.receiver_username),
      receiveStatus: nodeText(payNode.receivestatus),
      feeDesc: nodeText(payNode.feedesc),
      payMemo: nodeText(payNode.pay_memo),
      hintText: nodeText(payNode.hinttext),
      invalidTime: Number(nodeText(payNode.invalidtime)) || 0,
      nativeUrl: nodeText(payNode.nativeurl),
    };
  }

  if (weappId || weappUsername || weappPath) {
    extra.weapp = {
      appid: weappId,
      username: weappUsername,
      pagepath: weappPath,
      appName: weappAppName,
      iconUrl: weappIconUrl,
      serviceType: weappServiceType,
    };
    return { text: `[小程序] ${title || des || ''}`.trim(), extra, mediaKind: null };
  }
  switch (appType) {
    case 6: // 文件
      return { text: `[文件] ${title}`.trim(), extra, mediaKind: null };
    case 3: // 音乐
      return { text: `[音乐] ${title}${des ? ` - ${des}` : ''}`.trim(), extra, mediaKind: null };
    case 4: // 视频
      return { text: `[视频] ${title}`.trim(), extra, mediaKind: null };
    case 51: { // 视频号
      const label = finder ? (finder.desc || finder.nickname || title) : title;
      return { text: `[视频号] ${label || '视频'}`.trim(), extra, mediaKind: null };
    }
    case 2001: // 红包
      return { text: `[红包] ${des || title}`.trim(), extra, mediaKind: null };
    case 2000: // 转账
      return { text: `[转账] ${des || title}`.trim(), extra, mediaKind: null };
    case 57: // 引用消息
      return { text: `[引用] ${title}`.trim(), extra, mediaKind: null };
    case 19: // 合并转发的聊天记录
      return { text: `[聊天记录] ${title}`.trim(), extra, mediaKind: null };
    default:
      return {
        text: `[链接] ${title}${des ? `\n${des}` : ''}`.trim(),
        extra,
        mediaKind: null,
      };
  }
}

/** 群聊消息 content 的前缀 "senderId:\n" 拆出(参考 MessageParser.cpp) */
function stripSenderPrefix(content) {
  if (typeof content !== 'string') return { senderId: '', content };
  const idx = content.indexOf(':\n');
  if (idx > 0 && idx <= 64 && !content.slice(0, idx).includes('<')) {
    return { senderId: content.slice(0, idx), content: content.slice(idx + 2) };
  }
  return { senderId: '', content };
}

/** 引用内容可能带 "发送者:\n" 前缀;取出从第一个 < 开始的 XML。 */
function extractReferXml(content) {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw) return '';
  if (raw.startsWith('<')) return raw;
  const start = raw.indexOf('<');
  if (start <= 0 || start > 256) return '';
  const prefix = raw.slice(0, start).trim();
  if (!prefix || /[<>\n]/.test(prefix)) return '';
  return raw.slice(start);
}

function compactFinder(finder) {
  if (!finder || typeof finder !== 'object') return null;
  return {
    objectId: String(finder.objectId || ''),
    objectNonceId: String(finder.objectNonceId || ''),
    nickname: String(finder.nickname || ''),
    username: String(finder.username || ''),
    avatar: String(finder.avatar || ''),
    desc: String(finder.desc || ''),
    feedType: Number(finder.feedType) || 0,
    mediaType: Number(finder.mediaType) || 0,
    thumbUrl: String(finder.thumbUrl || ''),
    coverUrl: String(finder.coverUrl || ''),
    width: Number(finder.width) || 0,
    height: Number(finder.height) || 0,
    duration: Number(finder.duration) || 0,
  };
}

/**
 * 把引用消息的 refer 数据规范化为可直接渲染的结构。
 * 旧数据中 type 34/42/47/48/49/66 的 content 可能是带发送者前缀的原始 XML,
 * 这里统一解析;解析失败时降级为 [消息],避免把 XML 直接显示给用户。
 */
function normalizeRefer(refer) {
  if (!refer || typeof refer !== 'object') return refer;
  const type = Number(refer.type) || 0;
  const rawContent = typeof refer.content === 'string' ? refer.content : '';
  const xml = [34, 42, 47, 48, 49, 66].includes(type)
    ? extractReferXml(rawContent)
    : '';
  let parsed = null;
  if (xml) {
    try {
      parsed = parseMessageContent(type, xml);
    } catch (err) {
      parsed = null;
    }
  }
  const parsedExtra = parsed && parsed.extra && typeof parsed.extra === 'object'
    ? parsed.extra
    : {};
  let content = parsed && parsed.text ? parsed.text : rawContent;
  if (!xml) {
    if (type === 3) content = '[图片]';
    else if (type === 43 || type === 62) content = '[视频]';
    else if (type === 34) content = '[语音]';
    else if (type === 47) content = '[动画表情]';
  }
  if (type === 48 && parsedExtra && (parsedExtra.poiname || parsedExtra.label)) {
    content = `[位置] ${parsedExtra.poiname || parsedExtra.label}`.trim();
  }
  if (/^\s*</.test(content) || (!parsed && /<[a-z!/?]/i.test(content))) content = '[消息]';

  const finder = compactFinder(parsedExtra.finder);
  const normalized = {
    ...refer,
    content,
    mediaKind: parsed && parsed.mediaKind ? parsed.mediaKind : '',
  };
  if (parsedExtra.appType !== undefined) normalized.appType = Number(parsedExtra.appType) || 0;
  if (parsedExtra.title) normalized.title = String(parsedExtra.title);
  if (parsedExtra.des) normalized.des = String(parsedExtra.des);
  if (parsedExtra.url) normalized.url = String(parsedExtra.url);
  if (parsedExtra.sourceDisplayName) {
    normalized.sourceDisplayName = String(parsedExtra.sourceDisplayName);
  }
  if (parsedExtra.thumburl || parsedExtra.thumbUrl) {
    normalized.thumbUrl = String(parsedExtra.thumburl || parsedExtra.thumbUrl);
  }
  if (finder) {
    normalized.finder = finder;
    if (!normalized.thumbUrl) normalized.thumbUrl = finder.thumbUrl || finder.coverUrl || '';
  }
  if (parsedExtra.weapp) normalized.weapp = parsedExtra.weapp;
  if (parsedExtra.fileExt || parsedExtra.fileName) {
    normalized.fileExt = String(parsedExtra.fileExt || '');
    normalized.fileName = String(parsedExtra.fileName || '');
  }
  if (type === 42 || type === 66) {
    normalized.nickname = String(parsedExtra.nickname || '');
    normalized.username = String(parsedExtra.username || '');
  }
  if (type === 48) {
    normalized.location = {
      latitude: Number(parsedExtra.latitude) || 0,
      longitude: Number(parsedExtra.longitude) || 0,
      label: String(parsedExtra.label || ''),
      poiname: String(parsedExtra.poiname || ''),
    };
  }
  return normalized;
}

module.exports = {
  parseMessageContent,
  tryParseXml,
  stripSenderPrefix,
  normalizeRefer,
  nodeText,
  first,
};
