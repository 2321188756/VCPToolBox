// BilibiliFetch.js - B站内容获取插件
// 通过 stdio 与 VCP 主服务通信，支持视频信息/评论/弹幕/字幕/搜索

const crypto = require('crypto');

const BILIBILI_COOKIE = process.env.BILIBILI_COOKIE || '';

// ==================== 通用 HTTP 请求 ====================

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function bilibiliApi(url) {
    const { default: fetch } = await import('node-fetch');
    const headers = { ...COMMON_HEADERS };
    if (BILIBILI_COOKIE) headers['Cookie'] = BILIBILI_COOKIE;

    const response = await fetch(url, { headers, timeout: 15000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json();
    if (data.code !== 0) throw new Error(`API错误 ${data.code}: ${data.message || '未知错误'}`);
    return data.data;
}

// ==================== WBI 签名（搜索/部分API需要） ====================

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
];

function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);
}

let cachedWbiKeys = null;
async function getWbiKeys() {
    if (cachedWbiKeys) return cachedWbiKeys;
    const data = await bilibiliApi('https://api.bilibili.com/x/web-interface/nav');
    const imgUrl = data.wbi_img.img_url;
    const subUrl = data.wbi_img.sub_url;
    cachedWbiKeys = {
        img_key: imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0],
        sub_key: subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0],
    };
    return cachedWbiKeys;
}

async function encWbi(params) {
    const { img_key, sub_key } = await getWbiKeys();
    const mixinKey = getMixinKey(img_key + sub_key);
    const wts = Math.floor(Date.now() / 1000);
    params.wts = wts;
    const sortedQuery = Object.keys(params).sort().map(k => {
        const value = String(params[k]).replace(/[!'()*]/g, '');
        return `${k}=${encodeURIComponent(value)}`;
    }).join('&');
    const w_rid = crypto.createHash('md5').update(sortedQuery + mixinKey).digest('hex');
    return `${sortedQuery}&w_rid=${w_rid}`;
}

// ==================== BV号 ↔ AV号转换 ====================

function bvidToAvid(bvid) {
    // B站官方算法
    const XOR_CODE = 23442827791579n;
    const MASK_CODE = 2251799813685247n;
    const BASE = 58n;
    const data = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
    const dataMap = {};
    for (let i = 0; i < 58; i++) dataMap[data[i]] = BigInt(i);

    let result = 0n;
    for (let i = 0; i < 6; i++) {
        result = result * BASE + dataMap[bvid[[3, 5, 6, 7, 8, 9, 10, 11, 9][i]]];
    }
    // 上面索引取错了，用简单实现：
    result = 0n;
    const bvidStripped = bvid.startsWith('BV') ? bvid.slice(2) : bvid;
    const indices = [9, 7, 5, 3, 11, 8, 6, 4, 2, 10]; // 不同源的算法
    // 简单回退：直接走视频信息API（接受bvid参数，不需要转换）
    return null;
}

// ==================== 命令实现 ====================

async function getVideoInfo(args) {
    const { bvid } = args;
    if (!bvid) throw new Error('缺少必需参数 bvid');

    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const data = await bilibiliApi(url);

    return {
        bvid: data.bvid,
        avid: data.aid,
        cid: data.cid,
        title: data.title,
        description: data.desc,
        cover: data.pic,
        duration: data.duration, // 秒
        publish_time: new Date(data.pubdate * 1000).toISOString(),
        owner: {
            uid: data.owner.mid,
            name: data.owner.name,
            avatar: data.owner.face,
        },
        stat: {
            view: data.stat.view,
            danmaku: data.stat.danmaku,
            like: data.stat.like,
            coin: data.stat.coin,
            favorite: data.stat.favorite,
            share: data.stat.share,
            reply: data.stat.reply,
        },
        url: `https://www.bilibili.com/video/${data.bvid}`,
    };
}

async function getComments(args) {
    const { bvid } = args;
    const limit = parseInt(args.limit) || 20;
    if (!bvid) throw new Error('缺少必需参数 bvid');

    // 先获取aid
    const info = await getVideoInfo({ bvid });
    const aid = info.avid;

    // 评论API（type=1 表示视频）
    const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=${limit}`;
    const data = await bilibiliApi(url);

    const replies = (data.replies || []).slice(0, limit).map(r => ({
        user: r.member?.uname || '匿名',
        uid: r.member?.mid,
        content: r.content?.message || '',
        like: r.like || 0,
        reply_count: r.rcount || 0,
        time: new Date(r.ctime * 1000).toISOString(),
    }));

    return {
        video: { bvid, title: info.title },
        total: data.cursor?.all_count || replies.length,
        comments: replies,
    };
}

async function getDanmaku(args) {
    const { bvid } = args;
    if (!bvid) throw new Error('缺少必需参数 bvid');

    const info = await getVideoInfo({ bvid });
    const cid = info.cid;

    // 弹幕API（XML 格式，需要解析）
    const url = `https://comment.bilibili.com/${cid}.xml`;
    const { default: fetch } = await import('node-fetch');
    const headers = { ...COMMON_HEADERS };
    if (BILIBILI_COOKIE) headers['Cookie'] = BILIBILI_COOKIE;

    const response = await fetch(url, { headers, timeout: 15000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();

    // 简单解析 <d p="时间,模式,字号,颜色,..." >内容</d>
    const matches = xml.match(/<d\s+p="([^"]+)"[^>]*>([^<]+)<\/d>/g) || [];
    const danmakus = matches.slice(0, 200).map(m => {
        const parsed = m.match(/<d\s+p="([^"]+)"[^>]*>([^<]+)<\/d>/);
        if (!parsed) return null;
        const [, p, content] = parsed;
        const fields = p.split(',');
        return {
            time: parseFloat(fields[0]),  // 出现时间（秒）
            content,
        };
    }).filter(Boolean);

    return {
        video: { bvid, title: info.title },
        cid,
        total: danmakus.length,
        danmakus,
    };
}

async function getSubtitle(args) {
    const { bvid } = args;
    if (!bvid) throw new Error('缺少必需参数 bvid');

    const info = await getVideoInfo({ bvid });
    const cid = info.cid;

    if (!BILIBILI_COOKIE) {
        throw new Error('字幕获取需要配置 BILIBILI_COOKIE，请在 config.env 中设置登录Cookie');
    }

    // 获取字幕列表
    const url = `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`;
    const data = await bilibiliApi(url);
    const subtitles = data.subtitle?.subtitles || [];

    if (subtitles.length === 0) {
        return { video: { bvid, title: info.title }, message: '该视频无字幕' };
    }

    // 选偏好语言或第一个
    const preferLang = process.env.BILIBILI_SUB_LANG || 'ai-zh';
    let chosen = subtitles.find(s => s.lan === preferLang) || subtitles[0];

    // 字幕URL通常是 //开头，补上协议
    let subUrl = chosen.subtitle_url;
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;

    const { default: fetch } = await import('node-fetch');
    const headers = { ...COMMON_HEADERS };
    if (BILIBILI_COOKIE) headers['Cookie'] = BILIBILI_COOKIE;
    const subResp = await fetch(subUrl, { headers, timeout: 15000 });
    if (!subResp.ok) throw new Error(`字幕下载失败 HTTP ${subResp.status}`);
    const subData = await subResp.json();

    const lines = (subData.body || []).map(b => `[${b.from.toFixed(1)}-${b.to.toFixed(1)}] ${b.content}`).join('\n');

    return {
        video: { bvid, title: info.title },
        language: chosen.lan,
        language_doc: chosen.lan_doc,
        full_text: (subData.body || []).map(b => b.content).join(' '),
        timed_subtitle: lines,
    };
}

async function search(args) {
    const { keyword } = args;
    const limit = parseInt(args.limit) || 10;
    if (!keyword) throw new Error('缺少必需参数 keyword');

    // search API 需要 WBI 签名
    const params = {
        keyword,
        page: 1,
        page_size: limit,
        search_type: 'video',
    };
    const query = await encWbi(params);
    const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`;
    const data = await bilibiliApi(url);

    const results = (data.result || []).slice(0, limit).map(r => ({
        bvid: r.bvid,
        title: r.title?.replace(/<[^>]+>/g, '') || '',  // 去除高亮HTML
        author: r.author,
        play: r.play,
        duration: r.duration,
        description: r.description,
        url: `https://www.bilibili.com/video/${r.bvid}`,
        cover: r.pic && r.pic.startsWith('//') ? 'https:' + r.pic : r.pic,
    }));

    return {
        keyword,
        total: data.numResults || results.length,
        results,
    };
}

// ==================== 主入口 ====================

const COMMANDS = {
    video_info: getVideoInfo,
    comments: getComments,
    danmaku: getDanmaku,
    subtitle: getSubtitle,
    search,
};

async function main() {
    let inputData = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        inputData += chunk;
    }

    try {
        const args = inputData.trim() ? JSON.parse(inputData) : {};
        const command = args.command;

        if (!command || !COMMANDS[command]) {
            throw new Error(`未知命令 "${command}"，支持的命令: ${Object.keys(COMMANDS).join(', ')}`);
        }

        const result = await COMMANDS[command](args);
        process.stdout.write(JSON.stringify({
            status: 'success',
            result,
        }));
    } catch (e) {
        process.stdout.write(JSON.stringify({
            status: 'error',
            error: e.message || String(e),
        }));
        process.exit(1);
    }
}

main();
