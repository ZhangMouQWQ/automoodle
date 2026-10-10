// Cloudflare Worker - Moodle 题库云端服务 v4.2
// 绑定 KV Namespace: BANK_KV

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const token = url.searchParams.get('token') || request.headers.get('Authorization')?.replace('Bearer ', '');

    if (!token || token.length < 4) {
      return resp({ error: 'Missing token. Use ?token=YOUR_TOKEN' }, 401);
    }

    const userKey = `bank:${token}`;

    try {
      if (path === '/' || path === '/admin') {
        return adminPage(token);
      }

      if (path === '/api/bank' && request.method === 'GET') {
        const data = await env.BANK_KV.get(userKey);
        return resp(data ? JSON.parse(data) : {});
      }

      if (path === '/api/bank' && request.method === 'POST') {
        const body = await request.json();
        const existing = await env.BANK_KV.get(userKey);
        let bank = existing ? JSON.parse(existing) : {};

        for (const k in body) {
          const rec = body[k];
          if (!rec || !rec.title) continue;
          const old = bank[k];
          if (!old) {
            bank[k] = rec;
          } else {
            if ((rec.time || 0) > (old.time || 0)) {
              bank[k] = rec;
            } else if ((rec.time || 0) === (old.time || 0) && (rec.count || 0) > (old.count || 0)) {
              bank[k] = rec;
            }
          }
        }
        await env.BANK_KV.put(userKey, JSON.stringify(bank));
        return resp({ success: true, count: Object.keys(bank).length });
      }

      if (path === '/api/bank' && request.method === 'PUT') {
        const body = await request.json();
        await env.BANK_KV.put(userKey, JSON.stringify(body));
        return resp({ success: true, count: Object.keys(body).length });
      }

      if (path === '/api/bank/item' && request.method === 'POST') {
        const body = await request.json();
        const existing = await env.BANK_KV.get(userKey);
        let bank = existing ? JSON.parse(existing) : {};

        if (body.key && bank[body.key]) {
          delete bank[body.key];
        }

        const key = normalizeKey(body.title, body.type);
        bank[key] = {
          title: body.title,
          options: body.options || [],
          answers: body.answers || [],
          time: Date.now(),
          count: body.count || 1,
          type: body.type || 'unknown',
          subCount: body.subCount || 0
        };
        await env.BANK_KV.put(userKey, JSON.stringify(bank));
        return resp({ success: true, key, count: Object.keys(bank).length });
      }

      if (path === '/api/bank/item' && request.method === 'DELETE') {
        const key = url.searchParams.get('key');
        if (!key) return resp({ error: 'Missing key' }, 400);
        const existing = await env.BANK_KV.get(userKey);
        let bank = existing ? JSON.parse(existing) : {};
        delete bank[key];
        await env.BANK_KV.put(userKey, JSON.stringify(bank));
        return resp({ success: true, count: Object.keys(bank).length });
      }

      return resp({ error: 'Not Found' }, 404);

    } catch (e) {
      return resp({ error: e.message }, 500);
    }
  }
};

function normalizeKey(text, type) {
  let r = text
    .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/^\d+[\.\、]\s*/, '')
    .replace(/\s+/g, '')
    .replace(/[，。？！.,?!;；]/g, '')
    .toLowerCase()
    .trim();
  if (type === 'multianswer') return r.substring(0, 300);
  return r.substring(0, 60);
}

function adminPage(token) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Moodle 题库管理</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f3f4f6;color:#1f2937;line-height:1.6}
  .container{max-width:960px;margin:0 auto;padding:24px}
  header{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;padding:24px;border-radius:12px;margin-bottom:24px;box-shadow:0 4px 12px rgba(0,0,0,.1)}
  header h1{font-size:22px;margin-bottom:4px}
  header p{opacity:.9;font-size:14px}
  .toolbar{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
  .btn{padding:8px 16px;border:none;border-radius:8px;font-size:14px;cursor:pointer;transition:all .2s;font-weight:500;display:inline-flex;align-items:center;gap:6px}
  .btn-primary{background:#3b82f6;color:#fff}
  .btn-primary:hover{background:#2563eb}
  .btn-success{background:#10b981;color:#fff}
  .btn-success:hover{background:#059669}
  .btn-danger{background:#ef4444;color:#fff}
  .btn-danger:hover{background:#dc2626}
  .btn-secondary{background:#fff;color:#374151;border:1px solid #d1d5db}
  .search-box{flex:1;min-width:240px;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;outline:none}
  .search-box:focus{border-color:#3b82f6}
  .stats{font-size:13px;color:#6b7280;margin-bottom:12px}
  .card{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);border-left:4px solid #3b82f6}
  .card-title{font-weight:600;font-size:14px;color:#111827;margin-bottom:8px;word-break:break-all}
  .card-meta{font-size:12px;color:#6b7280;margin-bottom:8px}
  .card-answers{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
  .tag{background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
  .tag-gray{background:#f3f4f6;color:#4b5563}
  .card-actions{display:flex;gap:8px}
  .card-actions button{font-size:12px;padding:4px 10px}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:1000;padding:16px}
  .modal-overlay.active{display:flex}
  .modal{background:#fff;border-radius:12px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2)}
  .modal-header{padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center}
  .modal-body{padding:20px}
  .form-group{margin-bottom:14px}
  .form-group label{display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:4px}
  .form-group input,.form-group textarea,.form-group select{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;outline:none}
  .form-group input:focus,.form-group textarea:focus{border-color:#3b82f6}
  .form-group small{color:#9ca3af;font-size:11px}
  .modal-footer{padding:12px 20px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;gap:8px}
  .empty{text-align:center;padding:60px 20px;color:#9ca3af}
  .hidden{display:none!important}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>📚 Moodle 题库云端管理</h1>
    <p>Token: <code>${token}</code> | 在线增删改查题库</p>
  </header>
  <div class="toolbar">
    <input type="text" id="search" class="search-box" placeholder="🔍 搜索题干或答案...">
    <button class="btn btn-success" onclick="openModal()">➕ 新增题目</button>
    <button class="btn btn-secondary" onclick="exportJSON()">📥 导出 JSON</button>
    <input type="file" id="importFile" accept=".json" class="hidden" onchange="importJSON(this)">
    <button class="btn btn-secondary" onclick="document.getElementById('importFile').click()">📤 导入 JSON</button>
    <button class="btn btn-primary" onclick="loadBank()">🔄 刷新</button>
  </div>
  <div class="stats" id="stats">加载中...</div>
  <div id="list"></div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">新增题目</h3>
      <button class="btn btn-secondary" onclick="closeModal()" style="padding:4px 8px">✕</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="editKey">
      <div class="form-group">
        <label>题干</label>
        <textarea id="editTitle" rows="3" placeholder="输入题目内容..."></textarea>
      </div>
      <div class="form-group">
        <label>题型</label>
        <select id="editType">
          <option value="multichoice">单选题</option>
          <option value="multichoiceset">多选题</option>
          <option value="truefalse">判断题</option>
          <option value="multianswer">完形填空/阅读理解</option>
          <option value="ddmatch">拖拽匹配</option>
        </select>
      </div>
      <div class="form-group">
        <label>选项（用 / 分隔，multianswer / ddmatch 可留空）</label>
        <input type="text" id="editOptions" placeholder="选项A / 选项B / 选项C">
      </div>
      <div class="form-group">
        <label>答案（用 / 分隔，multianswer 按空顺序，ddmatch 按左侧项顺序）</label>
        <input type="text" id="editAnswers" placeholder="答案1 / 答案2 / 答案3">
        <small>ddmatch 类型请按左侧项（选项1 / 选项2...）的顺序填写对应右侧答案</small>
      </div>
      <div class="form-group">
        <label>子问题数量（multianswer 填写）</label>
        <input type="number" id="editSubCount" value="0" min="0">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveItem()">保存</button>
    </div>
  </div>
</div>

<script>
const TOKEN = '${token}';
const API = '/api/bank';
let bankData = {};

async function loadBank() {
  const res = await fetch(API + '?token=' + TOKEN);
  bankData = await res.json();
  render();
}

function render() {
  const keyword = document.getElementById('search').value.trim().toLowerCase();
  const list = document.getElementById('list');
  const keys = Object.keys(bankData);
  let html = '';
  let count = 0;
  keys.forEach((k, i) => {
    const q = bankData[k];
    const text = (q.title + ' ' + q.answers.join(' ')).toLowerCase();
    if (keyword && !text.includes(keyword)) return;
    count++;
    const isMulti = q.type === 'multianswer';
    const isDDMatch = q.type === 'ddmatch';
    const answersHtml = isMulti
      ? q.answers.map((a, idx) => '<span class="tag">空' + (idx+1) + ': ' + escapeHtml(a) + '</span>').join('')
      : isDDMatch
        ? q.options.map((o, idx) => '<span class="tag">' + escapeHtml(o) + ' → ' + escapeHtml(q.answers[idx] || '?') + '</span>').join('')
        : q.answers.map(a => '<span class="tag">' + escapeHtml(a) + '</span>').join('');
    const optionsHtml = (q.options || []).map(o => '<span class="tag tag-gray">' + escapeHtml(o) + '</span>').join('');
    html += '<div class="card">' +
      '<div class="card-title">' + (i+1) + '. ' + escapeHtml(q.title) + '</div>' +
      '<div class="card-meta">类型: ' + (q.type||'unknown') + ' | 命中 ' + (q.count||0) + ' 次</div>' +
      (optionsHtml && !isDDMatch ? '<div class="card-answers">' + optionsHtml + '</div>' : '') +
      '<div class="card-answers">' + answersHtml + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-primary" onclick="editItem(\\'' + encodeURIComponent(k) + '\\')">编辑</button>' +
        '<button class="btn btn-danger" onclick="deleteItem(\\'' + encodeURIComponent(k) + '\\')">删除</button>' +
      '</div>' +
    '</div>';
  });
  document.getElementById('stats').textContent = '共 ' + keys.length + ' 题，显示 ' + count + ' 题';
  list.innerHTML = html || '<div class="empty"><div style="font-size:48px">📭</div><p>题库为空</p></div>';
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function openModal() {
  document.getElementById('editKey').value = '';
  document.getElementById('editTitle').value = '';
  document.getElementById('editType').value = 'multichoice';
  document.getElementById('editOptions').value = '';
  document.getElementById('editAnswers').value = '';
  document.getElementById('editSubCount').value = '0';
  document.getElementById('modalTitle').textContent = '新增题目';
  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
}

function editItem(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const q = bankData[key];
  if (!q) return;
  document.getElementById('editKey').value = key;
  document.getElementById('editTitle').value = q.title;
  document.getElementById('editType').value = q.type || 'multichoice';
  document.getElementById('editOptions').value = (q.options || []).join(' / ');
  document.getElementById('editAnswers').value = (q.answers || []).join(' / ');
  document.getElementById('editSubCount').value = q.subCount || 0;
  document.getElementById('modalTitle').textContent = '编辑题目';
  document.getElementById('modal').classList.add('active');
}

async function saveItem() {
  const key = document.getElementById('editKey').value;
  const title = document.getElementById('editTitle').value.trim();
  const type = document.getElementById('editType').value;
  const options = document.getElementById('editOptions').value.split('/').map(s => s.trim()).filter(Boolean);
  const answers = document.getElementById('editAnswers').value.split('/').map(s => s.trim()).filter(Boolean);
  const subCount = parseInt(document.getElementById('editSubCount').value) || 0;
  if (!title || answers.length === 0) { alert('请填写题干和答案'); return; }
  const body = { key, title, options, answers, type, subCount, count: 1, time: Date.now() };
  const res = await fetch(API + '/item?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) { closeModal(); await loadBank(); } else { alert('保存失败'); }
}

async function deleteItem(encodedKey) {
  if (!confirm('确定删除这道题？')) return;
  const key = decodeURIComponent(encodedKey);
  const res = await fetch(API + '/item?token=' + TOKEN + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
  if (res.ok) await loadBank();
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(bankData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'moodle_bank_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}

async function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    const res = await fetch(API + '?token=' + TOKEN, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) { alert('导入成功'); await loadBank(); } else { alert('导入失败'); }
  } catch (e) { alert('JSON 解析失败'); }
  input.value = '';
}

document.getElementById('search').addEventListener('input', render);
loadBank();
</script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}