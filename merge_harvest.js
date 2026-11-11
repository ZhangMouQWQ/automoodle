// 把新抓取的题目合并进云端题库
// 用法: node merge_harvest.js <云端.json> <新抓取.json> [输出.json]
//
// 核心逻辑：
//   1. 新题带 qid → 键用 q_<qid>
//   2. 若云端已有「完整题干相同」的旧题（无 qid），迁移到 qid 键并保留原 count
//   3. 都不匹配 → 作为新题加入

const fs = require('fs');

const unify = t => String(t == null ? '' : t)
    .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, ' ');

const normalizeFull = t => unify(t)
    .replace(/^\d+[\.\、]\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[，。？！.,?!;；]/g, '')
    .toLowerCase()
    .trim();

const normalize = (t, type) => {
    const r = normalizeFull(t);
    return r.substring(0, type === 'multianswer' ? 300 : 60);
};

function main() {
    const curPath = process.argv[2];
    const newPath = process.argv[3];
    const outPath = process.argv[4] || 'bank_merged.json';
    if (!curPath || !newPath) {
        console.error('用法: node merge_harvest.js <云端.json> <新抓取.json> [输出.json]');
        process.exit(1);
    }

    const cur = JSON.parse(fs.readFileSync(curPath, 'utf8'));
    const nw = JSON.parse(fs.readFileSync(newPath, 'utf8'));

    // 建立「完整题干 → 键」索引，用于给旧题回填 qid
    const byFull = new Map();
    for (const k of Object.keys(cur)) {
        const rec = cur[k];
        if (!rec || !rec.title) continue;
        const f = normalizeFull(rec.title);
        if (!byFull.has(f)) byFull.set(f, []);
        byFull.get(f).push(k);
    }

    const stats = {
        cloudBefore: Object.keys(cur).length,
        harvest: Object.keys(nw).length,
        qidBackfilled: 0,
        mergedSameQid: 0,
        addedNew: 0,
        cloudAfter: 0,
        byCmid: {}
    };

    const out = { ...cur };

    for (const k of Object.keys(nw)) {
        const r = nw[k];
        if (!r || !r.title) continue;
        const qid = r.qid ? String(r.qid) : null;
        const f = normalizeFull(r.title);
        const targetKey = qid ? 'q_' + qid : normalize(r.title, r.type);

        // 找云端同题（完整题干相同）
        const candidates = (byFull.get(f) || []).filter(ck => ck !== targetKey);

        if (candidates.length) {
            // 取 count 最大的那条作为主记录
            let bestKey = candidates[0];
            for (const ck of candidates) {
                if ((cur[ck].count || 0) > (cur[bestKey].count || 0)) bestKey = ck;
            }
            const old = cur[bestKey];
            const merged = {
                title: r.title,
                options: r.options && r.options.length ? r.options : (old.options || []),
                answers: r.answers && r.answers.length ? r.answers : (old.answers || []),
                time: Math.max(old.time || 0, Date.now()),
                count: Math.max(old.count || 1, r.count || 1),
                type: r.type || old.type || 'unknown',
                subCount: r.subCount || old.subCount || 0
            };
            if (qid) merged.qid = qid;
            if (old.qid && !merged.qid) merged.qid = old.qid;
            const cmids = new Set([...(old.cmids || []), ...(r.cmids || [])]);
            if (cmids.size) merged.cmids = [...cmids];
            if (r.incomplete || old.incomplete) merged.incomplete = true;

            // 删除所有同题旧键，统一写到 targetKey
            for (const ck of candidates) delete out[ck];
            out[targetKey] = merged;
            if (qid) stats.qidBackfilled++;
        } else if (out[targetKey]) {
            // qid 已存在：合并
            const old = out[targetKey];
            const cmids = new Set([...(old.cmids || []), ...(r.cmids || [])]);
            out[targetKey] = {
                ...old,
                title: r.title || old.title,
                options: (r.options && r.options.length) ? r.options : old.options,
                answers: (r.answers && r.answers.length) ? r.answers : old.answers,
                count: Math.max(old.count || 1, r.count || 1),
                time: Math.max(old.time || 0, Date.now()),
                cmids: [...cmids]
            };
            stats.mergedSameQid++;
        } else {
            out[targetKey] = {
                title: r.title,
                options: r.options || [],
                answers: r.answers || [],
                time: Date.now(),
                count: r.count || 1,
                type: r.type || 'unknown',
                subCount: r.subCount || 0,
                ...(qid ? { qid } : {}),
                ...(r.cmids ? { cmids: r.cmids } : {}),
                ...(r.incomplete ? { incomplete: true } : {})
            };
            stats.addedNew++;
        }

        for (const c of (r.cmids || [])) stats.byCmid[c] = (stats.byCmid[c] || 0) + 1;
    }

    stats.cloudAfter = Object.keys(out).length;
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(stats, null, 2));
    console.log('已写入 ' + outPath);
}

main();
