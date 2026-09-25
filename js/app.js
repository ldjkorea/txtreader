'use strict';

/* ════════════════════ IndexedDB (책 본문 저장) ════════════════════ */
const DB = (() => {
  let db = null;
  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open('NovelReaderDB', 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }
  async function put(id, content) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('books', 'readwrite');
      tx.objectStore('books').put({ id, content });
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }
  async function get(id) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const req = d.transaction('books', 'readonly').objectStore('books').get(id);
      req.onsuccess = () => resolve(req.result ? req.result.content : null);
      req.onerror = e => reject(e.target.error);
    });
  }
  async function del(id) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('books', 'readwrite');
      tx.objectStore('books').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }
  return { put, get, del };
})();

/* ════════════════════ 메타데이터 (localStorage) ════════════════════ */
const Meta = {
  books() { try { return JSON.parse(localStorage.getItem('nr-books') || '{}'); } catch(e) { return {}; } },
  saveBooks(b) { try { localStorage.setItem('nr-books', JSON.stringify(b)); return true; } catch(e) { return false; } },
  cfg() {
    const def = { font: 19, line: 2.0, pad: 16, gap: 0.9, fontFamily: 'serif', weight: 400, theme: 'sepia', brightness: 0, asSpeed: 3 };
    try { return Object.assign(def, JSON.parse(localStorage.getItem('nr-cfg') || '{}')); } catch(e) { return def; }
  },
  saveCfg(c) { try { localStorage.setItem('nr-cfg', JSON.stringify(c)); } catch(e) {} },
  lastBook() { try { return localStorage.getItem('nr-last') || null; } catch(e) { return null; } },
  setLast(id) { try { id ? localStorage.setItem('nr-last', id) : localStorage.removeItem('nr-last'); } catch(e) {} }
};

/* ════════════════════ 상태 ════════════════════ */
let cfg = Meta.cfg();
let curBook = null;          // { id, name }
let chapters = [];           // [{ idx, title, top }]
let paragraphs = [];         // 원본 단락 배열
let uiVisible = true, sheetOpen = false, lastTap = 0;
let scrollSaveTimer = null, autoScrollRAF = null, autoScrolling = false;
let searchHitEls = [];
let pendingRestore = null;
let renderToken = 0;
let importingFiles = false;
let lastStorageWarning = 0;
function topOffset() {
  const content = document.getElementById('reader-content');
  const padding = content ? Number.parseFloat(getComputedStyle(content).paddingTop) : NaN;
  return Number.isFinite(padding) ? padding : (uiVisible ? 64 : 24);
}

/* ════════════════════ 설정 적용 ════════════════════ */
function applyCfg() {
  const r = document.documentElement;
  r.style.setProperty('--font-size', cfg.font + 'px');
  r.style.setProperty('--line-height', cfg.line);
  r.style.setProperty('--side-pad', cfg.pad + 'px');
  r.style.setProperty('--para-gap', cfg.gap + 'em');
  r.style.setProperty('--font-weight', cfg.weight);
  r.style.setProperty('--body-font', cfg.fontFamily === 'sans'
    ? "-apple-system,'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif"
    : "'Noto Serif','Nanum Myeongjo','Batang',serif");
  document.body.removeAttribute('data-theme');
  if (cfg.theme !== 'sepia') document.body.setAttribute('data-theme', cfg.theme);
  document.getElementById('brightness-veil').style.opacity = cfg.brightness / 100;
  document.querySelector('meta[name=theme-color]').setAttribute('content',
    getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#9b6f2f');
  // UI 동기화
  setText('v-font', cfg.font); setText('v-line', cfg.line.toFixed(1));
  setText('v-pad', cfg.pad); setText('v-gap', cfg.gap.toFixed(1));
  setText('as-speed', cfg.asSpeed);
  document.getElementById('brightness-slider').value = cfg.brightness;
  document.querySelectorAll('[data-font]').forEach(b => b.classList.toggle('active', b.dataset.font === cfg.fontFamily));
  document.querySelectorAll('[data-weight]').forEach(b => b.classList.toggle('active', +b.dataset.weight === cfg.weight));
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === cfg.theme));
}
function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }
function saveCfg() { Meta.saveCfg(cfg); }

/* ════════════════════ 유틸 ════════════════════ */
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fileId(name, size) { return 'b_' + name.replace(/[^a-zA-Z0-9가-힣]/g, '_') + '_' + size; }
function normalizedText(text) { return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
async function fingerprintContent(content) {
  const normalized = normalizedText(content);
  if (globalThis.crypto && crypto.subtle && globalThis.TextEncoder) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }
  return 'fallback-' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function formattedTime(ts) {
  if (!ts) return '아직 읽지 않음';
  return new Date(ts).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formattedSize(size) {
  if (!Number.isFinite(size)) return '크기 정보 없음';
  if (size < 1024) return size + ' B';
  if (size < 1048576) return (size / 1024).toFixed(0) + ' KB';
  return (size / 1048576).toFixed(1) + ' MB';
}
function timeAgo(ts) {
  const d = Date.now() - ts, m = 60000, h = 3600000, day = 86400000;
  if (d < m) return '방금'; if (d < h) return Math.floor(d/m) + '분 전';
  if (d < day) return Math.floor(d/h) + '시간 전'; if (d < day*30) return Math.floor(d/day) + '일 전';
  return new Date(ts).toLocaleDateString('ko-KR', { month:'long', day:'numeric' });
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

/* ════════════════════ 챕터 감지 ════════════════════ */
const CH_RE = /^\s*(?:(?:제\s*)?\d+\s*[장화권부편회막](?=[\s:.·\-—~!?]|$)|[一二三四五六七八九十百千]+\s*[장화권부편회막](?=[\s:.·\-—~!?]|$)|프롤로그|에필로그|서장|종장|서막|종막|외전|번외)\s*.{0,40}$|^\s*(?:chapter|prologue|epilogue|part)\b.{0,40}$/i;
function isChapter(line) {
  const t = line.trim();
  if (!t || t.length > 50) return false;
  return CH_RE.test(t);
}

/* ════════════════════ 서재 렌더 ════════════════════ */
function renderLibrary() {
  const books = Meta.books();
  const ids = Object.keys(books);
  const grid = document.getElementById('book-grid');
  const empty = document.getElementById('empty-state');
  const cont = document.getElementById('continue-card');
  const search = (document.getElementById('library-search').value || '').trim().toLocaleLowerCase('ko-KR');
  const sort = document.getElementById('library-sort').value;

  if (sort === 'title') {
    ids.sort((a, b) => (books[a].name || '').localeCompare(books[b].name || '', 'ko'));
  } else if (sort === 'progress') {
    ids.sort((a, b) => (Number(b.progress) || 0) - (Number(a.progress) || 0) || (b.lastRead || 0) - (a.lastRead || 0));
  } else {
    ids.sort((a, b) => (b.lastRead || b.importedAt || 0) - (a.lastRead || a.importedAt || 0));
  }

  const lastId = Meta.lastBook();
  if (lastId && books[lastId]) {
    const book = books[lastId];
    setText('cc-title', (book.name || book.fileName || '제목 없음').replace(/\.txt$/i, ''));
    setText('cc-chapter', book.chapter || '읽던 위치에서 이어 읽기');
    document.getElementById('cc-fill').style.width = Math.max(0, Math.min(100, Number(book.progress) || 0)) + '%';
    setText('cc-pct', (Number(book.progress) || 0) + '% 읽음');
    setText('cc-time', formattedTime(book.lastRead || book.importedAt));
    cont.style.display = 'block';
    cont.setAttribute('role', 'button');
    cont.setAttribute('tabindex', '0');
    cont.onclick = () => openBook(lastId);
    cont.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(lastId); }
    };
  } else {
    cont.style.display = 'none';
  }

  const visibleIds = ids.filter(id => (books[id].name || '').toLocaleLowerCase('ko-KR').includes(search));
  if (ids.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  if (visibleIds.length === 0) {
    empty.style.display = 'none';
    grid.innerHTML = '<div class="list-empty">검색 결과가 없어요.<br>다른 작품명을 입력해 보세요.</div>';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = visibleIds.map(id => {
    const book = books[id];
    const title = escHtml((book.name || book.fileName || '제목 없음').replace(/\.txt$/i, ''));
    const chapter = book.chapter ? escHtml(book.chapter) : '읽은 기록 없음';
    const recent = book.lastRead ? timeAgo(book.lastRead) : (book.importedAt ? '추가 ' + timeAgo(book.importedAt) : '아직 읽지 않음');
    const progress = Math.max(0, Math.min(100, Number(book.progress) || 0));
    return '<div class="book-row" data-id="' + id + '">' +
      '<button class="book-row-main" type="button" data-open-book="' + id + '">' +
        '<span class="book-row-title">' + title + '</span>' +
        '<span class="book-row-sub"><span class="book-row-chapter">' + chapter + '</span><span class="book-row-dot">·</span><span>' + escHtml(recent) + '</span></span>' +
        '<span class="book-row-bar"><span class="book-row-fill" style="width:' + progress + '%"></span></span>' +
      '</button>' +
      '<span class="book-row-pct">' + progress + '%</span>' +
      '<details class="book-menu"><summary class="book-more" aria-label="책 메뉴">⋮</summary>' +
        '<div class="book-menu-items">' +
          '<button type="button" data-book-action="restart">처음부터 읽기</button>' +
          '<button type="button" data-book-action="info">책 정보</button>' +
          '<button type="button" data-book-action="delete">서재에서 삭제</button>' +
        '</div>' +
      '</details>' +
    '</div>';
  }).join('');

  if (!grid.dataset.eventsReady) {
    grid.dataset.eventsReady = 'true';
    grid.addEventListener('click', e => {
      const row = e.target.closest('.book-row');
      if (!row) return;
      const id = row.dataset.id;
      const action = e.target.closest('[data-book-action]');
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        const menu = action.closest('details');
        if (menu) menu.open = false;
        if (action.dataset.bookAction === 'delete') deleteBook(id);
        else if (action.dataset.bookAction === 'info') showBookInfo(id);
        else if (action.dataset.bookAction === 'restart') restartBook(id);
        return;
      }
      const openButton = e.target.closest('[data-open-book]');
      if (openButton) openBook(openButton.dataset.openBook);
    });
  }
}

document.getElementById('library-search').addEventListener('input', renderLibrary);
document.getElementById('library-sort').addEventListener('change', renderLibrary);

async function deleteBook(id) {
  const books = Meta.books();
  const book = books[id];
  if (!book) return;
  const name = (book.name || book.fileName || '제목 없음').replace(/\.txt$/i, '');
  if (!confirm('"' + name + '"을(를) 서재에서 삭제할까요? 저장된 본문과 독서 기록도 삭제됩니다.')) return;
  delete books[id];
  if (!Meta.saveBooks(books)) { toast('서재 정보를 저장하지 못했어요'); return; }
  if (Meta.lastBook() === id) Meta.setLast(null);
  try { await DB.del(id); } catch(e) {}
  renderLibrary();
  toast('삭제되었어요');
}

function restartBook(id) {
  const books = Meta.books();
  const book = books[id];
  if (!book || !confirm('처음부터 읽을까요? 기존 북마크는 유지됩니다.')) return;
  book.pos = { pIdx: 0, offset: 0, ratio: 0, progress: 0 };
  book.progress = 0;
  book.chapter = '';
  book.lastRead = Date.now();
  if (!Meta.saveBooks(books)) { toast('독서 기록을 저장하지 못했어요'); return; }
  renderLibrary();
  openBook(id);
}

function showBookInfo(id) {
  const book = Meta.books()[id];
  if (!book) return;
  const name = (book.name || book.fileName || '제목 없음').replace(/\.txt$/i, '');
  const details = [
    '작품명: ' + name,
    '파일명: ' + (book.fileName || book.name || '알 수 없음'),
    '파일 크기: ' + formattedSize(book.size),
    '진행률: ' + (Number(book.progress) || 0) + '%',
    '현재 챕터: ' + (book.chapter || '기록 없음'),
    '가져온 시각: ' + formattedTime(book.importedAt),
    '최근 읽은 시각: ' + formattedTime(book.lastRead)
  ];
  window.alert(details.join('\n'));
}

/* TXT 파일 가져오기 */
const fileInput = document.getElementById('file-input');
function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(String(e.target.result || ''));
    reader.onerror = () => reject(reader.error || new Error('파일 읽기 실패'));
    reader.readAsText(file, 'UTF-8');
  });
}

async function findDuplicateBook(books, fingerprint, size, content) {
  for (const id of Object.keys(books)) {
    if (books[id] && books[id].fingerprint === fingerprint) return id;
  }
  for (const id of Object.keys(books)) {
    const book = books[id];
    if (!book || book.fingerprint || Number(book.size) !== Number(size)) continue;
    try {
      const stored = await DB.get(id);
      if (stored != null && normalizedText(stored) === normalizedText(content)) {
        book.fingerprint = fingerprint;
        Meta.saveBooks(books);
        return id;
      }
    } catch(e) {}
  }
  return null;
}

async function importFiles(files) {
  if (importingFiles || !files.length) return;
  importingFiles = true;
  let added = 0, duplicates = 0, failed = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      showLoading((i + 1) + '/' + files.length + ' 가져오는 중 · ' + file.name);
      try {
        if (!/\.txt$/i.test(file.name) && !(file.type || '').toLowerCase().startsWith('text/plain')) {
          throw new Error('txt');
        }
        const content = await readFileAsText(file);
        const fingerprint = await fingerprintContent(content);
        const books = Meta.books();
        const duplicateId = await findDuplicateBook(books, fingerprint, file.size, content);
        if (duplicateId) {
          if (await DB.get(duplicateId) == null) await DB.put(duplicateId, content);
          duplicates++;
          continue;
        }

        const id = 'sha256_' + fingerprint;
        if (books[id]) { duplicates++; continue; }
        const now = Date.now();
        const record = {
          name: file.name, fileName: file.name, size: file.size, fingerprint,
          importedAt: now, lastRead: now, pos: { pIdx: 0, offset: 0, ratio: 0 },
          progress: 0, chapter: '', bookmarks: []
        };
        await DB.put(id, content);
        books[id] = record;
        if (!Meta.saveBooks(books)) {
          try { await DB.del(id); } catch(e) {}
          throw new Error('meta');
        }
        added++;
      } catch(err) {
        failed++;
      }
    }
  } finally {
    importingFiles = false;
    hideLoading();
    renderLibrary();
  }

  if (added === 0 && duplicates > 0 && failed === 0) {
    toast('이미 서재에 있는 책입니다. 기존 독서 기록을 유지했어요.');
  } else {
    const result = [];
    if (added) result.push(added + '권 추가');
    if (duplicates) result.push(duplicates + '권은 기존 기록 유지');
    if (failed) result.push(failed + '개 실패');
    toast(result.join(' · ') || '가져온 파일이 없어요');
  }
}

fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) importFiles(files);
});

async function openBook(id) {
  const books = Meta.books();
  const book = books[id];
  if (!book) { toast('책을 찾을 수 없어요'); return; }
  showLoading((book.name || book.fileName || '책') + ' 불러오는 중...');
  try {
    const content = await DB.get(id);
    if (content == null) {
      hideLoading();
      if (confirm('저장된 본문이 없어요. TXT 파일을 다시 가져올까요?')) fileInput.click();
      return;
    }
    loadContent(id, book.name || book.fileName || '제목 없음', content);
  } catch(e) {
    hideLoading();
    toast('책을 불러오지 못했어요');
  }
}

function loadContent(id, name, raw) {
  const token = ++renderToken;
  curBook = { id, name };
  Meta.setLast(id);
  const bookRecords = Meta.books();
  if (bookRecords[id]) {
    bookRecords[id].lastRead = Date.now();
    Meta.saveBooks(bookRecords);
  }
  setText('book-title', name.replace(/\.txt$/i, ''));

  paragraphs = normalizedText(raw).split(/\n{2,}/);
  chapters = [];
  pendingRestore = null;
  const savedPos = (Meta.books()[id] || {}).pos || null;
  const disp = document.getElementById('text-display');
  disp.innerHTML = '';
  window.scrollTo(0, 0);

  document.getElementById('library').style.display = 'none';
  document.getElementById('reader').classList.add('show');
  document.getElementById('toolbar').classList.add('show');
  document.getElementById('status-bar').classList.add('show');
  hideUI();

  const CHUNK = 320;
  let idx = 0, restored = false;
  const targetIdx = savedPos && typeof savedPos === 'object' && Number.isInteger(savedPos.pIdx) ? savedPos.pIdx : -1;

  function restoreWhenReady(allDone) {
    if (restored) return;
    if (savedPos != null && !allDone) {
      if (typeof savedPos === 'number' || targetIdx < 0 || targetIdx >= idx) return;
    }
    restored = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== renderToken) return;
      restorePosition(savedPos);
      updateProgress();
      hideLoading();
    }));
  }

  function chunk() {
    if (token !== renderToken) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(idx + CHUNK, paragraphs.length);
    for (let i = idx; i < end; i++) {
      const lines = paragraphs[i].split('\n').map(line => line.trim()).filter(Boolean);
      const p = document.createElement('p');
      p.id = 'p' + i;
      if (!lines.length) {
        p.className = 'blank';
      } else if (lines.length === 1 && isChapter(lines[0])) {
        p.className = 'chapter';
        p.textContent = lines[0];
        chapters.push({ pid: 'p' + i, title: lines[0] });
      } else {
        p.innerHTML = lines.map(escHtml).join('<br>');
      }
      if (targetIdx >= 0 && i <= targetIdx) p.classList.add('restore-layout');
      frag.appendChild(p);
    }
    disp.appendChild(frag);
    idx = end;
    restoreWhenReady(false);

    if (idx < paragraphs.length) {
      requestAnimationFrame(chunk);
    } else {
      restoreWhenReady(true);
      buildTOC();
      updateProgress();
    }
  }
  requestAnimationFrame(chunk);
  closeSheet();
  switchTab('settings');
}

function buildTOC() {
  const list = document.getElementById('toc-list');
  if (chapters.length === 0) {
    list.innerHTML = '<div class="list-empty"><div class="le-icon">📖</div>이 책에서는 목차를<br>자동으로 찾지 못했어요</div>';
    return;
  }
  list.innerHTML = chapters.map((chapter, i) =>
    '<div class="list-item" data-pid="' + chapter.pid + '"><span class="li-idx">' + (i + 1) + '</span>' +
    '<div class="li-body"><div class="li-title">' + escHtml(chapter.title) + '</div></div></div>'
  ).join('');
  list.querySelectorAll('.list-item').forEach(el => {
    el.addEventListener('click', () => { jumpTo(el.dataset.pid); closeSheet(); });
  });
}
function jumpTo(pid) {
  const el = document.getElementById(pid);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

/* ════════════════════ 북마크 ════════════════════ */
document.getElementById('btn-bookmark').addEventListener('click', toggleBookmark);
function toggleBookmark() {
  if (!curBook) return;
  const books = Meta.books();
  const b = books[curBook.id];
  if (!b) return;
  b.bookmarks = b.bookmarks || [];
  const pos = capturePosition();
  const pct = pos.pct;
  const preview = previewAtScroll();
  b.bookmarks.unshift({ pos: { pIdx: pos.pIdx, offset: pos.offset, ratio: pos.ratio, progress: pos.pct, chapter: pos.chapter }, pct, text: preview, time: Date.now() });
  if (b.bookmarks.length > 50) b.bookmarks.pop();
  Meta.saveBooks(books);
  renderBookmarks();
  toast('북마크 추가됨 · ' + pct + '%');
  flashBookmarkIcon();
}
function flashBookmarkIcon() {
  const btn = document.getElementById('btn-bookmark');
  btn.classList.add('bookmarked');
  setTimeout(() => btn.classList.remove('bookmarked'), 700);
}
function previewAtScroll() {
  const paragraph = paragraphAtAnchor(window.scrollY + 120);
  return paragraph && !paragraph.classList.contains('blank') ? (paragraph.textContent || '').slice(0, 60) : '';
}

function renderBookmarks() {
  const list = document.getElementById('bookmark-list');
  const b = curBook ? (Meta.books()[curBook.id] || {}) : {};
  const bms = b.bookmarks || [];
  if (bms.length === 0) {
    list.innerHTML = `<div class="list-empty"><div class="le-icon">🔖</div>북마크가 없어요<br>상단 책갈피 아이콘을 눌러 추가하세요</div>`;
    return;
  }
  list.innerHTML = bms.map((bm, i) =>
    `<div class="list-item" data-bmidx="${i}"><span class="li-idx">${bm.pct}%</span>
      <div class="li-body"><div class="li-title">${escHtml(bm.text || '(빈 위치)')}</div><div class="li-sub">${timeAgo(bm.time)}</div></div>
      <button class="li-del" data-bmdel="${i}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`
  ).join('');
  list.querySelectorAll('.list-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.li-del')) return;
      const bm = (Meta.books()[curBook.id].bookmarks || [])[+el.dataset.bmidx];
      if (bm) restorePosition(bm.pos);
      closeSheet();
    });
  });
  list.querySelectorAll('[data-bmdel]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const books = Meta.books(); const bk = books[curBook.id];
      bk.bookmarks.splice(+btn.dataset.bmdel, 1);
      Meta.saveBooks(books); renderBookmarks();
    });
  });
}

/* ════════════════════ 검색 ════════════════════ */
const searchInput = document.getElementById('search-input');
document.getElementById('search-go').addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
function doSearch() {
  const q = searchInput.value.trim();
  const cnt = document.getElementById('search-count');
  const box = document.getElementById('search-results');
  clearSearchHits();
  if (q.length < 1) { cnt.textContent = ''; box.innerHTML = ''; return; }
  const re = new RegExp(escReg(q), 'gi');
  const results = [];
  for (let i = 0; i < paragraphs.length && results.length < 200; i++) {
    const txt = paragraphs[i].replace(/\n/g, ' ');
    if (re.test(txt)) {
      re.lastIndex = 0;
      const m = txt.search(re);
      const start = Math.max(0, m - 18);
      const snippet = (start > 0 ? '…' : '') + txt.slice(start, m + q.length + 42) + '…';
      results.push({ pid: 'p' + i, snippet });
    }
    re.lastIndex = 0;
  }
  cnt.textContent = results.length ? `${results.length}개 발견` : '결과 없음';
  box.innerHTML = results.map(r => {
    const hl = escHtml(r.snippet).replace(new RegExp(escReg(escHtml(q)), 'gi'), m => `<mark>${m}</mark>`);
    return `<div class="search-result" data-pid="${r.pid}"><div class="sr-text">${hl}</div></div>`;
  }).join('');
  box.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      const pid = el.dataset.pid;
      highlightHit(pid);
      jumpTo(pid); closeSheet();
    });
  });
}
function highlightHit(pid) {
  clearSearchHits();
  const el = document.getElementById(pid);
  if (!el) return;
  el.classList.add('search-hit');
  searchHitEls.push(el);
  setTimeout(clearSearchHits, 3000);
}
function clearSearchHits() { searchHitEls.forEach(el => el.classList.remove('search-hit')); searchHitEls = []; }

/* 단락 기준 위치 저장과 복원 */
function paragraphAtAnchor(anchor) {
  const nodes = document.getElementById('text-display').children;
  if (!nodes.length) return null;
  let low = 0, high = nodes.length - 1, answer = nodes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rect = nodes[mid].getBoundingClientRect();
    const top = rect.top + window.scrollY;
    if (top + Math.max(1, rect.height) > anchor) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return nodes[answer] || null;
}

function capturePosition() {
  const anchor = window.scrollY + topOffset();
  const paragraph = paragraphAtAnchor(anchor);
  if (!paragraph) return { pIdx: 0, offset: 0, ratio: 0, pct: curPct(), chapter: curChapterTitle() };
  const rect = paragraph.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const height = Math.max(1, rect.height);
  const offset = Math.max(0, Math.min(height, anchor - top));
  const index = Number.parseInt(paragraph.id.slice(1), 10);
  return {
    pIdx: Number.isFinite(index) ? index : 0,
    offset: Math.round(offset),
    ratio: Math.max(0, Math.min(1, offset / height)),
    pct: curPct(),
    chapter: curChapterTitle()
  };
}

function restorePosition(pos) {
  if (pos == null) { window.scrollTo(0, 0); return; }
  if (typeof pos === 'number') { window.scrollTo(0, pos); return; }
  const index = Number.isInteger(pos.pIdx) ? pos.pIdx : -1;
  const paragraph = index >= 0 ? document.getElementById('p' + index) : null;
  if (!paragraph) {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const progress = Number.isFinite(pos.progress) ? pos.progress : 0;
    window.scrollTo(0, Math.max(0, total * Math.max(0, Math.min(100, progress)) / 100));
    return;
  }
  const rect = paragraph.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const height = Math.max(1, rect.height);
  const offset = Number.isFinite(pos.ratio)
    ? Math.max(0, Math.min(1, pos.ratio)) * height
    : Math.max(0, Math.min(height, Number(pos.offset) || 0));
  window.scrollTo(0, Math.max(0, top + offset - topOffset()));
}

function curPct() {
  const total = document.documentElement.scrollHeight - window.innerHeight;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(window.scrollY / total * 100))) : 0;
}
function curChapterTitle() {
  if (!chapters.length) return '';
  const y = window.scrollY + topOffset();
  let low = 0, high = chapters.length - 1, current = '';
  while (low <= high) {
    const mid = (low + high) >> 1;
    const chapter = chapters[mid];
    const el = document.getElementById(chapter.pid);
    if (!el) { low = mid + 1; continue; }
    if (el.getBoundingClientRect().top + window.scrollY <= y) {
      current = chapter.title;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return current;
}
function updateProgress() {
  const total = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = total > 0 ? Math.max(0, Math.min(1, window.scrollY / total)) : 0;
  document.getElementById('progress-bar').style.transform = 'scaleX(' + ratio + ')';
  document.getElementById('reader-progress-fill').style.width = (ratio * 100) + '%';
  setText('pct-now', Math.round(ratio * 100) + '%');
  setText('chapter-now', curChapterTitle());
}
function saveScrollPos() {
  if (!curBook) return;
  const books = Meta.books();
  const book = books[curBook.id];
  if (!book) return;
  const position = capturePosition();
  book.pos = {
    pIdx: position.pIdx,
    offset: position.offset,
    ratio: position.ratio,
    progress: position.pct,
    chapter: position.chapter
  };
  book.progress = position.pct;
  book.chapter = position.chapter;
  book.lastRead = Date.now();
  if (!Meta.saveBooks(books) && Date.now() - lastStorageWarning > 15000) {
    lastStorageWarning = Date.now();
    toast('독서 위치를 저장하지 못했어요');
  }
}

window.addEventListener('scroll', () => {
  if (!curBook) return;
  updateProgress();
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveScrollPos, 350);
}, { passive: true });

function saveNow() {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = null;
  if (curBook) saveScrollPos();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveNow(); stopAutoScroll(); }
});
window.addEventListener('pagehide', saveNow);
window.addEventListener('beforeunload', saveNow);
window.addEventListener('blur', saveNow);

/* Keep the visible sentence anchored when reader layout changes. */
function updateCfgKeepingPlace(change) {
  const position = curBook ? capturePosition() : null;
  change();
  applyCfg();
  saveCfg();
  if (position) requestAnimationFrame(() => requestAnimationFrame(() => restorePosition(position)));
}

/* ════════════════════ 자동 스크롤 ════════════════════ */
function startAutoScroll() {
  if (autoScrolling) return;
  autoScrolling = true;
  document.getElementById('autoscroll-ind').classList.add('show');
  setText('autoscroll-toggle', '중지');
  document.getElementById('autoscroll-toggle').classList.add('active');
  let acc = 0;
  function step() {
    if (!autoScrolling) return;
    acc += cfg.asSpeed * 0.45;
    if (acc >= 1) { window.scrollBy(0, acc); acc = 0; }
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) { stopAutoScroll(); return; }
    autoScrollRAF = requestAnimationFrame(step);
  }
  autoScrollRAF = requestAnimationFrame(step);
}
function stopAutoScroll() {
  if (!autoScrolling) return;
  autoScrolling = false;
  cancelAnimationFrame(autoScrollRAF);
  document.getElementById('autoscroll-ind').classList.remove('show');
  setText('autoscroll-toggle', '시작');
  document.getElementById('autoscroll-toggle').classList.remove('active');
}
document.getElementById('autoscroll-toggle').addEventListener('click', () => {
  if (autoScrolling) stopAutoScroll(); else { startAutoScroll(); closeSheet(); }
});
document.getElementById('as-stop').addEventListener('click', stopAutoScroll);
document.getElementById('as-slower').addEventListener('click', () => { cfg.asSpeed = Math.max(1, cfg.asSpeed - 1); setText('as-speed', cfg.asSpeed); saveCfg(); });
document.getElementById('as-faster').addEventListener('click', () => { cfg.asSpeed = Math.min(10, cfg.asSpeed + 1); setText('as-speed', cfg.asSpeed); saveCfg(); });

/* ════════════════════ UI 토글 (탭) ════════════════════ */
function setUIVisibility(visible) {
  const next = Boolean(visible);
  const content = document.getElementById('reader-content');
  if (next === uiVisible) {
    content.classList.toggle('ui-visible', next);
    return;
  }
  const hasRenderedText = document.getElementById('text-display').childElementCount > 0;
  const position = curBook && hasRenderedText ? capturePosition() : null;
  uiVisible = next;
  document.getElementById('toolbar').classList.toggle('hide', !next);
  document.getElementById('status-bar').classList.toggle('hide', !next);
  content.classList.toggle('ui-visible', next);
  if (curBook) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (position && curBook) restorePosition(position);
      updateProgress();
    }));
  }
}
function showUI() { setUIVisibility(true); }
function hideUI() { setUIVisibility(false); }
document.addEventListener('click', e => {
  if (!document.getElementById('reader').classList.contains('show')) return;
  if (e.target.closest('#toolbar, #sheet, #overlay, #autoscroll-ind, button, input, a')) return;
  const now = Date.now();
  if (now - lastTap < 280) return;
  lastTap = now;
  if (sheetOpen) { closeSheet(); return; }
  if (autoScrolling) { stopAutoScroll(); return; }
  uiVisible ? hideUI() : showUI();
});

/* ════════════════════ 시트 ════════════════════ */
function openSheet() {
  sheetOpen = true;
  document.getElementById('sheet').classList.add('open');
  document.getElementById('overlay').classList.add('show');
  showUI();
}
function closeSheet() {
  sheetOpen = false;
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
  searchInput.blur();
}
function switchTab(name) {
  document.querySelectorAll('.sheet-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'toc') buildTOC();
  if (name === 'bookmarks') renderBookmarks();
  if (name === 'search') setTimeout(() => searchInput.focus(), 250);
}
document.getElementById('btn-menu').addEventListener('click', e => { e.stopPropagation(); openSheet(); switchTab('settings'); });
document.getElementById('overlay').addEventListener('click', closeSheet);
document.querySelectorAll('.sheet-tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
document.querySelectorAll('[data-reader-tab]').forEach(button => {
  button.addEventListener('click', e => {
    e.stopPropagation();
    openSheet();
    switchTab(button.dataset.readerTab);
  });
});

/* 설정 컨트롤 */
document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.act;
    updateCfgKeepingPlace(() => {
      if (action === 'font+') cfg.font = Math.min(40, cfg.font + 1);
      else if (action === 'font-') cfg.font = Math.max(8, cfg.font - 1);
      else if (action === 'line+') cfg.line = Math.min(3.5, Math.round((cfg.line + 0.1) * 10) / 10);
      else if (action === 'line-') cfg.line = Math.max(1.2, Math.round((cfg.line - 0.1) * 10) / 10);
      else if (action === 'pad+') cfg.pad = Math.min(80, cfg.pad + 4);
      else if (action === 'pad-') cfg.pad = Math.max(0, cfg.pad - 4);
      else if (action === 'gap+') cfg.gap = Math.min(2.5, Math.round((cfg.gap + 0.1) * 10) / 10);
      else if (action === 'gap-') cfg.gap = Math.max(0, Math.round((cfg.gap - 0.1) * 10) / 10);
    });
  });
});
document.querySelectorAll('[data-font]').forEach(button => button.addEventListener('click', () => {
  updateCfgKeepingPlace(() => { cfg.fontFamily = button.dataset.font; });
}));
document.querySelectorAll('[data-weight]').forEach(button => button.addEventListener('click', () => {
  updateCfgKeepingPlace(() => { cfg.weight = Number(button.dataset.weight); });
}));
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
  updateCfgKeepingPlace(() => { cfg.theme = button.dataset.theme; });
}));
document.getElementById('brightness-slider').addEventListener('input', e => {
  cfg.brightness = Number(e.target.value);
  document.getElementById('brightness-veil').style.opacity = cfg.brightness / 100;
});
document.getElementById('brightness-slider').addEventListener('change', saveCfg);

/* ════════════════════ 서재 복귀 ════════════════════ */
document.getElementById('btn-home').addEventListener('click', () => {
  saveNow(); stopAutoScroll(); closeSheet();
  renderToken++;
  curBook = null;
  document.getElementById('reader').classList.remove('show');
  document.getElementById('toolbar').classList.remove('show');
  document.getElementById('status-bar').classList.remove('show');
  document.getElementById('progress-bar').style.transform = 'scaleX(0)';
  document.getElementById('library').style.display = 'block';
  window.scrollTo(0, 0);
  renderLibrary();
});

/* 파일 추가 버튼들 */
['add-btn-top', 'add-btn-empty'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => document.getElementById('file-input').click());
});

/* ════════════════════ 로딩 ════════════════════ */
function showLoading(name) { setText('loading-msg', name + ' 불러오는 중...'); document.getElementById('loading').classList.add('show'); }
function hideLoading() { document.getElementById('loading').classList.remove('show'); }

/* ════════════════════ Service Worker ════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ════════════════════ 초기화 ════════════════════ */
applyCfg();
renderLibrary();
