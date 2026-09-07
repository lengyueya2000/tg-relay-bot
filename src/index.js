// Telegram 双向私聊转发机器人 — Cloudflare Worker
//
// 两种管理模式:
//   A. 群组+话题模式(推荐):把机器人拉进一个开了"话题"功能的群,发 /setup 绑定。
//      每个访客自动获得一个专属话题(名字 + #ID),在谁的话题里说话就回复谁。
//   B. 私聊模式(默认):访客消息发到管理员私聊,长按名片回复 = 不引用,
//      长按内容回复 = 引用回复。
//   双向都支持编辑同步(48 小时内)。

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 路径里带密钥,防止 webhook 被人乱调
    if (request.method !== 'POST' || url.pathname !== '/' + env.WEBHOOK_SECRET) {
      return new Response('Not Found', { status: 404 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('ok');
    }

    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('handleUpdate error:', e)));
    return new Response('ok');
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const isEdit = !update.message; // edited_message -> 是一次编辑
  const adminId = Number(env.ADMIN_ID);
  const from = msg.from || {};

  if (msg.chat.type === 'private') {
    if (from.id === adminId) {
      await handleAdminDM(msg, env, isEdit);
    } else {
      await handleUser(msg, env, isEdit);
    }
    return;
  }

  if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') {
    // /setup:管理员在群里绑定工作群
    if (from.id === adminId && !isEdit && msg.text && msg.text.startsWith('/setup')) {
      await setupGroup(msg, env);
      return;
    }
    const groupId = await getGroupId(env);
    if (groupId && msg.chat.id === groupId && from.id === adminId) {
      await handleGroupAdmin(msg, env, isEdit);
    }
  }
}

// ---------------------------------------------------------------- 群组绑定

// 群 ID 有 60 秒进程内缓存,省去每条消息一次 KV 读;绑/解绑时主动失效
let groupIdCache = { value: undefined, at: 0 };
async function getGroupId(env) {
  if (Date.now() - groupIdCache.at < 60_000) return groupIdCache.value;
  const raw = await env.RELAY_KV.get('cfg:group');
  groupIdCache = { value: raw ? JSON.parse(raw) : null, at: Date.now() };
  return groupIdCache.value;
}
function invalidateGroupCache() {
  groupIdCache = { value: undefined, at: 0 };
}

async function setupGroup(msg, env) {
  if (!msg.chat.is_forum) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '❌ 请先在群组设置里开启「话题 / Topics」功能(群管理 -> 话题),然后重新发送 /setup',
    });
    return;
  }
  const botId = Number(env.BOT_TOKEN.split(':')[0]);
  const me = await tg(env, 'getChatMember', { chat_id: msg.chat.id, user_id: botId });
  const ok = me.ok && me.result.status === 'administrator' && me.result.can_manage_topics;
  if (!ok) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '❌ 请先把我设为群管理员,并勾选「管理话题」权限,然后重新发送 /setup',
    });
    return;
  }
  await env.RELAY_KV.put('cfg:group', JSON.stringify(msg.chat.id));
  invalidateGroupCache();
  // 缺「删除消息」权限时提醒,但不阻塞绑定
  const permHint = me.ok && me.result.can_delete_messages
    ? ''
    : '\n\n⚠️ 我还没有「删除消息」权限,/del 命令无法使用。请在群管理员设置里给我勾选「删除消息」。';
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: '✅ 已绑定本群作为客服工作群!\n之后每个访客会自动获得一个专属话题,在谁的话题里发消息就会回复给谁,回复某条消息则引用该消息。\n\n可用命令:\n/unbind 解绑本群\n/stats 查看统计' + permHint,
  });
}

// ---------------------------------------------------------------- 访客 -> 管理员

async function handleUser(msg, env, isEdit) {
  const from = msg.from || {};
  const adminChatId = Number(env.ADMIN_ID);

  // /命令 -> 欢迎语(编辑成命令不算,避免误触发)
  if (!isEdit && msg.text && msg.text.startsWith('/')) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '你好!直接发送消息即可联系管理员,支持文字、图片、视频、文件等。',
    });
    return;
  }

  // 被拉黑的访客:消息直接忽略
  if (await env.RELAY_KV.get(`ban:${from.id}`)) return;

  const groupId = await getGroupId(env);
  if (groupId) {
    await relayToGroup(env, msg, groupId, isEdit);
  } else {
    await relayToDM(env, msg, adminChatId, isEdit);
  }
}

// ---- 群组+话题模式 ----

async function relayToGroup(env, msg, groupId, isEdit) {
  const from = msg.from || {};

  // 访客编辑消息 -> 原地更新话题里的内容消息
  if (isEdit) return syncUserEdit(msg, env, groupId);

  const thread = await ensureTopic(env, groupId, from);

  // 名片只在访客首次进入时发一次,后续消息直接发内容;名片自动置顶方便找新访客
  if (await markUserSeen(env, from.id)) {
    const cardId = await sendAvatarCard(env, from, groupId, thread, buildQuote(msg));
    if (cardId) {
      await saveMap(env, groupId, cardId, msg.chat.id, null);
      if (thread) await tg(env, 'pinChatMessage', { chat_id: groupId, message_id: cardId });
    }
  }

  // ② 内容消息(话题创建失败时落到 General,不带 thread 参数)
  const opts = thread ? { chat_id: groupId, message_thread_id: thread } : { chat_id: groupId };
  if (msg.text) {
    const sent = await tg(env, 'sendMessage', {
      ...opts,
      ...visitorTextHtml(msg.text),
    });
    if (sent.ok) {
      await saveMap(env, groupId, sent.result.message_id, msg.chat.id, msg.message_id);
      await saveReverse(env, msg.chat.id, msg.message_id, sent.result.message_id);
    }
    return;
  }

  const copied = await tg(env, 'copyMessage', { ...opts, from_chat_id: msg.chat.id, message_id: msg.message_id });
  if (copied.ok) {
    await saveMap(env, groupId, copied.result.message_id, msg.chat.id, msg.message_id);
    await saveReverse(env, msg.chat.id, msg.message_id, copied.result.message_id);
  } else {
    await tg(env, 'sendMessage', {
      ...opts,
      text: `⚠️ 有一条${describeType(msg)}转发失败: ${copied.description || '未知错误'}`,
    });
  }
}

// 确保访客有专属话题,返回 thread_id(创建失败返回 null,消息落到 General)
async function ensureTopic(env, groupId, from) {
  const key = `t:${from.id}`;
  const raw = await env.RELAY_KV.get(key);
  if (raw) return JSON.parse(raw);

  const name = truncate(
    [from.first_name, from.last_name].filter(Boolean).join(' ') || `用户${from.id}`,
    96
  ) + ` #u${from.id}`;
  const colors = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
  // 简单取模容易撞色(低位数字相同的 ID 颜色一样),用 FNV-1a 哈希让颜色分布均匀
  let hash = 2166136261;
  for (const c of String(from.id)) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const colorIndex = (hash >>> 0) % colors.length;
  const r = await tg(env, 'createForumTopic', {
    chat_id: groupId,
    name,
    icon_color: colors[colorIndex],
  });
  if (!r.ok) {
    console.error('createForumTopic failed:', r.description);
    return null;
  }
  const thread = r.result.message_thread_id;
  await env.RELAY_KV.put(key, JSON.stringify(thread));
  // 话题 -> 访客,方便管理员在话题里直接说话(不引用)
  await env.RELAY_KV.put(`g:${thread}`, JSON.stringify(from.id));
  return thread;
}

// ---- 私聊模式(未绑群时的兜底) ----

async function relayToDM(env, msg, adminChatId, isEdit) {
  const from = msg.from || {};

  if (isEdit) return syncUserEdit(msg, env, adminChatId);

  // 名片只在访客首次进入时发一次
  if (await markUserSeen(env, from.id)) {
    const cardId = await sendAvatarCard(env, from, adminChatId, null, buildQuote(msg));
    if (cardId) await saveMap(env, adminChatId, cardId, msg.chat.id, null);
  }

  if (msg.text) {
    const sent = await tg(env, 'sendMessage', {
      chat_id: adminChatId,
      ...visitorTextHtml(msg.text),
    });
    if (sent.ok) {
      await saveMap(env, adminChatId, sent.result.message_id, msg.chat.id, msg.message_id);
      await saveReverse(env, msg.chat.id, msg.message_id, sent.result.message_id);
    }
    return;
  }

  const copied = await tg(env, 'copyMessage', {
    chat_id: adminChatId,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (copied.ok) {
    await saveMap(env, adminChatId, copied.result.message_id, msg.chat.id, msg.message_id);
    await saveReverse(env, msg.chat.id, msg.message_id, copied.result.message_id);
  } else {
    await tg(env, 'sendMessage', {
      chat_id: adminChatId,
      text: `⚠️ 有一条${describeType(msg)}转发失败: ${copied.description || '未知错误'}`,
    });
  }
}

// 访客编辑消息后,同步更新管理员侧那条内容消息
async function syncUserEdit(msg, env, adminChatId) {
  const raw = await env.RELAY_KV.get(`r:${msg.chat.id}:${msg.message_id}`);
  if (!raw) return; // 旧消息或之前转发失败,忽略
  const adminMsgId = JSON.parse(raw);

  let r = { ok: true };
  if (msg.text) {
    const body = visitorTextHtml(msg.text, '\n\n✏️ 已编辑');
    r = await tg(env, 'editMessageText', {
      chat_id: adminChatId,
      message_id: adminMsgId,
      text: body.text,
      parse_mode: body.parse_mode,
    });
  } else if (msg.caption) {
    r = await tg(env, 'editMessageCaption', {
      chat_id: adminChatId,
      message_id: adminMsgId,
      caption: `${msg.caption}\n\n✏️ 已编辑`,
    });
  } else {
    return; // 媒体本身被替换,机器人无法修改已转发媒体,忽略
  }

  if (!r.ok) {
    // 超过 48 小时等无法编辑的情况,补发一条说明
    await tg(env, 'sendMessage', {
      chat_id: adminChatId,
      text: `✏️ 对方修改了消息(无法直接编辑原消息):\n${truncate(msg.text || msg.caption || '', 500)}`,
    });
  }
}

// /del 命令:长按消息回复 /del,删除这条消息并同步清理对方侧副本和映射
async function handleDelCommand(msg, env) {
  const r = msg.reply_to_message;
  if (!r) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '请长按要删除的消息回复 /del。' });
    return;
  }

  // 管理员侧:群里机器人是管理员可删任意消息;私聊里只能删机器人自己的
  // 无论这边成败,都继续删用户侧副本,避免访客还能看到
  const dr = await tg(env, 'deleteMessage', { chat_id: msg.chat.id, message_id: r.message_id });
  if (!dr.ok) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `⚠️ 管理员侧消息删除失败: ${dr.description || '未知错误'}\n若是权限问题,请在群管理员设置里给机器人勾选「删除消息」。(用户侧副本仍会尝试删除)`,
    });
  }

  // 用户侧副本:管理员转发出去的
  const sRaw = await env.RELAY_KV.get(`s:${msg.chat.id}:${r.message_id}`);
  let userSideOk = true;
  if (sRaw) {
    const { c: userChatId, s: userMsgId } = JSON.parse(sRaw);
    const ur = await tg(env, 'deleteMessage', { chat_id: userChatId, message_id: userMsgId });
    userSideOk = ur.ok;
    if (!ur.ok) {
      await tg(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: `⚠️ 访客侧删除失败(消息可能超过 48 小时): ${ur.description || '未知错误'}`,
      });
    }
  }
  // 用户侧原消息(删访客消息时):私聊里机器人无权删访客的消息,直接跳过

  // 哪边删成功就清哪边的映射;失败的保留,下次 /del 可重试
  if (dr.ok) await env.RELAY_KV.delete(`m:${msg.chat.id}:${r.message_id}`);
  if (userSideOk) await env.RELAY_KV.delete(`s:${msg.chat.id}:${r.message_id}`);

  // 把 /del 命令消息本身也删掉,不留垃圾
  await tg(env, 'deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
}

// /ban 命令:回复访客的某条消息 /ban,拉黑该访客(他的消息将被忽略)
// /ban 提醒:带上"提醒"两个字(如 "/ban 提醒"),会给对方发一条拉黑通知
async function handleBanCommand(msg, env) {
  const r = msg.reply_to_message;
  if (!r) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '请长按该访客的某条消息回复 /ban。加"提醒"二字(如 /ban 提醒)会通知对方。' });
    return;
  }
  const mRaw = await env.RELAY_KV.get(`m:${msg.chat.id}:${r.message_id}`);
  if (!mRaw) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '找不到这条消息对应的访客(只能拉黑访客,不能拉黑自己人)。' });
    return;
  }
  const { c: userChatId } = JSON.parse(mRaw);
  await env.RELAY_KV.put(`ban:${userChatId}`, JSON.stringify(Date.now()));
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `🔨 已拉黑 <code>#u${userChatId}</code>,他的消息将不再转发。回复 /unban 可解除。`, parse_mode: 'HTML' });

  if ((msg.text || '').includes('提醒')) {
    await tg(env, 'sendMessage', { chat_id: userChatId, text: '你已被管理员限制,消息将不再被转达。' });
  }
}

// /unban 命令:回复该访客的任意消息 /unban,解除拉黑
async function handleUnbanCommand(msg, env) {
  const r = msg.reply_to_message;
  if (!r) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '请长按该访客的某条消息回复 /unban。' });
    return;
  }
  const mRaw = await env.RELAY_KV.get(`m:${msg.chat.id}:${r.message_id}`);
  if (!mRaw) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '找不到这条消息对应的访客。' });
    return;
  }
  const { c: userChatId } = JSON.parse(mRaw);
  await env.RELAY_KV.delete(`ban:${userChatId}`);
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `✅ 已解除 <code>#u${userChatId}</code> 的拉黑。`, parse_mode: 'HTML' });
}

// 记录访客是否来过:首次返回 true
async function markUserSeen(env, userId) {
  const key = `u:${userId}`;
  const seen = await env.RELAY_KV.get(key);
  if (seen) return false;
  await env.RELAY_KV.put(key, JSON.stringify(1));
  return true;
}

// 发送访客名片:优先发真实头像图片,失败则退回文字卡片。返回管理员侧 message_id。
async function sendAvatarCard(env, from, chatId, thread, quote) {
  const header = buildHeader(from) + (quote ? '\n' + quote : '');
  const extra = thread ? { message_thread_id: thread } : {};

  // 之前上传过 -> 直接用缓存的 file_id,免重复下载
  const cached = await env.RELAY_KV.get(`pf:${from.id}`);
  if (cached) {
    const sent = await tg(env, 'sendPhoto', {
      chat_id: chatId,
      ...extra,
      photo: cached,
      caption: header,
      parse_mode: 'HTML',
    });
    if (sent.ok) return sent.result.message_id;
  }

  // 拉取访客的头像照片并上传到管理员会话
  try {
    const p = await tg(env, 'getUserProfilePhotos', { user_id: from.id, limit: 1 });
    const fid = p.ok && p.result.total_count > 0
      ? p.result.photos[0][p.result.photos[0].length - 1].file_id
      : null;

    if (fid) {
      const file = await tg(env, 'getFile', { file_id: fid });
      if (file.ok && file.result.file_path) {
        const bytes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`)
          .then((r) => r.arrayBuffer());

        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        if (thread) fd.append('message_thread_id', String(thread));
        fd.append('caption', header);
        fd.append('parse_mode', 'HTML');
        fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'avatar.jpg');
        const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({ ok: false }));
        if (data.ok) {
          // 缓存管理员侧这张照片的 file_id(7 天),下次秒发
          const photos = data.result.photo;
          await env.RELAY_KV.put(`pf:${from.id}`, photos[photos.length - 1].file_id, {
            expirationTtl: 60 * 60 * 24 * 7,
          });
          return data.result.message_id;
        }
      }
    }
  } catch (e) {
    console.error('avatar card failed:', e);
  }

  // 兜底:文字名片
  const sent = await tg(env, 'sendMessage', { chat_id: chatId, ...extra, text: header, parse_mode: 'HTML' });
  return sent.ok ? sent.result.message_id : null;
}

// ---------------------------------------------------------------- 管理员 -> 用户

// 私聊模式:仅通过回复名片/内容消息定向
async function handleAdminDM(msg, env, isEdit) {
  const text = msg.text || msg.caption || '';

  if (!isEdit && (text.startsWith('/start') || text.startsWith('/help'))) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '使用方法:\n长按头像(名片)回复 = 普通回复,不引用;\n长按消息内容回复 = 引用那条消息回复。\n\n💡 更推荐:建一个开启「话题」的群,把机器人拉进去设为管理员,发送 /setup 绑定,每个访客会自动获得独立话题。',
    });
    return;
  }
  if (!isEdit && text.startsWith('/id')) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `你的用户 ID: ${msg.from.id}` });
    return;
  }
  if (!isEdit && text.startsWith('/del')) {
    await handleDelCommand(msg, env);
    return;
  }
  if (!isEdit && text.startsWith('/ban')) {
    await handleBanCommand(msg, env);
    return;
  }
  if (!isEdit && text.startsWith('/unban')) {
    await handleUnbanCommand(msg, env);
    return;
  }

  if (isEdit) return syncAdminEdit(msg, env);

  const r = msg.reply_to_message;
  if (!r) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '请先长按头像(名片)或某条消息回复,我再帮你转发给对方。',
    });
    return;
  }
  const raw = await env.RELAY_KV.get(`m:${msg.chat.id}:${r.message_id}`);
  if (!raw) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '找不到这条消息对应的用户(记录可能已过期或不是用户消息)。',
    });
    return;
  }
  const { c: userChatId, m: userMsgId } = JSON.parse(raw);
  await forwardToUser(env, msg, userChatId, userMsgId);
}

// 群组模式:在谁的话题里说话就回复谁;回复某条消息则引用
async function handleGroupAdmin(msg, env, isEdit) {
  const text = msg.text || msg.caption || '';

  if (!isEdit && (text.startsWith('/start') || text.startsWith('/help'))) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '使用方法:\n在访客的话题里直接发消息 = 回复该访客(不引用);\n长按话题里某条消息回复 = 引用该消息回复。\n\n命令:\n/del 删除回复的消息(双向)\n/ban 拉黑访客(加"提醒"会通知对方)\n/unban 解除拉黑\n/stats 统计\n/unbind 解绑工作群',
    });
    return;
  }
  if (!isEdit && text.startsWith('/stats')) {
    const visitors = await countKeys(env, 't:');
    const pendingMaps = await countKeys(env, 'm:');
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `📊 统计:\n访客数(话题数): ${visitors}\n近 30 天消息映射: ${pendingMaps}`,
    });
    return;
  }
  if (!isEdit && text.startsWith('/unbind')) {
    await env.RELAY_KV.delete('cfg:group');
    invalidateGroupCache();
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: '✅ 已解绑工作群,访客消息将回到私聊模式。' });
    return;
  }
  if (!isEdit && text.startsWith('/id')) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `你的用户 ID: ${msg.from.id}` });
    return;
  }
  if (!isEdit && text.startsWith('/del')) {
    await handleDelCommand(msg, env);
    return;
  }
  if (!isEdit && text.startsWith('/ban')) {
    await handleBanCommand(msg, env);
    return;
  }
  if (!isEdit && text.startsWith('/unban')) {
    await handleUnbanCommand(msg, env);
    return;
  }

  if (isEdit) return syncAdminEdit(msg, env);

  let userChatId, userMsgId;
  const r = msg.reply_to_message;
  if (r) {
    const raw = await env.RELAY_KV.get(`m:${msg.chat.id}:${r.message_id}`);
    if (raw) {
      ({ c: userChatId, m: userMsgId } = JSON.parse(raw));
    }
  }
  if (userChatId === undefined) {
    // 没回复具体消息 -> 找话题对应的访客
    const raw = msg.message_thread_id && (await env.RELAY_KV.get(`g:${msg.message_thread_id}`));
    if (!raw) {
      await tg(env, 'sendMessage', {
        chat_id: msg.chat.id,
        text: '找不到这个话题对应的访客。在话题里直接说话,或长按某条访客消息回复。',
      });
      return;
    }
    userChatId = JSON.parse(raw);
  }

  await forwardToUser(env, msg, userChatId, userMsgId);
}

// 把管理员的内容原样发给用户,成功后记录编辑同步映射
async function forwardToUser(env, msg, userChatId, userMsgId) {
  const sent = await tg(env, 'copyMessage', {
    chat_id: userChatId,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
    reply_to_message_id: userMsgId ?? undefined,
  });

  if (sent.ok) {
    await env.RELAY_KV.put(
      `s:${msg.chat.id}:${msg.message_id}`,
      JSON.stringify({ c: userChatId, s: sent.result.message_id }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
  } else {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `发送失败: ${sent.description || '未知错误'}`,
    });
  }
}

// 管理员编辑已发送消息后,同步修改用户侧那条消息
async function syncAdminEdit(msg, env) {
  const raw = await env.RELAY_KV.get(`s:${msg.chat.id}:${msg.message_id}`);
  if (!raw) return; // 不是转发出去的消息,忽略
  const { c: userChatId, s: userMsgId } = JSON.parse(raw);

  const EDIT_MARK = '\n\n✏️ 已编辑';
  let r = { ok: true };
  if (msg.text) {
    r = await tg(env, 'editMessageText', {
      chat_id: userChatId,
      message_id: userMsgId,
      text: msg.text + EDIT_MARK,
      entities: msg.entities, // 标记追加在末尾,不影响原文本的格式偏移
    });
  } else if (msg.caption) {
    r = await tg(env, 'editMessageCaption', {
      chat_id: userChatId,
      message_id: userMsgId,
      caption: msg.caption + EDIT_MARK,
      caption_entities: msg.caption_entities,
    });
  } else {
    // 媒体被替换:用新 file_id 换掉用户侧媒体
    const media = mediaRef(msg);
    if (media) {
      r = await tg(env, 'editMessageMedia', {
        chat_id: userChatId,
        message_id: userMsgId,
        media: JSON.stringify({
          ...media,
          caption: msg.caption ? msg.caption + EDIT_MARK : undefined,
          caption_entities: msg.caption ? msg.caption_entities : undefined,
        }),
      });
    } else {
      return;
    }
  }

  if (!r.ok) {
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `⚠️ 编辑同步失败(消息可能超过 48 小时): ${r.description || '未知错误'}`,
    });
  } else {
    // 打个 ✍ 表示这次编辑已同步给对方
    await tg(env, 'setMessageReaction', {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reaction: [{ type: 'emoji', emoji: '✍' }],
    });
  }
}

function mediaRef(msg) {
  if (msg.photo) return { type: 'photo', media: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { type: 'video', media: msg.video.file_id };
  if (msg.document) return { type: 'document', media: msg.document.file_id };
  if (msg.audio) return { type: 'audio', media: msg.audio.file_id };
  if (msg.animation) return { type: 'animation', media: msg.animation.file_id };
  return null;
}

// ---------------------------------------------------------------- 工具函数

function buildHeader(from) {
  const name = escapeHtml([from.first_name, from.last_name].filter(Boolean).join(' ') || '匿名用户');
  const uname = from.username ? ` (@${from.username})` : '';
  return `👤 <b><a href="tg://user?id=${from.id}">${name}</a></b>${uname}\n🆔 <code>#u${from.id}</code>`;
}

// 访客文字统一用斜体,和管理员的消息区分开;超长时降级纯文本,避免转义后超 4096 上限
function visitorTextHtml(text, suffix = '') {
  const esc = escapeHtml(text);
  if (esc.length > 3800) return { text: suffix ? text + suffix : text };
  return { text: `<i>${esc}</i>${suffix}`, parse_mode: 'HTML' };
}

function buildQuote(msg) {
  const r = msg.reply_to_message;
  if (!r) return '';
  const q = r.text || r.caption;
  if (q) return `↩️ 引用: <i>${escapeHtml(truncate(q, 200))}</i>`;
  return `↩️ 引用: <i>[${describeType(r)}]</i>`;
}

function describeType(msg) {
  if (msg.photo) return '📷 图片';
  if (msg.video) return '🎬 视频';
  if (msg.video_note) return '⭕ 视频留言';
  if (msg.voice) return '🎤 语音';
  if (msg.audio) return '🎵 音频';
  if (msg.animation) return '🎞️ 动图';
  if (msg.sticker) return '🐾 贴纸';
  if (msg.document) return `📄 文件${msg.document.file_name ? `: ${msg.document.file_name}` : ''}`;
  if (msg.location) return '📍 位置';
  if (msg.contact) return '👤 联系人';
  return '📦 消息';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function saveMap(env, adminChatId, adminMsgId, userChatId, userMsgId) {
  await env.RELAY_KV.put(`m:${adminChatId}:${adminMsgId}`, JSON.stringify({ c: userChatId, m: userMsgId }), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

async function saveReverse(env, userChatId, userMsgId, adminMsgId) {
  await env.RELAY_KV.put(`r:${userChatId}:${userMsgId}`, JSON.stringify(adminMsgId), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

async function countKeys(env, prefix) {
  let count = 0;
  let cursor;
  do {
    const page = await env.RELAY_KV.list({ prefix, cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

async function tg(env, method, payload, retries = 2) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
  // 被限流时按 Telegram 给的等待时间重试(最多 2 次,单次最多等 8 秒)
  if (!data.ok && data.error_code === 429 && retries > 0) {
    const wait = Math.min((data.parameters && data.parameters.retry_after) || 2, 8);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return tg(env, method, payload, retries - 1);
  }
  if (!data.ok) console.error(`TG ${method} failed:`, data.description);
  return data;
}
