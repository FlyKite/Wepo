/**
 * 微信消息类型常量。
 */
const MSG_TYPE = {
  TEXT: 1, // 文本
  IMAGE: 3, // 图片
  VOICE: 34, // 语音
  PUSHMAIL: 35, // QQ 邮箱提醒
  VERIFYMSG: 37, // 好友验证
  POSSIBLEFRIEND: 40, // 好友推荐
  SHARECARD: 42, // 名片
  VIDEO: 43, // 视频
  EMOTICON: 47, // 表情
  LOCATION: 48, // 位置
  APP: 49, // 应用消息(链接/文件/小程序等)
  VOIPMSG: 50, // 语音/视频通话
  STATUSNOTIFY: 51, // 状态通知(打开聊天窗口等)
  VOIPNOTIFY: 52, // 通话通知
  VOIPINVITE: 53, // 通话邀请
  NOTICE: 64, // 群公告
  IMCARD: 66, // 群名片
  MICROVIDEO: 62, // 小视频
  SYSNOTICE: 9999, // 系统通知
  SYS: 10000, // 系统消息
  RECALLED: 10002, // 撤回消息
};

/** 消息类型 → 中文占位描述(用于聊天列表最后一条消息预览) */
const MSG_TYPE_LABEL = {
  [MSG_TYPE.TEXT]: '文本',
  [MSG_TYPE.IMAGE]: '[图片]',
  [MSG_TYPE.VOICE]: '[语音]',
  [MSG_TYPE.PUSHMAIL]: '[邮件]',
  [MSG_TYPE.VERIFYMSG]: '[好友验证]',
  [MSG_TYPE.POSSIBLEFRIEND]: '[好友推荐]',
  [MSG_TYPE.SHARECARD]: '[名片]',
  [MSG_TYPE.VIDEO]: '[视频]',
  [MSG_TYPE.EMOTICON]: '[表情]',
  [MSG_TYPE.LOCATION]: '[位置]',
  [MSG_TYPE.APP]: '[链接]',
  [MSG_TYPE.VOIPMSG]: '[通话]',
  [MSG_TYPE.STATUSNOTIFY]: '',
  [MSG_TYPE.VOIPNOTIFY]: '[通话通知]',
  [MSG_TYPE.VOIPINVITE]: '[通话邀请]',
  [MSG_TYPE.NOTICE]: '[群公告]',
  [MSG_TYPE.IMCARD]: '[群名片]',
  [MSG_TYPE.MICROVIDEO]: '[视频]',
  [MSG_TYPE.SYSNOTICE]: '[系统通知]',
  [MSG_TYPE.SYS]: '[系统消息]',
  [MSG_TYPE.RECALLED]: '[撤回了一条消息]',
};

/** 联系人类型(参考 WeChat 内部定义) */
const CONTACT_TYPE = {
  DEFAULT: 0, // 普通好友
  OFFICIAL: 3, // 公众号
  // 其它: 4 可能是企业号等
};

/** 判断 username 是否为群聊 */
function isChatroom(username) {
  return typeof username === 'string' && username.endsWith('@chatroom');
}

/** 判断 username 是否为公众号/订阅号 */
function isOfficialAccount(username) {
  return typeof username === 'string' && (username.startsWith('gh_') || username.endsWith('@stranger'));
}

module.exports = {
  MSG_TYPE,
  MSG_TYPE_LABEL,
  CONTACT_TYPE,
  isChatroom,
  isOfficialAccount,
};
