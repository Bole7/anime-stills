/* ==========================================================================
   main.js — 交互层
   1. 环幕轮播（3D 圆柱：自动旋转 / 拖拽惯性 / 吸附 / 键盘 / 触点）
   2. 目录网格（渲染 + 色调筛选）
   3. 灯箱（放大查看 + 键盘导航 + 焦点回收）
   4. 入场编排与导航状态
   说明：全部逻辑用普通脚本封装在 IIFE 内，双击本地文件即可运行，
        不依赖任何构建工具与模块加载（避免 file:// 下的跨域限制）。
   ========================================================================== */
(function () {
  'use strict';

  var DATA = window.ANIME_FRAMES;
  if (!DATA || !DATA.frames) return;

  var FRAMES = DATA.frames;
  var HERO = FRAMES.filter(function (f) { return f.hero; });
  var TAGS = ['全部', '夜色', '明亮', '暖调', '冷调', '低饱和'];

  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $ = function (sel) { return document.querySelector(sel); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var mod = function (n, m) { return ((n % m) + m) % m; };

  /* ======================================================================
     一、环幕轮播
     ====================================================================== */
  var ring = $('#ring');
  var carousel = $('#carousel');
  var hudIndex = $('#hudIndex');
  var hudTitle = $('#hudTitle');
  var hudLatin = $('#hudLatin');
  var hudTags = $('#hudTags');
  var hudTicks = $('#hudTicks');

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
  var tickEls = [];

  /* --- 构建面板与速览刻度 --- */
  HERO.forEach(function (f, i) {
    var el = document.createElement('article');
    el.className = 'panel';
    el.style.setProperty('--i', i);
    el.innerHTML =
      '<div class="panel__frame">' +
        '<img class="panel__img" draggable="false" src="assets/hero/' + f.name + '.webp" ' +
             'alt="' + f.title + '：动画截图，色调' + f.tags.join('、') + '">' +
        '<span class="panel__veil"></span>' +
        '<span class="panel__tag">FRAME ' + pad(f.id) + ' · ' + f.date + '</span>' +
      '</div>';
    el.addEventListener('click', function () {
      if (moved) return;                       // 拖拽后的误触不算点击
      if (i === activeIndex) { openLightbox(f); }
      else { goToIndex(i); }
    });
    ring.appendChild(el);
    panelEls.push(el);

    var tick = document.createElement('button');
    tick.type = 'button';
    tick.setAttribute('role', 'tab');
    tick.setAttribute('aria-label', '第 ' + (i + 1) + ' 帧：' + f.title);
    tick.addEventListener('click', function () { goToIndex(i); });
    hudTicks.appendChild(tick);
    tickEls.push(tick);
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

    var shownW = vw * (vw < 700 ? 0.84 : 0.70);
    shownW = Math.min(shownW, vh * 0.92);
    shownW = Math.max(shownW, 220);

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

  /* 松手 / 暂停自动时吸附到最近的一帧 */
  function snap() {
    var target = Math.round(angle / STEP) * STEP;
    if (Math.abs(target - angle) > 0.1) { angle += (target - angle) * 0.14; }
    else { angle = target; }
  }

  function animateTo(target) {
    if (REDUCE) { angle = target; return; }
    tween = { from: angle, to: target, start: performance.now(), dur: 620 };
  }

  /* 按方向翻一帧（← → 与按钮共用） */
  function stepBy(dir) {
    animateTo(angle - dir * STEP);
  }

  /* 直接跳到某一帧（刻度点击 / 点击非当前面板） */
  function goToIndex(i) {
    var base = -i * STEP;
    var k = Math.round((angle - base) / 360);
    animateTo(base + k * 360);
  }

  /* --- 渲染：只在当前帧变化时才写 DOM --- */
  function render() {
    ring.style.transform = 'rotateY(' + angle.toFixed(3) + 'deg)';
    var idx = mod(Math.round(-angle / STEP), HERO.length);
    if (idx !== activeIndex) {
      activeIndex = idx;
      paintHUD();
    }
  }

  function paintHUD() {
    var f = HERO[activeIndex];
    panelEls.forEach(function (el, i) { el.classList.toggle('is-active', i === activeIndex); });
    tickEls.forEach(function (el, i) {
      el.setAttribute('aria-current', i === activeIndex ? 'true' : 'false');
    });
    hudIndex.textContent = 'FRAME ' + pad(f.id);
    hudTitle.textContent = f.title;
    hudLatin.textContent = f.en;
    hudTags.innerHTML = f.tags.map(function (t) { return '<span>' + t + '</span>'; }).join('');
  }

  function setAutoUI() {
    var btn = $('#btnAuto');
    btn.setAttribute('aria-pressed', auto ? 'true' : 'false');
    btn.setAttribute('aria-label', auto ? '暂停自动旋转' : '开始自动旋转');
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
    setAutoUI();
  }, { passive: false });

  /* --- 键盘：← → 翻帧，空格切换自动旋转 --- */
  document.addEventListener('keydown', function (e) {
    if (lb.classList.contains('is-open')) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key === 'ArrowLeft') { auto = false; setAutoUI(); stepBy(-1); }
    else if (e.key === 'ArrowRight') { auto = false; setAutoUI(); stepBy(1); }
    else if (e.key === ' ' && document.activeElement === document.body) {
      e.preventDefault();
      auto = !auto; setAutoUI();
    }
  });

  $('#btnPrev').addEventListener('click', function () { auto = false; setAutoUI(); stepBy(-1); });
  $('#btnNext').addEventListener('click', function () { auto = false; setAutoUI(); stepBy(1); });
  $('#btnAuto').addEventListener('click', function () { auto = !auto; setAutoUI(); });

  /* ======================================================================
     二、目录网格
     ====================================================================== */
  var grid = $('#grid');
  var filters = $('#filters');
  var empty = $('#empty');
  var currentTag = '全部';

  function frameLabel(f) { return f.title || ('FRAME ' + pad(f.id)); }

  function renderGrid() {
    var frag = document.createDocumentFragment();

    FRAMES.forEach(function (f, i) {
      var card = document.createElement('figure');
      card.className = 'card reveal';
      card.dataset.id = String(f.id);
      card.dataset.tags = f.tags.join(',');
      // 同屏卡片错峰淡入，间隔 60ms 一档
      card.style.transitionDelay = (i % 4) * 60 + 'ms';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card__frame';
      btn.setAttribute('aria-label', '放大查看 ' + frameLabel(f));

      var img = document.createElement('img');
      img.className = 'card__img';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = 'assets/grid/' + f.name + '.webp';
      img.alt = f.title
        ? f.title + '：动画截图，色调' + f.tags.join('、')
        : '动画截图第 ' + f.id + ' 帧，色调' + f.tags.join('、');

      var hover = document.createElement('span');
      hover.className = 'card__hover';
      hover.textContent = frameLabel(f);

      btn.appendChild(img);
      btn.appendChild(hover);
      btn.addEventListener('click', function () { openLightbox(f); });

      var cap = document.createElement('figcaption');
      cap.className = 'card__meta';
      var name = document.createElement('span');
      name.className = 'card__name';
      name.textContent = frameLabel(f);
      var tags = document.createElement('span');
      tags.textContent = f.tags.join(' · ');
      cap.appendChild(name);
      cap.appendChild(tags);

      card.appendChild(btn);
      card.appendChild(cap);
      frag.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(frag);
  }

  function buildFilters() {
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
  }

  function applyFilter(tag) {
    currentTag = tag;
    Array.prototype.forEach.call(filters.children, function (chip) {
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

  /* 供灯箱使用：当前筛选下真正可见的帧 */
  function visibleFrames() {
    return FRAMES.filter(function (f) {
      return currentTag === '全部' || f.tags.indexOf(currentTag) >= 0;
    });
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
    lbImg.src = 'assets/view/' + f.name + '.webp';
    lbImg.alt = (f.title ? f.title + '：' : '') + '动画截图第 ' + f.id + ' 帧';
    lbTitle.textContent = frameLabel(f);
    lbLatin.textContent = f.en || '';
    lbMeta.textContent = 'FRAME ' + pad(f.id) + ' / ' + pad(lbList.length) + ' · ' + f.date + ' · ' + f.tags.join(' · ');
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
     四、入场编排与导航状态
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
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });

    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
      io.observe(el);
    });
  }

  /* --- 启动 --- */
  function init() {
    renderGrid();
    buildFilters();
    layout();
    paintHUD();
    setAutoUI();
    observeReveals();

    $('#totalCount').textContent = FRAMES.length;
    $('#statCount').textContent = pad(FRAMES.length);
    $('#statHero').textContent = pad(HERO.length);
    $('#year').textContent = new Date().getFullYear();

    if (REDUCE) { auto = false; setAutoUI(); }
    else { requestAnimationFrame(loop); }

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 140);
    });

    // 页面载入后让第一帧先亮起来
    panelEls[0].classList.add('is-active');
  }

  init();
})();
