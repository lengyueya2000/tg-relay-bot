// 本地逻辑自测:模拟 Telegram API 和 KV,覆盖私聊模式 + 群组话题模式完整链路
// 运行: node test.mjs
import worker from './src/index.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) failed++;
}

// 捕获所有对 Telegram API 的调用
const tgCalls = [];
let nextId = 1000;
globalThis.fetch = async (url, opts) => {
  const m = String(url).match(/bot[^/]+\/(\w+)$/);
  const isUpload = opts && opts.body instanceof FormData;
  tgCalls.push({
    method: m ? m[1] : 'sendPhoto(multipart)',
    payload: isUpload ? { chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), message_thread_id: opts.body.get('message_thread_id') } : JSON.parse(opts.body),
  });
  const result = { message_id: ++nextId };
  if (m && m[1] === 'createForumTopic') result.message_thread_id = 500;
  if (m && m[1] === 'getChatMember') Object.assign(result, { status: 'administrator', can_manage_topics: true, can_delete_messages: true });
  // 模拟删除无权限:删除消息 id 666 时失败
  if (m && m[1] === 'deleteMessage' && JSON.parse(opts.body).message_id === 666) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Need administrator rights' }));
  // 模拟建话题失败:群 id -100999
  if (m && m[1] === 'createForumTopic' && JSON.parse(opts.body).chat_id === -100999) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'no rights' }));
  // 置顶成功
  if (m && m[1] === 'pinChatMessage') return new Response(JSON.stringify({ ok: true, result: true }));
  if (m && m[1] === 'copyMessage' || m && m[1] === 'sendMessage' || m && m[1] === 'sendPhoto') result.photo = [{ file_id: 'small' }, { file_id: 'big' }];
  return new Response(JSON.stringify({ ok: true, result }));
};

// 内存版 KV
const kvStore = new Map();
const env = {
  BOT_TOKEN: '123456789:TEST_FAKE_TOKEN',
  ADMIN_ID: '999',
  WEBHOOK_SECRET: 'sec',
    RELAY_KV: {
    put: (k, v, o) => (kvStore.set(k, v), Promise.resolve()),
    get: (k) => Promise.resolve(kvStore.get(k) ?? null),
    delete: (k) => (kvStore.delete(k), Promise.resolve()),
    list: ({ prefix, cursor }) => {
      const keys = [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return Promise.resolve({ keys, list_complete: true, cursor: '' });
    },
  },
};

const ctx = { waitUntil(p) { this._tasks.push(p); }, _tasks: [] };
async function deliver(update) {
  ctx._tasks = [];
  await worker.fetch(new Request('https://bot.example/sec', { method: 'POST', body: JSON.stringify(update) }), env, ctx);
  await Promise.all(ctx._tasks);
}
const last = (n = 1) => tgCalls.slice(-n);
const find = (method) => tgCalls.filter((c) => c.method === method);

// ========== 私聊模式(未绑群) ==========

// 1. 用户发文字 -> 首次:名片 + 内容两条
await deliver({ message: { chat: { id: 111, type: 'private' }, from: { id: 111, first_name: '小明', username: 'xm' }, message_id: 5, text: '你好' } });
let [card1, content1] = last(2);
assert(card1.method === 'sendMessage' && card1.payload.text.includes('#u111') && card1.payload.text.includes('小明'), '私聊: 首次名片带标识');
assert(content1.payload.text.includes('你好') && !content1.payload.text.includes('blockquote'), '私聊: 内容原样发送(无引用块)');

// 1b. 第二条消息不再发名片
const callsAfterFirst = tgCalls.length;
const idAfterFirst = nextId;
await deliver({ message: { chat: { id: 111, type: 'private' }, from: { id: 111, first_name: '小明' }, message_id: 12, text: '第二条' } });
assert(tgCalls.length === callsAfterFirst + 1, '私聊: 老访客不再发名片');
assert(last()[0].payload.text.includes('第二条'), '私聊: 老访客内容正常转发');
const CARD1 = idAfterFirst - 1, CONTENT1 = idAfterFirst;
assert(JSON.parse(kvStore.get(`m:999:${CARD1}`)).m === null, '私聊: 名片映射(不引用)');
assert(JSON.parse(kvStore.get(`m:999:${CONTENT1}`)).m === 5, '私聊: 内容映射(引用消息5)');

// 2. 管理员私聊回复内容消息 -> 引用;回复名片 -> 不引用
await deliver({ message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, message_id: 10, reply_to_message: { message_id: CONTENT1 }, text: '引用回复' } });
let [q1] = last();
assert(q1.method === 'copyMessage' && q1.payload.chat_id === 111 && q1.payload.reply_to_message_id === 5, '私聊: 回复内容 -> 引用原消息');
await deliver({ message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, message_id: 11, reply_to_message: { message_id: CARD1 }, text: '普通回复' } });
let [q2] = last();
assert(q2.payload.reply_to_message_id === undefined, '私聊: 回复名片 -> 不引用');

// 2b. 发送后不再自动点赞
assert(!find('setMessageReaction').length, '发送后不自动点赞');

// 3. 访客编辑 -> 管理员侧原地更新
await deliver({ edited_message: { chat: { id: 111, type: 'private' }, from: { id: 111 }, message_id: 5, text: '你好(改)' } });
assert(last()[0].method === 'editMessageText' && last()[0].payload.text.includes('你好(改)'), '私聊: 访客编辑同步');
assert(last()[0].payload.text.includes('✏️ 已编辑'), '私聊: 访客编辑带已编辑标记');

// 3c. 把消息编辑成 /命令 -> 仍按编辑处理,不触发欢迎语
const callsBeforeCmdEdit = tgCalls.length;
await deliver({ edited_message: { chat: { id: 111, type: 'private' }, from: { id: 111 }, message_id: 12, text: '/start' } });
assert(tgCalls.length === callsBeforeCmdEdit + 1 && last()[0].method === 'editMessageText', '编辑成命令仍按编辑处理');

// ========== 群组绑定 ==========

// 4. 未开话题的群 -> 提示
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: false }, from: { id: 999 }, message_id: 20, text: '/setup' } });
assert(last()[0].payload.text.includes('话题'), 'setup: 未开话题给提示');

// 5. 开了话题的群 -> 绑定成功
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 21, text: '/setup' } });
assert(last()[0].payload.text.includes('✅'), 'setup: 绑定成功');
assert(JSON.parse(kvStore.get('cfg:group')) === -100123, 'setup: 群ID已存KV');

// ========== 群组话题模式 ==========

// 6. 用户发文字 -> 建话题 + 名片 + 内容都进话题
await deliver({ message: { chat: { id: 222, type: 'private' }, from: { id: 222, first_name: '小红' }, message_id: 6, text: '在吗' } });
const topic = find('createForumTopic')[0];
assert(topic && topic.payload.chat_id === -100123 && topic.payload.name.includes('小红') && topic.payload.name.includes('#u222'), '群组: 自动创建访客话题');
assert(kvStore.get('t:222') === '500' && kvStore.get('g:500') === '222', '群组: 话题双向映射已存');
const allMsgs = tgCalls.filter((c) => ['sendMessage', 'sendPhoto', 'multipart'].includes(c.method));
const gcard = allMsgs[allMsgs.length - 2], gcontent = allMsgs[allMsgs.length - 1];
assert(gcard.payload.message_thread_id === 500 && gcontent.payload.message_thread_id === 500, '群组: 名片和内容都发进话题');
const GCARD = nextId - 1, GCONTENT = nextId;
assert(JSON.parse(kvStore.get(`r:222:6`)) === GCONTENT, '群组: 反向映射已存');

// 7. 第二条消息复用话题,不再建
const beforeCnt = find('createForumTopic').length;
await deliver({ message: { chat: { id: 222, type: 'private' }, from: { id: 222, first_name: '小红' }, message_id: 7, photo: [{ file_id: 'p1' }] } });
assert(find('createForumTopic').length === beforeCnt, '群组: 话题复用不重建');
assert(last()[0].method === 'copyMessage' && last()[0].payload.message_thread_id === 500, '群组: 图片进同一话题');
assert(find('pinChatMessage').length >= 1 && find('pinChatMessage')[0].payload.chat_id === -100123, '群组: 首次名片已自动置顶');

// 8. 管理员在话题里直接说话(不回复) -> 发给该访客,不引用
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 30, message_thread_id: 500, text: '直接回复你' } });
let [f1] = last();
assert(f1.method === 'copyMessage' && f1.payload.chat_id === 222 && f1.payload.reply_to_message_id === undefined, '群组: 话题内直接说话 -> 回复访客');

// 9. 管理员回复话题里的某条消息 -> 引用
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 31, message_thread_id: 500, reply_to_message: { message_id: GCONTENT }, text: '引用你' } });
let [f2] = last();
assert(f2.payload.chat_id === 222 && f2.payload.reply_to_message_id === 6, '群组: 回复消息 -> 引用原消息');

// 10. 访客编辑 -> 话题里的消息原地更新
await deliver({ edited_message: { chat: { id: 222, type: 'private' }, from: { id: 222 }, message_id: 6, text: '在吗(改)' } });
assert(last()[0].method === 'editMessageText' && last()[0].payload.chat_id === -100123, '群组: 访客编辑同步到话题');

// 11. 管理员编辑自己发的消息(群消息id=30) -> 用户侧同步 + ✍ 提示
await deliver({ edited_message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 30, text: '直接回复你(改)' } });
let [e2, e2r] = last(2);
assert(e2.method === 'editMessageText' && e2.payload.chat_id === 222, '群组: 管理员编辑同步到用户');
assert(e2.payload.text.includes('✏️ 已编辑'), '群组: 编辑同步带已编辑标记');
assert(e2r.method === 'setMessageReaction' && e2r.payload.reaction[0].emoji === '✍', '群组: 编辑同步后打 ✍');

// 12b. /stats 统计命令
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 33, text: '/setup' } });
const statsCalls = tgCalls.length;
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 34, text: '/stats' } });
const statsMsg = tgCalls[tgCalls.length - 1];
assert(statsMsg.method === 'sendMessage' && statsMsg.payload.text.includes('访客数'), 'stats: 有统计输出');
const m1 = statsMsg.payload.text.match(/访客数\(话题数\): (\d+)/);
assert(m1 && Number(m1[1]) >= 1, 'stats: 访客数正确');

// 12c. /del:回复一条已同步发出的消息 -> 删除管理员侧消息 + 用户侧副本,清理映射
const sMap2 = JSON.parse(kvStore.get('s:-100123:30'));
assert(sMap2 && sMap2.c === 222, 'del 前置: s 映射存在');
const delCallsBefore = tgCalls.length;
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 40, reply_to_message: { message_id: 30 }, text: '/del' } });
const dels = tgCalls.slice(delCallsBefore);
assert(dels[0].method === 'deleteMessage' && dels[0].payload.chat_id === -100123 && dels[0].payload.message_id === 30, 'del: 删除管理员侧消息');
assert(dels[1].method === 'deleteMessage' && dels[1].payload.chat_id === 222 && dels[1].payload.message_id === sMap2.s, 'del: 同步删除用户侧副本');
assert(kvStore.get('s:-100123:30') === undefined && kvStore.get('m:-100123:30') === undefined, 'del: 映射已清理');

// 12d. /del 不回复任何消息 -> 提示
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 41, text: '/del' } });
assert(last()[0].payload.text.includes('长按'), 'del: 未回复时提示');

// 12e. /del 无权限 -> 报错提示
const errCallsBefore = tgCalls.length;
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 42, reply_to_message: { message_id: 666 }, text: '/del' } });
const errMsg = tgCalls.find((c, i) => i >= errCallsBefore && c.method === 'sendMessage');
assert(errMsg && errMsg.payload.text.includes('删除失败') && errMsg.payload.text.includes('权限'), 'del: 失败时提示原因');
// /del 的命令消息本身也被删除
assert(find('deleteMessage').some((c) => c.payload.message_id === 42), 'del: 命令消息自身也删除');

// 12e2. /ban 拉黑访客
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 43, reply_to_message: { message_id: GCONTENT }, text: '/ban 提醒' } });
const banConfirm = tgCalls[tgCalls.length - 2], banNotify = last()[0];
assert(banConfirm.payload.text.includes('已拉黑') && banConfirm.payload.text.includes('#u222'), 'ban: 确认消息带访客ID');
assert(banNotify.payload.chat_id === 222 && banNotify.payload.text.includes('限制'), 'ban: 提醒通知发给访客');
assert((await env.RELAY_KV.get('ban:222')) !== null, 'ban: KV 已记录');
// 拉黑后访客发消息被忽略
const callsAfterBan = tgCalls.length;
await deliver({ message: { chat: { id: 222, type: 'private' }, from: { id: 222, first_name: '小红' }, message_id: 9, text: '还收得到吗' } });
assert(tgCalls.length === callsAfterBan, 'ban: 拉黑后消息被忽略');
// /unban 解除
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 44, reply_to_message: { message_id: GCONTENT }, text: '/unban' } });
assert(last()[0].payload.text.includes('解除'), 'unban: 确认消息');
assert((await env.RELAY_KV.get('ban:222')) === null, 'unban: KV 已清除');
// 解除后恢复转发
const callsAfterUnban = tgCalls.length;
await deliver({ message: { chat: { id: 222, type: 'private' }, from: { id: 222, first_name: '小红' }, message_id: 10, text: '恢复了吗' } });
assert(tgCalls.length > callsAfterUnban && last()[0].payload.text.includes('恢复了吗'), 'unban: 解除后恢复转发');

// 12f. /unbind 解绑后回到私聊模式
await deliver({ message: { chat: { id: -100123, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 32, text: '/unbind' } });
assert(last()[0].payload.text.includes('解绑'), 'unbind: 有解绑提示');
assert((await env.RELAY_KV.get('cfg:group')) === null, 'unbind: 配置已删除');
await deliver({ message: { chat: { id: 333, type: 'private' }, from: { id: 333, first_name: '路人' }, message_id: 8, text: 'hello' } });
assert(last(2)[0].payload.chat_id === 999, '解绑后: 新访客回到私聊名片模式');

// 12g. 重新绑群后话题创建失败 -> 消息降级发到 General(不带 thread 参数)
await deliver({ message: { chat: { id: -100999, type: 'supergroup', is_forum: true }, from: { id: 999 }, message_id: 45, text: '/setup' } });
await deliver({ message: { chat: { id: 555, type: 'private' }, from: { id: 555, first_name: '降级客' }, message_id: 50, text: '还能发吗' } });
const fallbackMsg = last()[0];
assert(fallbackMsg.method === 'sendMessage' && fallbackMsg.payload.chat_id === -100999, '降级: 消息仍能发到群里');
assert(fallbackMsg.payload.message_thread_id === undefined, '降级: 不带非法的 null thread');

// 13. 错误路径返回 404
const badRes = await worker.fetch(new Request('https://bot.example/wrong', { method: 'POST', body: '{}' }), env, { waitUntil() {} });
assert(badRes.status === 404, '错误 webhook 路径返回 404');

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 个用例失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
