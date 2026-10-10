// ==UserScript==
// @name         Moodle 题库助手 - 云端版
// @namespace    http://tampermonkey.net/
// @version      4.3.7
// @description  修复云端同步冲突解决机制（time-based）、cleanAnswer全角分隔符、subCount存储错误、单选题字母答案兼容
// @author       You
// @updateURL    https://raw.githubusercontent.com/ZhangMouQWQ/automoodle/main/Moodle%20%E9%A2%98%E5%BA%93%E5%8A%A9%E6%89%8B%20-%20%E4%BA%91%E7%AB%AF%E7%89%88-4.3.5.user.js
// @downloadURL  https://raw.githubusercontent.com/ZhangMouQWQ/automoodle/main/Moodle%20%E9%A2%98%E5%BA%93%E5%8A%A9%E6%89%8B%20-%20%E4%BA%91%E7%AB%AF%E7%89%88-4.3.5.user.js
// @match        https://moodle.syxy.ouchn.cn/*
// @match        https://*.ouchn.cn/*
// @match        https://*.moodle.*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      tiku.homo.cc.cd
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    /* ==================== 云端配置（必填） ==================== */
    const CLOUD_CONFIG = {
        enabled: true,
        endpoint: 'https://tiku.homo.cc.cd',
        token: 'admin',
        autoSync: true,
        autoDownload: true,
    };

    function cloudRequest(method, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: `${CLOUD_CONFIG.endpoint}/api/bank?token=${encodeURIComponent(CLOUD_CONFIG.token)}`,
                headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
                data: data === undefined ? undefined : JSON.stringify(data),
                timeout: 20000,
                onload(response) {
                    let result;
                    try {
                        result = JSON.parse(response.responseText);
                    } catch (error) {
                        reject(new Error(`云端返回非 JSON (HTTP ${response.status})`));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(result.error || `云端请求失败 (HTTP ${response.status})`));
                        return;
                    }
                    resolve(result);
                },
                onerror(details) {
                    console.error('[Cloud] GM_xmlhttpRequest failed:', details);
                    const reason = details?.error || details?.statusText || details?.responseText;
                    reject(new Error(reason ? `云端网络请求失败: ${reason}` : '云端网络请求失败；请查看控制台错误详情'));
                },
                ontimeout() { reject(new Error('云端请求超时')); },
            });
        });
    }

    const CONFIG = {
        questionContainer: '.que',
        titleSelector: '.qtext',
        optionsSelector: '.answer',
        optionItemSelector: 'div[class^="r"]',
        matchThreshold: 0.82,
        multianswerMatchThreshold: 0.98,
        debug: true
    };

    /* ==================== 全局状态锁 ==================== */
    let isCapturing = false;
    let isSyncing = false;
    let hadFeedbackOnLoad = false;
    let lastUrl = location.href;

    /* ==================== 云端 API ==================== */
    const CloudAPI = {
        async sync() {
            if (!CLOUD_CONFIG.enabled || isSyncing) return;
            isSyncing = true;
            try {
                const cloudData = await cloudRequest('GET');

                let updated = 0;
                for (const key in cloudData) {
                    const rec = cloudData[key];
                    if (!rec || !rec.title) continue;
                    const local = bank.data[key];
                    if (!local) {
                        bank.data[key] = rec;
                        updated++;
                    } else if ((rec.time || 0) > (local.time || 0)) {
                        bank.data[key] = rec;
                        updated++;
                    } else if ((rec.time || 0) === (local.time || 0) && (rec.count || 0) > (local.count || 0)) {
                        bank.data[key] = rec;
                        updated++;
                    }
                }
                bank.save();

                const result = await cloudRequest('POST', bank.data);

                FloatWindow.showToast(`☁️ 同步完成：更新 ${updated} 题，云端共 ${result.count} 题`, 'success');
                FloatWindow.updateStatus();
            } catch (e) {
                console.error('[Cloud]', e);
                FloatWindow.showToast('⚠️ 云端同步失败: ' + e.message, 'warning');
            } finally {
                setTimeout(() => { isSyncing = false; }, 3000);
            }
        },

        async download() {
            if (!CLOUD_CONFIG.enabled) return;
            try {
                const cloudData = await cloudRequest('GET');
                let updated = 0;
                for (const key in cloudData) {
                    const rec = cloudData[key];
                    if (!rec || !rec.title) continue;
                    const local = bank.data[key];
                    if (!local) {
                        bank.data[key] = rec;
                        updated++;
                    } else if ((rec.time || 0) > (local.time || 0)) {
                        bank.data[key] = rec;
                        updated++;
                    } else if ((rec.time || 0) === (local.time || 0) && (rec.count || 0) > (local.count || 0)) {
                        bank.data[key] = rec;
                        updated++;
                    }
                }
                bank.save();
                FloatWindow.updateStatus();
                if (updated > 0) FloatWindow.showToast(`☁️ 下载完成：更新 ${updated} 题`, 'success');
            } catch (e) {
                console.error('[Cloud]', e);
            }
        },

        async upload() {
            if (!CLOUD_CONFIG.enabled || isSyncing) return;
            isSyncing = true;
            try {
                const result = await cloudRequest('POST', bank.data);
                FloatWindow.showToast(`☁️ 上传完成：云端共 ${result.count} 题`, 'success');
            } catch (e) {
                console.error('[Cloud]', e);
                FloatWindow.showToast('⚠️ 云端上传失败', 'warning');
            } finally {
                setTimeout(() => { isSyncing = false; }, 3000);
            }
        }
    };

    /* ==================== 题库引擎 ==================== */
    class QuestionBank {
        constructor() {
            this.storageKey = 'moodle_bank_cloud_v4';
            this.data = this.load();
        }
        load() {
            try { return JSON.parse(GM_getValue(this.storageKey, '{}')); }
            catch (e) { return {}; }
        }
        save() { GM_setValue(this.storageKey, JSON.stringify(this.data)); }
        normalize(text, type) {
            let r = TextCleaner.unifyQuotes(text)
                .replace(/^\d+[\.\、]\s*/, '')
                .replace(/\s+/g, '')
                .replace(/[，。？！.,?!;；]/g, '')
                .toLowerCase()
                .trim();
            if (type === 'multianswer') return r.substring(0, 300);
            return r.substring(0, 60);
        }
        similarity(s1, s2, type) {
            s1 = this.normalize(s1, type); s2 = this.normalize(s2, type);
            if (s1 === s2) return 1.0;
            const longer = s1.length > s2.length ? s1 : s2;
            const shorter = s1.length > s2.length ? s2 : s1;
            if (longer.length === 0) return 1.0;
            if (longer.includes(shorter)) return 0.95;
            let same = 0;
            for (let i = 0; i < shorter.length; i++) if (longer[i] === shorter[i]) same++;
            return same / longer.length;
        }

        add(title, options, answers, type, subCount) {
            const key = this.normalize(title, type);
            const existing = this.data[key];
            const cleanAnswers = answers.map(a => a.trim());
            const cleanOptions = options.map(o => o.trim());

            if (existing) {
                let changed;
                let oldAnswersDisplay, newAnswersDisplay;
                if (type === 'ddmatch' || type === 'multianswer') {
                    changed = JSON.stringify(existing.answers) !== JSON.stringify(cleanAnswers) ||
                            JSON.stringify(existing.options) !== JSON.stringify(cleanOptions);
                    oldAnswersDisplay = existing.answers;
                    newAnswersDisplay = cleanAnswers;
                } else {
                    const oldSorted = [...existing.answers].sort();
                    const newSorted = [...cleanAnswers].sort();
                    changed = JSON.stringify(oldSorted) !== JSON.stringify(newSorted);
                    oldAnswersDisplay = oldSorted;
                    newAnswersDisplay = newSorted;
                }

                if (changed) {
                    existing.answers = cleanAnswers;
                    existing.options = cleanOptions;
                    existing.time = Date.now();
                    existing.count++;
                    this.save();
                    this.log('🔄 答案更新', `"${title.substring(0,30)}..."`, '旧:', oldAnswersDisplay.join('、'), '→ 新:', newAnswersDisplay.join('、'));
                    FloatWindow.updateStatus();
                    return { action: 'updated', oldAnswers: oldAnswersDisplay, newAnswers: newAnswersDisplay };
                } else {
                    existing.count++;
                    existing.time = Date.now();
                    this.save();
                    this.log('✅ 录入(重复)', `"${title.substring(0,30)}..."`, '→', cleanAnswers.join('、'));
                    FloatWindow.updateStatus();
                    return { action: 'duplicate' };
                }
            }

            this.data[key] = {
                title: title.trim(),
                options: cleanOptions,
                answers: cleanAnswers,
                time: Date.now(),
                count: 1,
                type: type || 'unknown',
                subCount: type === 'multianswer' ? (subCount || answers.length) : 0
            };
            this.save();
            this.log('✅ 新录入', `"${title.substring(0,30)}..."`, '→', cleanAnswers.join('、'));
            FloatWindow.updateStatus();
            return { action: 'new' };
        }

        find(title, type, subCount) {
            const key = this.normalize(title, type);
            if (this.data[key]) {
                const record = this.data[key];
                if (type === 'multianswer' && subCount && record.subCount && record.subCount !== subCount) {
                    this.log('⚠️ 精确匹配但子问题数量不符');
                } else {
                    return record;
                }
            }

            const threshold = type === 'multianswer' ? CONFIG.multianswerMatchThreshold : CONFIG.matchThreshold;
            let bestMatch = null, bestSim = 0;

            for (const k in this.data) {
                const record = this.data[k];
                if (type === 'multianswer') {
                    if (record.type !== 'multianswer') continue;
                    if (subCount && record.subCount && record.subCount !== subCount) continue;
                }
                if (type === 'ddmatch' && record.type !== 'ddmatch') continue;
                const sim = this.similarity(record.title, title, type);
                if (sim >= threshold && sim > bestSim) {
                    bestSim = sim;
                    bestMatch = record;
                }
            }

            if (bestMatch) {
                this.log('🔍 模糊匹配', bestSim.toFixed(3), `"${title.substring(0,30)}..."`);
                return bestMatch;
            }
            return null;
        }

        getAll() { return Object.values(this.data).sort((a, b) => b.time - a.time); }
        clear() { this.data = {}; this.save(); FloatWindow.updateStatus(); }
        export() { return JSON.stringify(this.data, null, 2); }

        import(jsonStr, mode = 'merge') {
            let imported;
            try { imported = JSON.parse(jsonStr); }
            catch (e) { return { success: false, error: 'JSON 解析失败：' + e.message, count: 0 }; }
            if (typeof imported !== 'object' || imported === null) {
                return { success: false, error: '数据格式错误', count: 0 };
            }

            let count = 0;
            if (mode === 'overwrite') {
                this.data = imported;
                count = Object.keys(imported).length;
            } else {
                for (const key in imported) {
                    const newRecord = imported[key];
                    if (!newRecord || !newRecord.title) continue;
                    const existing = this.data[key];
                    if (!existing) {
                        this.data[key] = newRecord;
                        count++;
                    } else {
                        if ((newRecord.time || 0) > (existing.time || 0)) {
                            this.data[key] = newRecord;
                        } else if ((newRecord.time || 0) === (existing.time || 0) && (newRecord.count || 0) > (existing.count || 0)) {
                            this.data[key] = newRecord;
                        }
                        count++;
                    }
                }
            }
            this.save();
            FloatWindow.updateStatus();
            return { success: true, count: count, total: Object.keys(this.data).length };
        }

        getStats() {
            const all = this.getAll();
            return { total: all.length, repeated: all.filter(q => q.count > 1).length };
        }
        log(...args) { if (CONFIG.debug) console.log('[Moodle题库]', ...args); }
    }

    const bank = new QuestionBank();

    /* ==================== 文本清洗工具 ==================== */
    const TextCleaner = {
        unifyQuotes(text) {
            return text
                .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
                .replace(/[\u201C\u201D]/g, '"')
                .replace(/[\u2013\u2014]/g, '-');
        },
        cleanAnswer(text) {
            return this.unifyQuotes(text)
                .replace(/^([a-dA-D])[.．、)）\\]］]\\s*/i, '')
                .replace(/^[""''""''『「«‹]+/, '')
                .replace(/^[：:]\s*/, '')
                .replace(/[""''""''』」»›。！？.!?]+$/, '')
                .trim();
        },
        extractAnswerPart(text) {
            return this.unifyQuotes(text)
                .replace(/^.*?正确答案是[是为]?\s*[：:]?\s*/i, '')
                .replace(/^.*?The correct answer is\s*[：:]?\s*/i, '')
                .replace(/^.*?Correct answer\s*[：:]?\s*/i, '')
                .trim();
        },
        extractFromFeedbackSpan(element) {
            const feedbackSpan = element.querySelector('.feedbackspan');
            if (!feedbackSpan) return null;
            let html = feedbackSpan.innerHTML;
            html = html.replace(/<br\s*\/?>/gi, '\n');
            const temp = document.createElement('div');
            temp.innerHTML = html;
            let text = this.unifyQuotes((temp.innerText || temp.textContent).trim());
            const match = text.match(/正确答案[：:]\s*([^\n]+)/i);
            if (match) {
                let ans = match[1].trim();
                ans = ans.replace(/得分.*$/, '').trim();
                ans = ans.replace(/分$/, '').trim();
                return ans;
            }
            return null;
        }
    };

    /* ==================== 解析器 ==================== */
    const Parser = {
        getQuestions() {
            return document.querySelectorAll(CONFIG.questionContainer);
        },

        getTitle(el) {
            const classes = el.className || '';
            if (classes.includes('multianswer')) {
                let text = '';
                const qtext = el.querySelector('.qtext');
                if (qtext) {
                    text = (qtext.innerText || qtext.textContent).trim();
                } else {
                    const formulation = el.querySelector('.formulation');
                    if (formulation) {
                        const clone = formulation.cloneNode(true);
                        clone.querySelectorAll('.subquestion, .accesshide, input[type="hidden"], .yui3-widget').forEach(e => e.remove());
                        text = (clone.innerText || clone.textContent).trim();
                    }
                }
                if (text) {
                    if (text.length > 100) text = text.substring(0, 100) + '...';
                    return text.replace(/^\s*\d+[\.\、]\s*/, '').trim();
                }
                return 'multianswer 题目';
            }

            const titleEl = el.querySelector(CONFIG.titleSelector);
            if (!titleEl) return null;
            return (titleEl.innerText || titleEl.textContent)
                .replace(/^\s*\d+[\.\、]\s*/, '').trim();
        },

        getQuestionType(el) {
            const classes = el.className || '';
            if (classes.includes('multianswer')) return 'multianswer';
            if (classes.includes('truefalse')) return 'truefalse';
            if (classes.includes('multichoiceset')) return 'multichoiceset';
            if (classes.includes('multichoice')) return 'multichoice';
            if (classes.includes('ddmatch')) return 'ddmatch';
            return 'unknown';
        },

        getSubCount(el) {
            if (!el.classList.contains('multianswer')) return 0;
            return el.querySelectorAll('.subquestion').length;
        },

        getOptions(el) {
            const classes = el.className || '';
            if (classes.includes('multianswer')) {
                return [{ text: '_multianswer_', fullText: '_multianswer_', element: null, input: null, index: 0 }];
            }

            if (classes.includes('ddmatch')) {
                const rows = el.querySelectorAll('table.answer tbody tr');
                return Array.from(rows).map((row, idx) => {
                    const textEl = row.querySelector('.text');
                    const text = textEl ? (textEl.innerText || textEl.textContent).trim() : '';
                    const select = row.querySelector('select');
                    return {
                        text: TextCleaner.unifyQuotes(text),
                        fullText: TextCleaner.unifyQuotes(text),
                        element: row,
                        input: select,
                        index: idx
                    };
                }).filter(o => o.text);
            }

            const container = el.querySelector(CONFIG.optionsSelector);
            if (!container) return [];
            const items = container.querySelectorAll(CONFIG.optionItemSelector);
            return Array.from(items).map((item, idx) => {
                const input = item.querySelector('input[type="radio"], input[type="checkbox"]');
                if (!input) return null;
                if (input.value === "-1" || input.classList.contains('sr-only') || item.classList.contains('sr-only')) return null;

                let text = '';
                const flexFill = item.querySelector('.flex-fill.ml-1, .flex-fill');
                if (flexFill) text = flexFill.innerText || flexFill.textContent;
                else {
                    const dFlex = item.querySelector('.d-flex.w-100, [data-region="answer-label"]');
                    if (dFlex) text = dFlex.innerText || dFlex.textContent;
                }
                if (!text) {
                    const label = item.querySelector('label');
                    if (label) text = label.innerText || label.textContent;
                }
                if (!text) {
                    const clone = item.cloneNode(true);
                    clone.querySelectorAll('input').forEach(i => i.remove());
                    text = clone.innerText || clone.textContent;
                }

                text = text.trim();
                const cleanText = text.replace(/^([a-dA-D])[.\．、)\）\]\］]\s*/i, '').trim();
                return {
                    text: TextCleaner.unifyQuotes(cleanText),
                    fullText: TextCleaner.unifyQuotes(text),
                    element: item,
                    input: input,
                    index: idx
                };
            }).filter(o => o && o.text && !o.text.includes('清空我的选择'));
        },

        detectAnswers(el, options) {
            const classes = el.className || '';

            if (classes.includes('multianswer')) {
                const answers = [];
                const subs = el.querySelectorAll('.subquestion');
                subs.forEach((sub, idx) => {
                    let ans = null;
                    ans = TextCleaner.extractFromFeedbackSpan(sub);
                    if (!ans) {
                        const textInput = sub.querySelector('input[type="text"]');
                        if (textInput) {
                            const isCorrect = textInput.classList.contains('correct') || sub.querySelector('.fa-check, .text-success');
                            if (isCorrect) ans = TextCleaner.unifyQuotes(textInput.value.trim());
                        }
                    }
                    if (!ans) {
                        const select = sub.querySelector('select');
                        if (select) {
                            const selected = select.querySelector('option[selected]');
                            if (selected && selected.value !== '') {
                                ans = TextCleaner.unifyQuotes((selected.innerText || selected.textContent).trim());
                            }
                        }
                    }
                    answers.push(ans || '');
                });
                return answers;
            }

            if (classes.includes('ddmatch')) {
                const answersMap = {};
                const rightAnswerEl = el.querySelector('.rightanswer');
                if (rightAnswerEl) {
                    const table = rightAnswerEl.querySelector('table.correctanswertable, table.generaltable');
                    if (table) {
                        const rows = table.querySelectorAll('tbody tr');
                        rows.forEach(row => {
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 2) {
                                const leftText = TextCleaner.unifyQuotes((cells[0].innerText || cells[0].textContent).trim());
                                const rightText = TextCleaner.unifyQuotes((cells[1].innerText || cells[1].textContent).trim());
                                answersMap[leftText] = rightText;
                            }
                        });
                    }
                }
                return options.map(opt => answersMap[opt.text] || '');
            }

                        const answers = [];
            const rightAnswerEl = el.querySelector('.rightanswer');
            if (rightAnswerEl) {
                let ansTexts = [];

                // 策略1：按 <p> 提取
                const childPs = rightAnswerEl.querySelectorAll('p');
                if (childPs.length > 1) {
                    childPs.forEach(p => {
                        let text = TextCleaner.unifyQuotes((p.innerText || p.textContent).trim());
                        text = text.replace(/^[,，、;；\s]+/, '').replace(/[,，、;；\s]+$/, '').trim();
                        if (text) ansTexts.push(text);
                    });
                    bank.log('🔍 按 <p> 提取到', ansTexts.length, '个答案片段');
                }

                // 策略2：回退到 innerText
                if (ansTexts.length === 0) {
                    let rightText = TextCleaner.unifyQuotes((rightAnswerEl.innerText || rightAnswerEl.textContent).trim());
                    let ansPart = TextCleaner.extractAnswerPart(rightText);
                    bank.log('🔍 rightanswer 原始文本:', rightText.substring(0, 80));
                    bank.log('🔍 提取后 ansPart:', ansPart.substring(0, 80));
                    ansTexts.push(ansPart);
                }

                // 对每个片段尝试匹配，失败则用 smartSplit 贪心合并分割
                for (const ansText of ansTexts) {
                    const cleanAns = TextCleaner.cleanAnswer(ansText);
                    const found = this.findOption(options, cleanAns, ansText);
                    if (found) {
                        bank.log('✅ 匹配成功:', ansText.substring(0, 40), '→', found.text);
                        if (!answers.includes(found.text)) answers.push(found.text);
                    } else {
                        bank.log('⚠️ 片段未匹配，尝试 smartSplit:', ansText.substring(0, 40));
                        const splitResults = this.smartSplit(ansText, options);
                        for (const splitAns of splitResults) {
                            const cleanSplitAns = TextCleaner.cleanAnswer(splitAns);
                            const splitFound = this.findOption(options, cleanSplitAns, splitAns);
                            if (splitFound) {
                                bank.log('✅ smartSplit 匹配:', splitAns.substring(0, 40), '→', splitFound.text);
                                if (!answers.includes(splitFound.text)) answers.push(splitFound.text);
                            } else {
                                bank.log('❌ smartSplit 未匹配:', splitAns);
                            }
                        }
                    }
                }
            }
            if (answers.length > 0) return answers;

            const feedbackSpan = el.querySelector('.feedbackspan');
            if (feedbackSpan) {
                const text = TextCleaner.unifyQuotes((feedbackSpan.innerText || feedbackSpan.textContent).trim());
                const match = text.match(/正确答案[：:]\s*(.+)/i);
                if (match) {
                    const ansPart = match[1].trim();
                    const ansList = ansPart.split(/[,，、;；]\s*/).map(s => s.trim()).filter(s => s);
                    for (const ans of ansList) {
                        const cleanAns = TextCleaner.cleanAnswer(ans);
                        const found = this.findOption(options, cleanAns, ans);
                        if (found && !answers.includes(found.text)) answers.push(found.text);
                    }
                }
            }
            if (answers.length > 0) return answers;

            const allItems = el.querySelectorAll('div[class^="r"]');
            allItems.forEach(item => {
                if (item.classList.contains('correct') || item.querySelector('.correct')) {
                    const input = item.querySelector('input[type="radio"], input[type="checkbox"]');
                    if (!input || input.value === "-1") return;
                    const opt = options.find(o => o.element === item);
                    if (opt && !answers.includes(opt.text)) answers.push(opt.text);
                }
            });
            if (answers.length > 0) return answers;

            options.forEach(opt => {
                if (opt.input && opt.input.checked) {
                    const parent = opt.element.closest('div[class^="r"]');
                    if (parent && parent.classList.contains('correct')) {
                        if (!answers.includes(opt.text)) answers.push(opt.text);
                    }
                }
            });
            if (answers.length > 0) return answers;

            const elText = el.innerText || el.textContent;
            if (elText.includes('正确答案')) {
                const lines = elText.split('\n');
                for (const line of lines) {
                    if (line.includes('正确答案')) {
                        const match = line.match(/正确答案[是为：:]?\s*(.+)/);
                        if (match) {
                            const ansPart = match[1].trim();
                            const ansList = ansPart.split(/[,，、;；]\s*/).map(s => s.trim()).filter(s => s);
                            for (const ans of ansList) {
                                const cleanAns = TextCleaner.cleanAnswer(ans);
                                const found = this.findOption(options, cleanAns, ans);
                                if (found && !answers.includes(found.text)) answers.push(found.text);
                            }
                        }
                    }
                }
            }
            return answers;
        },

        findOption(options, cleanAns, rawAns) {
            if (CONFIG.debug) {
                bank.log('🔍 findOption 查找:', 'cleanAns=', cleanAns, 'rawAns=', rawAns);
            }
            const result = options.find(o => {
                const oText = o.text.trim();
                const oFull = o.fullText.trim();

                if (oText === cleanAns || oFull === cleanAns) {
                    if (CONFIG.debug) bank.log('  ✅ 精确匹配:', oText);
                    return true;
                }
                if (oText === rawAns || oFull === rawAns) {
                    if (CONFIG.debug) bank.log('  ✅ 原始精确匹配:', oText);
                    return true;
                }

                const textLenDiff = Math.abs(oText.length - cleanAns.length);
                if (textLenDiff <= 1 && (oText.includes(cleanAns) || cleanAns.includes(oText))) {
                    if (CONFIG.debug) bank.log('  ✅ 包含匹配(长度差≤1):', oText, '~', cleanAns);
                    return true;
                }
                const fullLenDiff = Math.abs(oFull.length - rawAns.length);
                if (fullLenDiff <= 1 && (oFull.includes(rawAns) || rawAns.includes(oFull))) {
                    if (CONFIG.debug) bank.log('  ✅ fullText包含(长度差≤1):', oFull, '~', rawAns);
                    return true;
                }

                if (oText.replace(/\s+/g, '').replace(/[，。；]/g, '') === cleanAns.replace(/\s+/g, '').replace(/[，。；]/g, '')) {
                    if (CONFIG.debug) bank.log('  ✅ 去空格标点匹配:', oText);
                    return true;
                }

                const sim = bank.similarity(oText, cleanAns, null);
                if (sim > 0.9 && textLenDiff <= 1) {
                    if (CONFIG.debug) bank.log('  ✅ 相似度匹配(长度差≤1):', oText, 'sim=', sim.toFixed(3));
                    return true;
                }
                return false;
            });
            if (CONFIG.debug && !result) bank.log('  ❌ 未找到匹配');
            return result;
        },
                smartSplit(text, options) {
            const separators = /[,，、;；]\s*/;
            const parts = text.split(separators).map(s => s.trim()).filter(s => s);
            const result = [];
            let i = 0;
            while (i < parts.length) {
                let found = false;
                // 从长到短贪心合并，优先匹配更长的完整答案
                for (let len = Math.min(parts.length - i, 6); len >= 1; len--) {
                    const candidate = parts.slice(i, i + len).join('，');
                    const cleanCandidate = TextCleaner.cleanAnswer(candidate);
                    if (this.findOption(options, cleanCandidate, candidate)) {
                        result.push(candidate);
                        i += len;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    result.push(parts[i]);
                    i++;
                }
            }
            return result;
        }
    };

    /* ==================== 核心逻辑 ==================== */
    const Core = {
        async capture() {
            if (isCapturing) return;
            isCapturing = true;
            try {
                const questions = Parser.getQuestions();
                let newCount = 0, dupCount = 0, updateCount = 0;
                const skipped = [];

                questions.forEach((qEl, idx) => {
                    const title = Parser.getTitle(qEl);
                    const qno = qEl.querySelector('.qno')?.textContent?.trim() || (idx + 1);
                    const qType = Parser.getQuestionType(qEl);
                    const subCount = Parser.getSubCount(qEl);

                    if (!title) { skipped.push({ no: qno, reason: '无标题' }); return; }

                    const options = Parser.getOptions(qEl);
                    if (options.length === 0 && qType !== 'multianswer') {
                        skipped.push({ no: qno, reason: '无选项', title: title.substring(0, 20) });
                        return;
                    }

                    const answers = Parser.detectAnswers(qEl, options);

                    if (answers.length === 0 || answers.every(a => !a)) {
                        skipped.push({ no: qno, reason: '未检测到答案', title: title.substring(0, 20) });
                        bank.log('⏭️ 无答案', `第${qno}题 "${title.substring(0,40)}..."`);
                        return;
                    }

                    bank.log(`📥 第${qno}题抓取结果:`, '类型:', qType, '答案:', answers, '选项:', options.map(o => o.text));

                    const result = bank.add(title, options.map(o => o.text), answers, qType, subCount);
                    if (result.action === 'new') newCount++;
                    else if (result.action === 'duplicate') dupCount++;
                    else if (result.action === 'updated') updateCount++;
                });

                const stats = bank.getStats();
                let msg = `📚 新录入 ${newCount} 题`;
                if (dupCount > 0) msg += ` | 📌 重复 ${dupCount} 题`;
                if (updateCount > 0) msg += ` | 🔄 更新 ${updateCount} 题答案`;
                msg += ` | 共 ${stats.total} 题`;

                if (skipped.length > 0) {
                    msg += ` | ⚠️ 跳过 ${skipped.length} 题`;
                    console.log('[Moodle题库] 跳过的题目:', skipped);
                    const autoEl = document.getElementById('mfp-auto');
                    if (autoEl) {
                        autoEl.innerHTML = `<span style="color:#f59e0b;cursor:pointer" title="查看控制台了解详情">⚠️ 跳过 ${skipped.length} 题 (F12)</span>`;
                    }
                }

                const toastType = updateCount > 0 ? 'warning' : (newCount > 0 ? 'success' : 'info');
                FloatWindow.showToast(msg, toastType);
                FloatWindow.updateStatus();

                if (CLOUD_CONFIG.enabled && CLOUD_CONFIG.autoSync) {
                    setTimeout(() => CloudAPI.sync(), 500);
                }
            } finally {
                setTimeout(() => { isCapturing = false; }, 2000);
            }
        },

        async answer() {
            if (CLOUD_CONFIG.enabled && CLOUD_CONFIG.autoDownload) {
                await CloudAPI.download();
            }

            const questions = Parser.getQuestions();
            let answered = 0, missed = 0;

            questions.forEach(qEl => {
                const title = Parser.getTitle(qEl);
                if (!title) return;
                const qType = Parser.getQuestionType(qEl);
                const subCount = Parser.getSubCount(qEl);

                const record = bank.find(title, qType, subCount);
                if (!record) {
                    missed++;
                    bank.log('❌ 未命中', `"${title.substring(0,40)}..."`, `类型:${qType} 子问题:${subCount}`);
                    return;
                }

                if (qType === 'multianswer') {
                    const subs = qEl.querySelectorAll('.subquestion');
                    let filled = 0;
                    subs.forEach((sub, idx) => {
                        if (idx >= record.answers.length) return;
                        const ans = record.answers[idx];
                        if (!ans) return;

                        const select = sub.querySelector('select');
                        if (select) {
                            const options = Array.from(select.querySelectorAll('option')).filter(o => o.value !== '');
                            let target = options.find(o => {
                                const text = TextCleaner.unifyQuotes((o.innerText || o.textContent).trim());
                                return text.toUpperCase() === ans.toUpperCase();
                            });
                            if (!target) {
                                target = options.find(o => {
                                    const text = TextCleaner.unifyQuotes((o.innerText || o.textContent).trim());
                                    return text.replace(/\s+/g, '').toUpperCase() === ans.replace(/\s+/g, '').toUpperCase();
                                });
                            }
                            if (target) {
                                select.value = target.value;
                                select.dispatchEvent(new Event('change', { bubbles: true }));
                                sub.style.cssText = `background: #d1fae5 !important; border: 2px solid #10b981 !important; border-radius: 4px !important; padding: 2px 6px; transition: all 0.3s; display: inline-block;`;
                                filled++;
                            }
                            return;
                        }

                        const textInput = sub.querySelector('input[type="text"]');
                        if (textInput) {
                            textInput.value = ans;
                            textInput.dispatchEvent(new Event('input', { bubbles: true }));
                            textInput.dispatchEvent(new Event('change', { bubbles: true }));
                            sub.style.cssText = `background: #d1fae5 !important; border: 2px solid #10b981 !important; border-radius: 4px !important; padding: 2px 6px; transition: all 0.3s; display: inline-block;`;
                            filled++;
                            return;
                        }
                    });

                    if (filled > 0) answered++;
                    return;
                }

                if (qType === 'ddmatch') {
                    const options = Parser.getOptions(qEl);
                    const answerMap = {};
                    record.options.forEach((optText, idx) => {
                        answerMap[optText] = record.answers[idx];
                    });

                    let filled = 0;
                    options.forEach(opt => {
                        const ansText = answerMap[opt.text];
                        if (!ansText) return;

                        const select = opt.input;
                        if (!select) return;

                        const selectOptions = Array.from(select.querySelectorAll('option')).filter(o => o.value !== '0' && o.value !== '');
                        let target = selectOptions.find(o => {
                            const text = TextCleaner.unifyQuotes((o.innerText || o.textContent).trim());
                            return text.toUpperCase() === ansText.toUpperCase();
                        });
                        if (!target) {
                            target = selectOptions.find(o => {
                                const text = TextCleaner.unifyQuotes((o.innerText || o.textContent).trim());
                                return text.replace(/\s+/g, '').toUpperCase() === ansText.replace(/\s+/g, '').toUpperCase();
                            });
                        }
                        if (target) {
                            select.value = target.value;
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                            opt.element.style.cssText = `background: #d1fae5 !important; border: 2px solid #10b981 !important; border-radius: 4px !important; padding: 2px 6px; transition: all 0.3s;`;
                            filled++;
                            bank.log('✅ 自动选择', opt.text, '→', ansText);
                        } else {
                            bank.log('⚠️ 未匹配', ansText, '可选:', selectOptions.map(o => (o.innerText || o.textContent).trim()).join(' | '));
                        }
                    });

                    if (filled > 0) answered++;
                    return;
                }

                const options = Parser.getOptions(qEl);
                if (options.length === 0) return;

                let selected = 0;
                record.answers.forEach(ans => {
                    let target = Parser.findOption(options, ans, ans);
                    // 兼容旧版题库中存储的选项字母（如 A/B/C/D）
                    if (!target && /^[a-dA-D]$/.test(ans.trim())) {
                        const letter = ans.trim().toUpperCase();
                        target = options.find(o => {
                            const m = o.fullText.match(/^([a-dA-D])[.．、)）\\]］]\\s*/i);
                            return m && m[1].toUpperCase() === letter;
                        });
                    }
                    if (!target) {
                        target = options.find(o => bank.similarity(o.text, ans, null) > 0.9);
                    }
                    if (target) {
                        if (target.input.type === 'checkbox') {
                            if (!target.input.checked) { target.input.click(); target.input.checked = true; }
                        } else {
                            target.input.click(); target.input.checked = true;
                        }
                        target.input.dispatchEvent(new Event('change', { bubbles: true }));
                        target.element.style.cssText = `background: #d1fae5 !important; border: 2px solid #10b981 !important; border-radius: 6px !important; transition: all 0.3s;`;
                        selected++;
                        bank.log('✅ 自动选择', ans, '→', target.text);
                    } else {
                        bank.log('⚠️ 未匹配', ans, '可选:', options.map(o=>o.text).join(' | '));
                    }
                });

                if (selected > 0) answered++;
            });

            FloatWindow.showToast(`✅ 自动作答 ${answered} 题 | ❌ 未命中 ${missed} 题`, answered > 0 ? 'success' : 'warning');
        }
    };

    /* ==================== 悬浮窗 UI ==================== */
    const FloatWindow = {
        container: null,
        isMinimized: false,
        dragOffset: { x: 0, y: 0 },

        create() {
            if (this.container) return;
            const div = document.createElement('div');
            div.id = 'moodle-float-panel';
            div.style.cssText = `
                position: fixed; top: 100px; right: 20px; width: 220px;
                background: rgba(255,255,255,0.95); backdrop-filter: blur(10px);
                border: 1px solid rgba(226,232,240,0.8); border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
                z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px; color: #334155; overflow: hidden; user-select: none;
                transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s;
            `;

            const stats = bank.getStats();
            div.innerHTML = `
                <div id="mfp-header" style="padding: 14px 16px; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; cursor: move; display: flex; justify-content: space-between; align-items: center; border-radius: 15px 15px 0 0;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px;">
                        <span style="font-size: 16px;">🧠</span><span>Moodle 题库助手</span>
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button id="mfp-min" style="background: rgba(255,255,255,0.2); border: none; color: white; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center;">─</button>
                        <button id="mfp-close" style="background: rgba(255,255,255,0.2); border: none; color: white; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center;">✕</button>
                    </div>
                </div>
                <div id="mfp-body" style="padding: 16px;">
                    <div id="mfp-status" style="background: #f1f5f9; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 12px; color: #475569; display: flex; justify-content: space-between; align-items: center;">
                        <span>📚 题库: <strong id="mfp-count" style="color: #3b82f6;">${stats.total}</strong> 题</span>
                        <span style="font-size: 11px; color: #94a3b8;">🔄 ${stats.repeated}</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                        <button id="mfp-capture" style="width: 100%; padding: 10px; border: none; border-radius: 10px; background: #3b82f6; color: white; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 2px 8px rgba(59,130,246,0.3);">📥 抓取当前页答案</button>
                        <button id="mfp-answer" style="width: 100%; padding: 10px; border: none; border-radius: 10px; background: #10b981; color: white; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 2px 8px rgba(16,185,129,0.3);">▶️ 执行自动答题</button>
                        <button id="mfp-cloud" style="width: 100%; padding: 10px; border: none; border-radius: 10px; background: #8b5cf6; color: white; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 2px 8px rgba(139,92,246,0.3);">☁️ 同步云端题库</button>
                        <button id="mfp-manage" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 10px; background: white; color: #475569; font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">📋 打开题库管理</button>
                    </div>
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; line-height: 1.5;">
                        自动检测: <span id="mfp-auto" style="color: #3b82f6; font-weight: 500;">等待中...</span>
                    </div>
                </div>
            `;

            document.body.appendChild(div);
            this.container = div;

            const header = div.querySelector('#mfp-header');
            header.addEventListener('mousedown', (e) => this.startDrag(e));

            div.querySelector('#mfp-min').onclick = () => this.toggleMinimize();
            div.querySelector('#mfp-close').onclick = () => this.hide();
            div.querySelector('#mfp-capture').onclick = () => Core.capture();
            div.querySelector('#mfp-answer').onclick = () => Core.answer();
            div.querySelector('#mfp-cloud').onclick = () => CloudAPI.sync();
            div.querySelector('#mfp-manage').onclick = () => Manager.show();

            const pos = JSON.parse(localStorage.getItem('moodle_float_pos') || '{}');
            if (pos.top && pos.left) {
                div.style.top = pos.top + 'px'; div.style.left = pos.left + 'px'; div.style.right = 'auto';
            }
        },

        startDrag(e) {
            const div = this.container;
            this.dragOffset.x = e.clientX - div.offsetLeft;
            this.dragOffset.y = e.clientY - div.offsetTop;
            const onMove = (ev) => {
                let x = ev.clientX - this.dragOffset.x;
                let y = ev.clientY - this.dragOffset.y;
                x = Math.max(0, Math.min(window.innerWidth - div.offsetWidth, x));
                y = Math.max(0, Math.min(window.innerHeight - div.offsetHeight, y));
                div.style.left = x + 'px'; div.style.top = y + 'px'; div.style.right = 'auto';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                localStorage.setItem('moodle_float_pos', JSON.stringify({
                    top: parseInt(div.style.top), left: parseInt(div.style.left)
                }));
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },

        toggleMinimize() {
            const body = this.container.querySelector('#mfp-body');
            const btn = this.container.querySelector('#mfp-min');
            if (this.isMinimized) {
                body.style.display = 'block'; btn.textContent = '─'; this.container.style.width = '220px';
            } else {
                body.style.display = 'none'; btn.textContent = '□'; this.container.style.width = 'auto';
            }
            this.isMinimized = !this.isMinimized;
        },

        hide() {
            if (!this.container) return;
            this.container.style.opacity = '0'; this.container.style.transform = 'scale(0.9)';
            setTimeout(() => { this.container.style.display = 'none'; this.createRestoreButton(); }, 300);
        },

        show() {
            if (!this.container) this.create();
            this.container.style.display = 'block';
            setTimeout(() => { this.container.style.opacity = '1'; this.container.style.transform = 'scale(1)'; }, 10);
            const restoreBtn = document.getElementById('mfp-restore');
            if (restoreBtn) restoreBtn.remove();
        },

        createRestoreButton() {
            if (document.getElementById('mfp-restore')) return;
            const btn = document.createElement('div');
            btn.id = 'mfp-restore';
            btn.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; width: 48px; height: 48px;
                background: linear-gradient(135deg, #3b82f6, #2563eb); border-radius: 50%;
                box-shadow: 0 4px 16px rgba(59,130,246,0.4); display: flex; align-items: center;
                justify-content: center; cursor: pointer; z-index: 999999; font-size: 20px; color: white;
                transition: transform 0.2s;
            `;
            btn.innerHTML = '🧠'; btn.title = '显示题库助手';
            btn.onclick = () => { btn.remove(); this.show(); };
            btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.1)');
            btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');
            document.body.appendChild(btn);
        },

        updateStatus() {
            const stats = bank.getStats();
            const countEl = document.getElementById('mfp-count');
            if (countEl) countEl.textContent = stats.total;
            const autoEl = document.getElementById('mfp-auto');
            if (autoEl) {
                const questions = Parser.getQuestions();
                if (questions.length === 0) { autoEl.textContent = '未检测到题目'; autoEl.style.color = '#94a3b8'; }
                else {
                    const hasFeedback = document.querySelector('.rightanswer, .correct, .feedback, .grading, .feedbackspan, .specificfeedback');
                    autoEl.textContent = hasFeedback ? '检测到答案，可抓取' : '检测到题目，可答题';
                    autoEl.style.color = hasFeedback ? '#3b82f6' : '#10b981';
                }
            }
        },

        showToast(msg, type = 'info') {
            const colors = { info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444' };

            const existingToasts = document.querySelectorAll('.moodle-toast');
            const offset = existingToasts.length * 56;

            const toast = document.createElement('div');
            toast.className = 'moodle-toast';
            toast.style.cssText = `
                position: fixed; top: ${20 + offset}px; left: 50%; transform: translateX(-50%) translateY(-20px);
                background: ${colors[type] || colors.info}; color: white; padding: 12px 24px;
                border-radius: 10px; font-size: 14px; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,0.15);
                z-index: 9999999; opacity: 0; transition: all 0.3s ease; pointer-events: none; white-space: nowrap;
            `;
            toast.textContent = msg;
            document.body.appendChild(toast);

            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateX(-50%) translateY(0)';
            });

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(-50%) translateY(-20px)';
                setTimeout(() => {
                    toast.remove();
                    document.querySelectorAll('.moodle-toast').forEach((t, i) => {
                        t.style.top = (20 + i * 56) + 'px';
                    });
                }, 300);
            }, 3000);
        }
    };

    /* ==================== 题库管理面板 ==================== */
    const Manager = {
        show() {
            const existing = document.getElementById('moodle-manager');
            if (existing) { existing.remove(); return; }

            const stats = bank.getStats();
            const all = bank.getAll();

            const div = document.createElement('div');
            div.id = 'moodle-manager';
            div.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.4); backdrop-filter: blur(4px); z-index: 9999999;
                display: flex; align-items: center; justify-content: center; animation: fadeIn 0.2s ease;
            `;

            div.innerHTML = `
                <div style="width: 760px; max-height: 90vh; background: white; border-radius: 16px; box-shadow: 0 25px 80px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden; animation: scaleIn 0.3s ease;">
                    <div style="padding: 20px 24px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <h3 style="margin: 0; font-size: 18px; color: #0f172a;">📋 题库管理</h3>
                            <p style="margin: 4px 0 0; font-size: 12px; color: #64748b;">共 ${stats.total} 题 · 重复 ${stats.repeated} 题</p>
                        </div>
                        <button id="mm-close" style="background: #f1f5f9; border: none; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; color: #64748b; font-size: 16px;">✕</button>
                    </div>
                    <div style="padding: 16px 24px; background: #f1f5f9; display: flex; gap: 10px; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap;">
                        <button id="mm-cloud" style="padding: 8px 16px; background: #8b5cf6; color: white; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 500;">☁️ 同步云端</button>
                        <input type="file" id="mm-import-file" accept=".json" style="display: none;">
                        <button id="mm-import-btn" style="padding: 8px 16px; background: #f59e0b; color: white; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 500;">📁 导入 JSON</button>
                    </div>
                    <div style="padding: 12px 24px; background: #f0f9ff; border-bottom: 1px solid #bae6fd;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 14px;">🔍</span>
                            <input type="text" id="mm-search" placeholder="搜索题干或答案..." style="flex: 1; padding: 8px 12px; border: 1px solid #7dd3fc; border-radius: 8px; font-size: 13px; outline: none;">
                            <span id="mm-search-count" style="font-size: 12px; color: #0369a1; min-width: 60px; text-align: right;">共 ${all.length} 题</span>
                        </div>
                    </div>
                    <div id="mm-list" style="overflow-y: auto; padding: 16px 24px; flex: 1; background: #fafafa;">
                        ${all.length === 0 ? '<div style="text-align: center; padding: 60px; color: #94a3b8;"><div style="font-size: 48px; margin-bottom: 16px;">📭</div><p>题库为空</p><p style="font-size: 13px;">在显示答案的页面点击"抓取当前页答案"即可收录</p></div>' :
                        all.map((q, i) => `
                            <div class="mm-item" data-title="${q.title.toLowerCase()}" data-answers="${q.answers.join(' ').toLowerCase()}" style="margin-bottom: 12px; padding: 14px; background: white; border-radius: 10px; border-left: 4px solid #3b82f6; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                                <div style="font-weight: 600; color: #1e293b; font-size: 13px; line-height: 1.6; margin-bottom: 8px;">${i+1}. ${q.title}</div>
                                ${q.type === 'multianswer' ? `
                                    <div style="font-size: 12px; color: #64748b; margin-bottom: 6px; background: #f8fafc; padding: 6px 10px; border-radius: 6px;">
                                        ${q.answers.map((a, j) => `<span style="display: inline-block; margin-right: 12px; color: #10b981; font-weight: 600;">空${j+1}: ${a}</span>`).join('')}
                                    </div>
                                ` : q.type === 'ddmatch' ? `
                                    <div style="font-size: 12px; color: #64748b; margin-bottom: 6px; background: #f8fafc; padding: 6px 10px; border-radius: 6px;">
                                        ${q.options.map((o, j) => `<span style="display: inline-block; margin-right: 12px;"><span style="color: #475569;">${o}</span> → <span style="color: #10b981; font-weight: 600;">${q.answers[j] || '?'}</span></span>`).join('')}
                                    </div>
                                ` : `
                                    <div style="font-size: 12px; color: #64748b; margin-bottom: 6px; background: #f8fafc; padding: 6px 10px; border-radius: 6px;">
                                        ${q.options.map((o, j) => `<span style="display: inline-block; margin-right: 12px; ${q.answers.includes(o) ? 'color:#10b981; font-weight:600;' : ''}">${String.fromCharCode(97+j)}. ${o}</span>`).join('')}
                                    </div>
                                `}
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <span style="font-size: 12px; color: #10b981; font-weight: 600;">✓ ${q.answers.join('、')}</span>
                                    <span style="font-size: 11px; color: #94a3b8;">命中 ${q.count} 次 · ${new Date(q.time).toLocaleDateString()}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;

            document.body.appendChild(div);

            div.querySelector('#mm-close').onclick = () => div.remove();
            div.onclick = (e) => { if (e.target === div) div.remove(); };

            const searchInput = div.querySelector('#mm-search');
            const searchCount = div.querySelector('#mm-search-count');
            const listContainer = div.querySelector('#mm-list');
            searchInput.addEventListener('input', (e) => {
                const keyword = e.target.value.trim().toLowerCase();
                const items = listContainer.querySelectorAll('.mm-item');
                let visible = 0;
                items.forEach(item => {
                    const title = item.getAttribute('data-title') || '';
                    const answers = item.getAttribute('data-answers') || '';
                    if (!keyword || title.includes(keyword) || answers.includes(keyword)) {
                        item.style.display = 'block'; visible++;
                    } else {
                        item.style.display = 'none';
                    }
                });
                searchCount.textContent = `显示 ${visible} 题`;
            });

            div.querySelector('#mm-cloud').onclick = () => CloudAPI.sync();

            div.querySelector('#mm-import-btn').onclick = () => div.querySelector('#mm-import-file').click();
            div.querySelector('#mm-import-file').onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        const result = bank.import(JSON.stringify(data), 'merge');
                        if (result.success) {
                            FloatWindow.showToast(`导入成功：${result.count} 题`, 'success');
                            div.remove(); Manager.show();
                        }
                    } catch (err) {
                        FloatWindow.showToast('JSON 解析失败', 'error');
                    }
                };
                reader.readAsText(file);
                e.target.value = '';
            };
        }
    };

    /* ==================== 初始化 ==================== */
    function init() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        `;
        document.head.appendChild(style);

        FloatWindow.create();
        FloatWindow.updateStatus();

        const questions = Parser.getQuestions();
        if (questions.length > 0) {
            const hasFeedback = document.querySelector('.rightanswer, .correct, .feedback, .grading, .feedbackspan, .specificfeedback');
            hadFeedbackOnLoad = !!hasFeedback;
            if (hasFeedback) {
                setTimeout(() => { Core.capture(); FloatWindow.updateStatus(); }, 1500);
            } else {
                setTimeout(() => { Core.answer(); FloatWindow.updateStatus(); }, 2000);
            }
        }

        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                hadFeedbackOnLoad = false;
                setTimeout(() => {
                    FloatWindow.updateStatus();
                    const questions = Parser.getQuestions();
                    if (questions.length > 0) {
                        const hasFeedback = document.querySelector('.rightanswer, .correct, .feedback, .grading, .feedbackspan, .specificfeedback');
                        hadFeedbackOnLoad = !!hasFeedback;
                        if (hasFeedback) {
                            setTimeout(() => Core.capture(), 1500);
                        } else {
                            setTimeout(() => Core.answer(), 2000);
                        }
                    }
                }, 2000);
                return;
            }

            if (hadFeedbackOnLoad || isCapturing) return;

            const hasFeedback = document.querySelector('.rightanswer, .correct, .feedback, .grading, .feedbackspan, .specificfeedback');
            if (hasFeedback) {
                hadFeedbackOnLoad = true;
                setTimeout(() => {
                    Core.capture();
                    FloatWindow.updateStatus();
                }, 1500);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();