/* ==========================================================================
   main.js — 交互层
   1. 环幕轮播（3D 圆柱：自动旋转 / 拖拽惯性 / 吸附 / 键盘 / 触点）
   2. 目录网格（渲染 + 色调筛选 + 自传图片的增量插入与移除）
   3. 灯箱（放大查看 + 键盘导航 + 焦点回收）
   4. 上传（本机图片 → canvas 缩放编码 → 色调分析 → IndexedDB 落盘）
   5. 入场编排与导航状态
   说明：全部逻辑用普通脚本封装在 IIFE 内，双击本地文件即可运行，
        不依赖任何构建工具与模块加载（避免 file:// 下的跨域限制）。
   ========================================================================== */
(function () {
  'use strict';

  var DATA = window.ANIME_FRAMES;
  if (!DATA || !DATA.frames) return;

  var FRAMES = DATA.frames;        // 内置素材，自传的图片会插到最前面
  var HERO = FRAMES.filter(function (f) { return f.hero; });
  var TAGS = ['全部', '夜色', '明亮', '暖调', '冷调', '低饱和'];

  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $ = function (sel) { return document.querySelector(sel); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var mod = function (n, m) { return ((n % m) + m) % m; };

  /* 内置素材有三档尺寸，自传的图只有一张 blob 地址 */
  function imgURL(f, size) {
    return f.custom ? f.src : 'assets/' + size + '/' + f.name + '.webp';
  }
  function kindOf(f) { return f.custom ? '自传图片' : '动画截图'; }

  /* ======================================================================
     一、环幕轮播
     ====================================================================== */
  var ring = $('#ring');
  var carousel = $('#carousel');

  var STEP = 360 / HERO.length;    // 相邻面板夹角
  var AUTO_SPEED = 6;              // 自动旋转速度：度 / 秒
  var angle = 0;                   // 环幕当前旋转角
  var velocity = 0;                // 拖拽松手后的惯性
  var dragging = false;
  var moved = false;               // 本次指针交互是否发生了位移（用于区分点击与拖拽）
  var auto = !REDUCE;              // 是否自动旋转
  var activeIndex = 0;
  var tween = null;                // 吸附 / 跳转的补间
  var panelEls = [];

  /* --- 构建面板 --- */
  HERO.forEach(function (f, i) {
    var el = document.createElement('article');
    el.className = 'panel' + (i === 0 ? ' is-active' : '');
    el.style.setProperty('--i', i);
    el.innerHTML =
      '<div class="panel__frame">' +
        '<img class="panel__img" draggable="false" src="assets/hero/' + f.name + '.webp" ' +
             'alt="' + (f.title ? f.title + '：' : '') + '动画截图，色调' + f.tags.join('、') + '">' +
        '<span class="panel__veil"></span>' +
      '</div>';
    el.addEventListener('click', function () {
      if (moved) return;                       // 拖拽后的误触不算点击
      if (i === activeIndex) { openLightbox(f); }
      else { goToIndex(i); }
    });
    ring.appendChild(el);
    panelEls.push(el);
  });

  /* --- 响应式尺寸 ---
     透视会把最前方那张放大 P/(P-R) 倍，所以先定"屏幕上想看到多大"，
     再反推面板实宽，这样环幕既够大、两侧又能留出环绕的余韵。 */
  var PERSPECTIVE = 2000;   // 与 components.css 里的 perspective 保持一致

  function layout() {
    var rect = carousel.getBoundingClientRect();
    var vw = rect.width || window.innerWidth;
    var vh = window.innerHeight;
    var cot = 1 / Math.tan(Math.PI / HERO.length);   // 半径系数：R = (w/2)·cot

    var shownW = vw * (vw < 700 ? 0.92 : 0.80);
    shownW = Math.min(shownW, vh * 1.08);
    shownW = Math.max(shownW, 240);

    var w = shownW * PERSPECTIVE / (PERSPECTIVE + (cot / 2) * shownW);
    var h = w / DATA.ratio;
    var radius = (w / 2) * cot * 1.04;

    ring.style.setProperty('--panel-w', w.toFixed(1) + 'px');
    ring.style.setProperty('--panel-h', h.toFixed(1) + 'px');
    ring.style.setProperty('--radius', radius.toFixed(1) + 'px');
    ring.style.setProperty('--step', STEP + 'deg');
  }

  /* --- 主循环：补间 → 惯性 → 自动旋转 → 渲染 --- */
  var lastTime = performance.now();

  function loop(now) {
    var dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (tween) {
      var t = Math.min((now - tween.start) / tween.dur, 1);
      var eased = 1 - Math.pow(1 - t, 3);            // easeOutCubic
      angle = tween.from + (tween.to - tween.from) * eased;
      if (t >= 1) tween = null;
    } else if (!dragging) {
      if (Math.abs(velocity) > 0.4) {
        angle += velocity * dt * 60;
        velocity *= 0.93;                            // 惯性衰减
      } else {
        velocity = 0;
        if (auto) { angle -= AUTO_SPEED * dt; }
        else { snap(); }
      }
    }

    render();
    requestAnimationFrame(loop);
  }

  /* 松手 / 暂停自动时吸附到最近的一张 */
  function snap() {
    var target = Math.round(angle / STEP) * STEP;
    if (Math.abs(target - angle) > 0.1) { angle += (target - angle) * 0.14; }
    else { angle = target; }
  }

  function animateTo(target) {
    if (REDUCE) { angle = target; return; }
    tween = { from: angle, to: target, start: performance.now(), dur: 620 };
  }

  /* 按方向翻一张（← → 键） */
  function stepBy(dir) {
    animateTo(angle - dir * STEP);
  }

  /* 直接跳到某一张（点击非当前面板） */
  function goToIndex(i) {
    var base = -i * STEP;
    var k = Math.round((angle - base) / 360);
    animateTo(base + k * 360);
  }

  /* --- 渲染：只在当前画面变化时才写 DOM --- */
  function render() {
    ring.style.transform = 'rotateY(' + angle.toFixed(3) + 'deg)';
    var idx = mod(Math.round(-angle / STEP), HERO.length);
    if (idx !== activeIndex) {
      activeIndex = idx;
      panelEls.forEach(function (el, i) { el.classList.toggle('is-active', i === activeIndex); });
    }
  }

  /* --- 拖拽旋转（指针事件，兼容鼠标与触摸） --- */
  var startX = 0, lastX = 0, startAngle = 0;

  carousel.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = lastX = e.clientX;
    startAngle = angle;
    tween = null;
    velocity = 0;
    carousel.classList.add('is-dragging');
    if (carousel.setPointerCapture) { carousel.setPointerCapture(e.pointerId); }
  });

  carousel.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - startX;
    if (Math.abs(dx) > 4) { moved = true; }
    angle = startAngle + dx * 0.22;               // 0.22 度 / 像素
    velocity = (e.clientX - lastX) * 0.22;
    lastX = e.clientX;
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    carousel.classList.remove('is-dragging');
    if (Math.abs(velocity) < 0.4) { velocity = 0; }
  }
  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointercancel', endDrag);
  carousel.addEventListener('pointerleave', endDrag);

  /* --- 触控板横向滑动：只接管横向，纵向滚动留给页面 --- */
  window.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    var rect = carousel.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    e.preventDefault();
    angle += e.deltaX * 0.28;
    auto = false;
  }, { passive: false });

  /* --- 键盘：← → 翻一张，空格切自动旋转 --- */
  document.addEventListener('keydown', function (e) {
    if (lb.classList.contains('is-open')) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key === 'ArrowLeft') { auto = false; stepBy(-1); }
    else if (e.key === 'ArrowRight') { auto = false; stepBy(1); }
    else if (e.key === ' ' && document.activeElement === document.body) {
      e.preventDefault();
      auto = !auto;
    }
  });

  /* ======================================================================
     二、目录网格
     ====================================================================== */
  var grid = $('#grid');
  var filters = $('#filters');
  var empty = $('#empty');
  var currentTag = '全部';
  var revealIO = null;
  var addBtn = null;

  function buildCard(f, i) {
    var card = document.createElement('figure');
    card.className = 'card reveal';
    card.dataset.id = String(f.id);
    card.dataset.tags = f.tags.join(',');
    // 同屏卡片错峰淡入，间隔 60ms 一档
    card.style.transitionDelay = (i % 4) * 60 + 'ms';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card__frame';
    btn.setAttribute('aria-label', '放大查看' + (f.title ? '：' + f.title : '这张图片'));

    var img = document.createElement('img');
    img.className = 'card__img';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = imgURL(f, 'grid');
    img.alt = (f.title ? f.title + '：' : '') + kindOf(f) + '，色调' + f.tags.join('、');

    btn.appendChild(img);

    // 有题名的才在悬停时浮现题名条，没有的就保持干净
    if (f.title) {
      var hover = document.createElement('span');
      hover.className = 'card__hover';
      hover.textContent = f.title;
      btn.appendChild(hover);
    }

    btn.addEventListener('click', function () { openLightbox(f); });
    card.appendChild(btn);

    // 自己传的才给移除按钮
    if (f.custom) {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'card__remove';
      rm.title = '移除';
      rm.setAttribute('aria-label', '移除这张图片');
      rm.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        removeCustom(f);
      });
      card.appendChild(rm);
    }

    return card;
  }

  function renderGrid() {
    var frag = document.createDocumentFragment();
    FRAMES.forEach(function (f, i) { frag.appendChild(buildCard(f, i)); });
    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  /* 新图片插到最前面，跟数据数组的顺序保持一致 */
  function prependCard(f) {
    var card = buildCard(f, 0);
    grid.insertBefore(card, grid.firstChild);
    if (revealIO) { revealIO.observe(card); }
    else { card.classList.add('is-in'); }
  }

  function buildFilters() {
    filters.innerHTML = '';

    TAGS.forEach(function (tag, i) {
      var count = tag === '全部'
        ? FRAMES.length
        : FRAMES.filter(function (f) { return f.tags.indexOf(tag) >= 0; }).length;

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.tag = tag;
      chip.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      chip.innerHTML = tag + ' <span class="chip__count">' + pad(count) + '</span>';
      chip.addEventListener('click', function () { applyFilter(tag); });
      filters.appendChild(chip);
    });

    // 上传入口：跟在一排筛选后面，只用一个加号，不占文字
    addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'addBtn';
    addBtn.className = 'chip chip--add';
    addBtn.title = '上传本地图片';
    addBtn.setAttribute('aria-label', '上传本地图片');
    addBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    addBtn.addEventListener('click', function () { fileInput.click(); });
    filters.appendChild(addBtn);
  }

  function applyFilter(tag) {
    currentTag = tag;
    Array.prototype.forEach.call(filters.children, function (chip) {
      if (!chip.dataset.tag) return;      // 上传按钮不参与筛选状态
      chip.setAttribute('aria-pressed', chip.dataset.tag === tag ? 'true' : 'false');
    });

    var shown = 0;
    Array.prototype.forEach.call(grid.children, function (card) {
      var hit = tag === '全部' || card.dataset.tags.split(',').indexOf(tag) >= 0;
      card.classList.toggle('is-hidden', !hit);
      if (hit) {
        shown++;
        card.classList.add('is-in');     // 被筛出来的卡片立即可见
      }
    });
    empty.hidden = shown > 0;
  }

  /* 供灯箱使用：当前筛选下真正可见的画面 */
  function visibleFrames() {
    return FRAMES.filter(function (f) {
      return currentTag === '全部' || f.tags.indexOf(currentTag) >= 0;
    });
  }

  function paintStats() {
    $('#statCount').textContent = pad(FRAMES.length);
    $('#statHero').textContent = pad(HERO.length);
  }

  /* ======================================================================
     三、灯箱
     ====================================================================== */
  var lb = $('#lightbox');
  var lbImg = $('#lbImg');
  var lbTitle = $('#lbTitle');
  var lbLatin = $('#lbLatin');
  var lbMeta = $('#lbMeta');
  var lastFocus = null;
  var lbList = [];
  var lbPos = 0;

  function paintLightbox() {
    var f = lbList[lbPos];
    if (!f) return;
    lbImg.src = imgURL(f, 'view');
    lbImg.alt = (f.title ? f.title + '：' : '') + kindOf(f);
    lbTitle.textContent = f.title || '—';
    lbLatin.textContent = f.title ? (f.en || '') : '';
    lbMeta.textContent = pad(lbPos + 1) + ' / ' + pad(lbList.length) +
                         (f.date ? ' · ' + f.date : '') + ' · ' + f.tags.join(' · ');
  }

  function openLightbox(frame) {
    lbList = visibleFrames();
    lbPos = -1;
    for (var i = 0; i < lbList.length; i++) {
      if (lbList[i].id === frame.id) { lbPos = i; break; }
    }
    if (lbPos < 0) { lbList = [frame]; lbPos = 0; }

    paintLightbox();
    lastFocus = document.activeElement;
    lb.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    $('#lbClose').focus();
  }

  function closeLightbox() {
    lb.classList.remove('is-open');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
  }

  function moveLightbox(dir) {
    lbPos = mod(lbPos + dir, lbList.length);
    paintLightbox();
  }

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', function () { moveLightbox(-1); });
  $('#lbNext').addEventListener('click', function () { moveLightbox(1); });
  lb.addEventListener('click', function (e) { if (e.target === lb) { closeLightbox(); } });

  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') { closeLightbox(); }
    else if (e.key === 'ArrowLeft') { moveLightbox(-1); }
    else if (e.key === 'ArrowRight') { moveLightbox(1); }
    else if (e.key === 'Tab') {
      // 简易焦点环：只在灯箱的三个按钮之间循环
      var stops = [$('#lbClose'), $('#lbPrev'), $('#lbNext')];
      var idx = stops.indexOf(document.activeElement);
      e.preventDefault();
      var next = e.shiftKey ? mod(idx - 1, stops.length) : mod(idx + 1, stops.length);
      stops[next].focus();
    }
  });

  /* ======================================================================
     四、上传本机图片
     流程：读文件 → canvas 缩放并编码为 WebP → 统计色调打标签 → 写库 → 插入网格
     色调统计刻意复刻构建内置素材时用的那套阈值，两边的标签才可比。
     ====================================================================== */
  var fileInput = $('#fileInput');
  var dropzone = $('#dropzone');
  var toastEl = $('#toast');

  var MAX_EDGE = 1440;             // 处理后长边上限
  var MAX_CUSTOM = 60;             // 最多留存张数，避免拖垮浏览器
  var CUSTOM_TITLE = '';           // 自传图片暂无题名

  /* --- 小提示条 --- */
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2600);
  }

  /* --- 色调统计：与构建脚本同一套算法与阈值 ---
     rgb → hsv；v 取明度均值，s 取饱和度均值；
     色相 <90° 或 >300° 记暖，150°~300° 记冷（饱和度 >0.10 的像素才计入） */
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d !== 0) {
      if (max === r) { h = ((g - b) / d) % 6; }
      else if (max === g) { h = (b - r) / d + 2; }
      else { h = (r - g) / d + 4; }
      h *= 60;
      if (h < 0) { h += 360; }
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  function shadeOf(canvas) {
    var W = 160, H = 90;                       // 与构建脚本的采样尺寸一致
    var sample = document.createElement('canvas');
    sample.width = W;
    sample.height = H;
    var ctx = sample.getContext('2d');
    ctx.drawImage(canvas, 0, 0, W, H);

    var px = ctx.getImageData(0, 0, W, H).data;
    var n = W * H, val = 0, sat = 0, warm = 0, cool = 0;

    for (var i = 0; i < px.length; i += 4) {
      var hsv = rgb2hsv(px[i], px[i + 1], px[i + 2]);
      val += hsv[2];
      sat += hsv[1];
      if (hsv[1] > 0.10) {
        if (hsv[0] < 90 || hsv[0] > 300) { warm++; }
        else if (hsv[0] > 150 && hsv[0] < 300) { cool++; }
      }
    }
    return { v: val / n, s: sat / n, warm: warm / n, cool: cool / n };
  }

  function tagsOf(st) {
    var tags = [];
    if (st.v < 0.34) { tags.push('夜色'); }
    else if (st.v > 0.55) { tags.push('明亮'); }
    if (st.warm > 0.34) { tags.push('暖调'); }
    if (st.cool > 0.34) { tags.push('冷调'); }
    if (st.s < 0.18) { tags.push('低饱和'); }
    if (!tags.length) { tags.push('中间调'); }
    return tags;
  }

  /* --- 落盘：优先 IndexedDB，不可用时退化成"只在本次会话有效" --- */
  var DB_NAME = 'anime-stills';
  var DB_STORE = 'uploads';
  var dbFailed = false;
  var memFallback = {};
  var dbPromise = null;

  function openDB() {
    if (dbPromise) { return dbPromise; }
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('unsupported')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (err) { reject(err); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open failed')); };
      req.onblocked = function () { reject(new Error('blocked')); };
    });
    return dbPromise;
  }

  function store(mode, job) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(DB_STORE, mode);
        var req = job(t.objectStore(DB_STORE));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error || new Error('tx failed')); };
        t.onabort = function () { reject(t.error || new Error('tx aborted')); };
      });
    });
  }

  function saveRecord(rec) {
    memFallback[rec.id] = rec;
    return store('readwrite', function (s) { return s.put(rec); }).catch(function () {
      if (!dbFailed) { dbFailed = true; }
    });
  }

  function dropRecord(id) {
    delete memFallback[id];
    return store('readwrite', function (s) { return s.delete(id); }).catch(function () {});
  }

  function loadRecords() {
    return store('readonly', function (s) { return s.getAll(); })
      .catch(function () { dbFailed = true; return []; })
      .then(function (recs) {
        if (recs && recs.length) { return recs; }
        // 库不可用（例如某些浏览器在 file:// 下的限制）时，退回内存里的副本
        return Object.keys(memFallback).map(function (k) { return memFallback[k]; });
      });
  }

  /* --- 单张处理 --- */
  function prepare(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        var nw = img.naturalWidth || img.width;
        var nh = img.naturalHeight || img.height;
        var scale = Math.min(1, MAX_EDGE / Math.max(nw, nh));
        var w = Math.max(1, Math.round(nw * scale));
        var h = Math.max(1, Math.round(nh * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);

        var st = shadeOf(canvas);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('encode failed')); return; }
          resolve({
            blob: blob,
            tags: tagsOf(st),
            v: Math.round(st.v * 1000) / 1000,
            w: w,
            h: h
          });
        }, 'image/webp', 0.82);
      };

      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
  }

  function countCustom() {
    return FRAMES.filter(function (f) { return f.custom; }).length;
  }

  function mountCustom(rec) {
    var f = {
      id: rec.id,
      name: rec.id,
      custom: true,
      hero: false,
      title: CUSTOM_TITLE,
      en: '',
      tags: rec.tags || [],
      v: rec.v || 0,
      date: rec.date || '',
      src: URL.createObjectURL(rec.blob)
    };
    FRAMES.unshift(f);
    prependCard(f);
    return f;
  }

  function addOne(file) {
    return prepare(file).then(function (rec) {
      rec.id = 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      rec.date = stamp();
      rec.ts = Date.now();
      mountCustom(rec);
      return saveRecord(rec).then(function () { return true; });
    });
  }

  /* --- 批量入口：文件选择与拖拽共用 --- */
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /^image\//.test(f.type);
    });
    if (!files.length) { toast('这里只认图片文件'); return; }

    var room = MAX_CUSTOM - countCustom();
    if (room <= 0) { toast('最多留 ' + MAX_CUSTOM + ' 张，先移掉几张'); return; }
    var skipped = files.length - Math.min(files.length, room);
    files = files.slice(0, room);

    if (addBtn) { addBtn.classList.add('is-busy'); }

    var ok = 0, bad = 0;
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return addOne(file).then(
          function () { ok++; },
          function () { bad++; }
        );
      });
    });

    chain.then(function () {
      if (addBtn) { addBtn.classList.remove('is-busy'); }
      buildFilters();
      applyFilter(currentTag);
      paintStats();

      var msg = ok ? '已加入 ' + ok + ' 张' : '没能读进来';
      if (bad) { msg += '，' + bad + ' 张跳过'; }
      if (skipped) { msg += '，另有 ' + skipped + ' 张超出上限'; }
      if (dbFailed) { msg += '（本次有效）'; }
      toast(msg);
    });
  }

  function removeCustom(f) {
    var i = FRAMES.indexOf(f);
    if (i >= 0) { FRAMES.splice(i, 1); }

    var card = grid.querySelector('.card[data-id="' + f.id + '"]');
    if (card && card.parentNode) { card.parentNode.removeChild(card); }

    if (f.src) { URL.revokeObjectURL(f.src); }
    dropRecord(f.id);

    buildFilters();
    applyFilter(currentTag);
    paintStats();
    toast('已移除');
  }

  /* --- 入口一：筛选条上的加号 --- */
  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = '';          // 允许重复选同一个文件
  });

  /* --- 入口二：把图片拖进页面 --- */
  var dragDepth = 0;

  function carryingFiles(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) { return false; }
    return Array.prototype.indexOf.call(dt.types, 'Files') >= 0;
  }

  window.addEventListener('dragenter', function (e) {
    if (!carryingFiles(e)) { return; }
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('is-on');
  });

  window.addEventListener('dragover', function (e) {
    if (!carryingFiles(e)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function () {
    if (dragDepth === 0) { return; }
    dragDepth--;
    if (dragDepth === 0) { dropzone.classList.remove('is-on'); }
  });

  window.addEventListener('dragend', function () {
    dragDepth = 0;
    dropzone.classList.remove('is-on');
  });

  window.addEventListener('drop', function (e) {
    if (!carryingFiles(e)) { return; }
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-on');
    handleFiles(e.dataTransfer.files);
  });

  /* ======================================================================
     五、入场编排与导航状态
     ====================================================================== */
  var header = $('#siteHeader');

  function onScroll() {
    header.classList.toggle('is-stuck', window.scrollY > 12);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function observeReveals() {
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
        el.classList.add('is-in');
      });
      return;
    }
    revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });

    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
      revealIO.observe(el);
    });
  }

  /* 取回上次留下的自传图片，按上传先后还原到最前面 */
  function restoreCustom() {
    return loadRecords().then(function (recs) {
      if (!recs || !recs.length) { return; }
      var list = recs.filter(function (r) { return r && r.blob; })
                     .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      if (!list.length) { return; }
      list.forEach(function (rec) { mountCustom(rec); });
      buildFilters();
      applyFilter(currentTag);
      paintStats();
    });
  }

  /* --- 启动 --- */
  function init() {
    renderGrid();
    buildFilters();
    layout();
    observeReveals();
    paintStats();

    $('#year').textContent = new Date().getFullYear();

    if (!REDUCE) { requestAnimationFrame(loop); }

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 140);
    });

    restoreCustom();
  }

  init();
})();
