# TG 双向私聊转发机器人(Cloudflare Workers)

别人私聊你的机器人 → 你在群组话题(或私聊)里查看并回复 → 机器人把回复转给对方。
支持文字、图片、视频、语音、文件等任意消息类型;双向支持引用回复和**编辑同步**。

## 两种管理模式

### A. 群组 + 话题模式(推荐)

多人咨询时消息按访客隔离,互不干扰:

1. 新建群组,开启**话题(Topics)**功能(群设置 → 话题)
2. 把机器人拉进群,设为管理员,勾选「**管理话题**」权限
3. 在群里发送 **`/setup`**,回复 ✅ 即绑定成功

效果:
- 每个访客自动获得专属话题(标题 `访客昵称 #uID`,随机彩色图标)
- 他的名片(真实头像 + 标识)和所有消息都发进他的话题
- **在谁的话题里直接说话 = 回复谁**(不引用);**长按某条消息回复 = 引用该消息**
- 命令:`/setup` 绑定、`/unbind` 解绑、`/stats` 统计、`/id` 查 ID
- **`/del`**:长按要删的消息回复 `/del`,双向删除并清理记录(命令消息本身也会删掉)
- **`/ban`**:长按访客的消息回复 `/ban` 拉黑,他的消息不再转发;加"提醒"二字(如 `/ban 提醒`)会通知对方;`/unban` 解除
- 新访客的名片会自动置顶在他的话题里,方便发现新咨询

### B. 私聊模式(默认,未绑群时)

访客消息发到你的私聊,每条消息拆成两条:

1. **名片消息**:访客真实头像 + `👤 名字 (@用户名) #uID`(名字可点击打开资料)
2. **内容消息**:原内容

**长按名片回复 = 普通回复(不引用);长按内容回复 = 引用回复。**

## 通用功能

- **编辑双向同步**:访客改消息,你这边原地更新;你改回复,对方那边同步改(48 小时内)
- 名片头像缓存 7 天,同一访客只下载一次
- 发送成功自动打 👍;消息映射存 KV,有效期 30 天
- 访客回复你的消息时,名片上会带 `↩️ 引用` 摘录

## 部署步骤(已完成可跳过)

1. **@BotFather** `/newbot` 拿 Bot Token;**@userinfobot** 查自己的数字 ID
2. `npx wrangler login` 授权 Cloudflare
3. `npx wrangler kv namespace create RELAY_KV`,把 id 填进 `wrangler.toml`;
   `ADMIN_ID` 改成你的 ID;`WEBHOOK_SECRET` 改成随机字符串
4. `npx wrangler secret put BOT_TOKEN` 粘贴 Token,然后 `npx wrangler deploy`
5. 浏览器访问:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<workers地址>/<WEBHOOK_SECRET>&allowed_updates=["message","edited_message","callback_query"]`

> ⚠️ webhook 必须带 `allowed_updates` 且包含 `edited_message`,否则收不到编辑事件。

## 常用命令

```bash
npm run dev      # 本地调试(先复制 .dev.vars.example 为 .dev.vars 并填写)
npm run deploy   # 部署 / 更新
npm run tail     # 实时查看线上日志
node test.mjs    # 本地逻辑自测(无需 token)
```

## 费用与限制

- Workers 免费套餐每天 10 万请求,KV 免费额度充足,个人使用完全免费
- 机器人只能编辑 48 小时内自己发送的消息,超时编辑会提示同步失败
- copyMessage 在 Telegram 服务器端完成,不受机器人 20MB 下载限制
