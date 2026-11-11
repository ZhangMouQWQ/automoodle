// 云端题库整理工具
// 用法: node reorganize.js <输入.json> [输出.json]
//
// 做四件事：
//   1. 修复题干/选项/答案里不成对的引号（Moodle 脏数据）
//   2. 补齐缺失的 type 字段
//   3. 按「完整题干」合并重复记录（不同引号写法视为同一题）
//   4. 用当前 normalize 规则重算键，保证精确匹配能命中

const fs = require('fs');

const unifyQuotes = t => String(t == null ? '' : t)
    .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, ' ');

const normalizeFull = t => unifyQuotes(t)
    .replace(/^\d+[\.\、]\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[，。？！.,?!;；]/g, '')
    .toLowerCase()
    .trim();

const normalize = (t, type) => {
    const r = normalizeFull(t);
    return r.substring(0, type === 'multianswer' ? 300 : 60);
};

// 只剥掉「不成对的」尾部引号，成对的闭合引号必须保留。
// 撇号不参与平衡：I'm / it's / don't 里的 ' 是英文缩写，不是引号。
function balanceQuotes(text) {
    let s = unifyQuotes(text).trim();
    const count = (str, ch) => (str.split(ch).length - 1);
    for (let i = 0; i < 6; i++) {
        let changed = false;
        if (s.endsWith('""')) { s = s.slice(0, -1); changed = true; }
        if (count(s, '"') % 2 === 1 && s.endsWith('"')) { s = s.slice(0, -1); changed = true; }
        // 单引号只在「整段被它包裹」时才当作引号处理
        if (s.length > 2 && s.startsWith("'") && s.endsWith("'") && count(s, "'") === 2) {
            s = s.slice(1, -1); changed = true;
        }
        s = s.trim();
        if (!changed) break;
    }
    return s;
}

// 句末标点：选项和答案必须用同一规则剥，否则答案永远匹配不上选项
function stripTailPunct(s) {
    return String(s || '').replace(/[。！？!?]+$/, '').replace(/\.$/, '').trim();
}

// 只用于比较：去掉整体包裹的引号
function stripQuotes(s) {
    return String(s || '').replace(/^["']+/, '').replace(/["']+$/, '').trim();
}

function cleanAnswer(text) {
    let s = unifyQuotes(text).replace(/^[a-dA-D][.．、)）\]］]\s*/i, '').replace(/^[：:]\s*/, '').trim();
    for (let i = 0; i < 3; i++) {
        const m = /^(["'『「«‹])([\s\S]*)(["'』」»›])$/.exec(s);
        if (!m) break;
        s = m[2].trim();
    }
    s = balanceQuotes(s);
    return stripTailPunct(s);
}

// 补齐 type：云端老数据大量缺这个字段
function inferType(rec) {
    const opts = rec.options || [];
    const ans = rec.answers || [];
    if (rec.subCount > 0) return 'multianswer';
    if (opts.length === 2 && opts.every(o => /^[对错]$/.test(o))) return 'truefalse';
    if (opts.length === 2 && ans.length === 1 && /^[对错]$/.test(ans[0])) return 'truefalse';
    if (ans.length > 1) return 'multichoiceset';
    return 'multichoice';
}

function main() {
    const inPath = process.argv[2];
    const outPath = process.argv[3] || 'bank_clean.json';
    if (!inPath) { console.error('用法: node reorganize.js <输入.json> [输出.json]'); process.exit(1); }

    const src = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const keys = Object.keys(src);
    const stats = {
        input: keys.length,
        quoteFixed: 0,
        typeFilled: 0,
        mergedGroups: 0,
        mergedAway: 0,
        keyRebuilt: 0,
        output: 0,
        byType: {},
        dropped: 0
    };

    const groups = new Map();

    for (const k of keys) {
        const rec = src[k];
        if (!rec || !rec.title) { stats.dropped++; continue; }

        const title = balanceQuotes(rec.title);
        // 选项和答案都保留原始句末标点（与 Moodle 页面一致），
        // 只在比较时才去尾标点，否则存进去的答案永远对不上选项。
        const options = (rec.options || []).map(o => balanceQuotes(o)).filter(Boolean);
        let answers = (rec.answers || []).map(cleanAnswer).filter(Boolean);

        answers = answers.map(a => {
            const hit = options.find(o => o === a) ||
                options.find(o => stripTailPunct(o) === stripTailPunct(a)) ||
                // 选项可能整体被引号包裹（如字符串题 "cd32"），答案不带引号也算命中
                options.find(o => stripQuotes(o) === stripQuotes(a));
            return hit ? hit : a;
        });
        answers = [...new Set(answers)];
        if (!answers.length) { stats.dropped++; continue; }

        const changedQuote =
            title !== rec.title ||
            JSON.stringify(answers) !== JSON.stringify(rec.answers) ||
            JSON.stringify(options) !== JSON.stringify(rec.options);
        if (changedQuote) stats.quoteFixed++;

        const type = rec.type || inferType({ ...rec, options, answers });
        if (!rec.type) stats.typeFilled++;

        // multianswer 的 answers 必须与 subCount 等长，否则答题时无法按空位对齐。
        // 缺失的空位补空字符串（表示「这一空没抓到」），而不是丢掉结构。
        let subCount = rec.subCount || 0;
        let incomplete = false;
        if (type === 'multianswer') {
            if (subCount > 0 && answers.length < subCount) {
                answers = answers.concat(new Array(subCount - answers.length).fill(''));
                incomplete = true;
                stats.subPadded = (stats.subPadded || 0) + 1;
            } else if (answers.length > subCount) {
                subCount = answers.length;
                stats.subCountFixed = (stats.subCountFixed || 0) + 1;
            }
            if (answers.some(a => !a)) incomplete = true;
        }

        const nf = normalizeFull(title);
        if (!groups.has(nf)) {
            groups.set(nf, {
                title, options, answers, type,
                time: rec.time || 0,
                count: rec.count || 1,
                subCount,
                qid: rec.qid,
                cmids: rec.cmids || [],
                incomplete
            });
        } else {
            const g = groups.get(nf);
            stats.mergedAway++;
            if (g.type === 'multianswer' || type === 'multianswer') {
                // 完形填空按空位对齐合并，不能去重排序，否则空位会错位
                const len = Math.max(g.answers.length, answers.length);
                const merged = [];
                for (let i = 0; i < len; i++) {
                    merged.push(g.answers[i] || answers[i] || '');
                }
                g.answers = merged;
                g.subCount = Math.max(g.subCount, subCount);
                g.incomplete = merged.some(a => !a);
            } else if (g.type === 'ddmatch' || type === 'ddmatch') {
                // 拖拽匹配按左侧项顺序对齐
                const len = Math.max(g.answers.length, answers.length);
                const merged = [];
                for (let i = 0; i < len; i++) merged.push(g.answers[i] || answers[i] || '');
                g.answers = merged;
                const unionOpt = [...new Set([...g.options, ...options])];
                g.options = unionOpt;
            } else {
                const unionAns = [...new Set([...g.answers, ...answers])];
                const unionOpt = [...new Set([...g.options, ...options])];
                g.answers = unionAns;
                g.options = unionOpt.length >= g.options.length ? unionOpt : g.options;
            }
            g.count = Math.max(g.count, rec.count || 1);
            g.time = Math.max(g.time, rec.time || 0);
            if (!g.qid && rec.qid) g.qid = rec.qid;
            if (rec.cmids) g.cmids = [...new Set([...g.cmids, ...rec.cmids])];
            if (!g.type && type) g.type = type;
        }
    }
    // 统计真正发生过合并的组数
    const seen = new Map();
    for (const k of keys) {
        const rec = src[k];
        if (!rec || !rec.title) continue;
        const nf = normalizeFull(balanceQuotes(rec.title));
        seen.set(nf, (seen.get(nf) || 0) + 1);
    }
    stats.mergedGroups = [...seen.values()].filter(v => v > 1).length;

    const out = {};
    for (const [nf, g] of groups) {
        const key = g.qid ? 'q_' + g.qid : normalize(g.title, g.type);
        let finalKey = key;
        // 极少数情况下不同题会算出同一个键（60 字截断），退化用完整题干哈希
        if (out[finalKey]) finalKey = 'f_' + hash(nf);
        if (finalKey !== normalize(g.title, g.type) && !g.qid) stats.keyRebuilt++;

        const rec = {
            title: g.title,
            options: g.options,
            answers: g.answers,
            time: g.time,
            count: g.count,
            type: g.type,
            subCount: g.subCount
        };
        if (g.qid) rec.qid = g.qid;
        if (g.cmids && g.cmids.length) rec.cmids = g.cmids;
        // 标记不完整的完形填空，避免答题时用空答案误填
        if (g.incomplete) rec.incomplete = true;
        out[finalKey] = rec;
        stats.byType[g.type] = (stats.byType[g.type] || 0) + 1;
        if (g.incomplete) stats.incomplete = (stats.incomplete || 0) + 1;
    }
    stats.output = Object.keys(out).length;

    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(stats, null, 2));
    console.log('已写入 ' + outPath);
}

function hash(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
        h2 = (h2 + c * (i + 1)) >>> 0;
    }
    return h1.toString(36) + h2.toString(36);
}

main();
