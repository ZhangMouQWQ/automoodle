// 修复 multichoiceset 里被拼接成单条字符串的多选答案
// 用法: node fix_multi.js <输入.json> [输出.json]
//
// 背景：Moodle 的 .rightanswer 把多个正确选项用逗号连成一段文本，
// 而 SQL 语句本身含逗号，不能简单按逗号切分。
// 正确做法：拿每个选项文本去这段文本里做「整串包含」匹配。

const fs = require('fs');

const unify = t => String(t == null ? '' : t)
    .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00a0/g, ' ');

const normSpace = s => unify(s).replace(/\s+/g, ' ').trim();

function splitByOptions(answerText, options) {
    const a = normSpace(answerText);
    const hits = [];
    // 长选项优先，避免短选项误配
    const sorted = [...options].map((o, i) => ({ o: normSpace(o), i }))
        .sort((x, y) => y.o.length - x.o.length);

    let remaining = a;
    for (const { o, i } of sorted) {
        if (!o) continue;
        const idx = remaining.indexOf(o);
        if (idx !== -1) {
            hits.push(i);
            // 用等长空格替换已匹配区间，避免占位符泄漏进答案，
            // 也保证后续短选项不会在同一区间重复匹配
            remaining = remaining.slice(0, idx) + ' '.repeat(o.length) + remaining.slice(idx + o.length);
        }
    }
    return hits.sort((x, y) => x - y).map(i => options[i]);
}

function main() {
    const inPath = process.argv[2];
    const outPath = process.argv[3] || inPath;
    if (!inPath) { console.error('用法: node fix_multi.js <输入.json> [输出.json]'); process.exit(1); }

    const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const stats = { scanned: 0, fixed: 0, unfixable: 0 };

    for (const k of Object.keys(data)) {
        const r = data[k];
        if (!r || r.type !== 'multichoiceset') continue;
        stats.scanned++;

        const options = r.options || [];
        if (options.length < 2) continue;
        if (!r.answers || r.answers.length !== 1) continue;

        const single = r.answers[0];
        // 判断是否真的是「多个选项被拼接」：答案里含 >=2 个选项文本
        const matched = splitByOptions(single, options);
        if (matched.length >= 2 && matched.length < options.length) {
            r.answers = matched;
            stats.fixed++;
            console.log('修复 ' + k.slice(0, 30) + ' → ' + matched.length + ' 个答案');
        } else if (matched.length === options.length && options.length > 2) {
            // 全部选项都匹配上了，说明这是「全选」类题目，保持原样更安全
            stats.unfixable++;
        }
    }

    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(JSON.stringify(stats, null, 2));
}

main();
