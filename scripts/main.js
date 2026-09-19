/* ==========================================================================
   main.js — 交互层
   一、分类体系（按番剧名归类：新建 / 改名 / 删除 / 拖拽转移）
   二、环幕轮播（3D 圆柱：自转 / 拖拽惯性 / 吸附 / 键盘 / 触点，画面可自选）
   三、目录网格（分类筛选 + 自传图片的插入与移除）
   四、归类浮层（触屏与键盘的替代路径）
   五、灯箱（放大查看 + 键盘导航 + 焦点回收）
   六、上传（本机图片 → canvas 缩放编码 → 色调统计 → IndexedDB 落盘）
   七、入场编排与导航状态
   说明：全部逻辑用普通脚本封装在 IIFE 内，双击本地文件即可运行，
        不依赖任何构建工具与模块加载（避免 file:// 下的跨域限制）。
   ========================================================================== */
(function () {
  'use strict';

  var DATA = window.ANIME_FRAMES;
  if (!DATA || !DATA.frames) return;

  var FRAMES = DATA.frames;        // 内置素材，自传的图片会插到最前面

  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 触屏上 HTML5 拖拽本来就不好使（长按还会跟系统手势打架），
  // 这类设备干脆不开拖拽，走卡片上的"移动到"浮层
  var NO_HOVER = window.matchMedia('(hover: none)').matches ||
                 window.matchMedia('(pointer: coarse)').matches;

  var $ = function (sel) { return document.querySelector(sel); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var mod = function (n, m) { return ((n % m) + m) % m; };

  var ALL = 'all';                 // 「全部」不是分类，是一个聚合视图
  var UNSORTED = '__unsorted';     // 兜底分类：内置素材与新建分类前的自传图片都在这

  function imgURL(f, size) {
    return f.custom ? f.src : 'assets/' + size + '/' + f.name + '.webp';
  }
  function kindOf(f) { return f.custom ? '自传图片' : '动画截图'; }

  var ICON = {
    ring: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4.4v5h-5"/>',
    move: '<path d="M4 7h6M4 12h5M4 17h6"/><path d="M14 12h7m-3-3 3 3-3 3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  function icon(paths) {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
           'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           paths + '</svg>';
  }
  function iconBtn(label, paths) {
    var b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon(paths);
    return b;
  }

  /* ======================================================================
     一、分类体系
     分类就是用户自己写的番剧名。内置素材默认落在「未分类」，用户可以
     新建分类把画面拖过去，也可以给分类改名或整条删掉。
     三份状态都存 localStorage：分类表 / 归属覆盖 / 环幕名单。
     自传图片的归属与环幕状态再往库里补写一份，免得清了浏览器数据就丢。
     ====================================================================== */
  var LS_SERIES = 'anime-stills:series';
  var LS_ASSIGN = 'anime-stills:assign';
  var LS_HERO = 'anime-stills:hero';

  function readLS(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      var val = raw ? JSON.parse(raw) : null;
      return (val === null || typeof val !== 'object') ? fallback : val;
    } catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { window.localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { /* 隐私模式等场景写不进去，本次会话内仍然可用 */ }
  }

  var seriesList = readLS(LS_SERIES, []);
  var assignMap = readLS(LS_ASSIGN, {});
  var heroMap = readLS(LS_HERO, {});
  if (!Array.isArray(seriesList)) { seriesList = []; }
  seriesList = seriesList.filter(function (s) { return s && s.id && s.name; });

  function newSeriesId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  function findSeries(id) {
    for (var i = 0; i < seriesList.length; i++) {
      if (seriesList[i].id === id) { return seriesList[i]; }
    }
    return null;
  }
  function liveSeries(id) { return id === UNSORTED || !!findSeries(id); }

  function seriesOf(f) {
    var id = assignMap[String(f.id)];
    return (id && liveSeries(id)) ? id : UNSORTED;
  }
  function seriesName(id) {
    if (id === ALL) { return '全部'; }
    if (id === UNSORTED) { return '未分类'; }
    var s = findSeries(id);
    return s ? s.name : '未分类';
  }
  function countIn(id) {
    if (id === ALL) { return FRAMES.length; }
    return FRAMES.filter(function (f) { return seriesOf(f) === id; }).length;
  }

  function createSeries(name) {
    var s = { id: newSeriesId(), name: name };
    seriesList.push(s);
    writeLS(LS_SERIES, seriesList);
    return s;
  }
  function renameSeries(id, name) {
    var s = findSeries(id);
    if (!s) { return; }
    s.name = name;
    writeLS(LS_SERIES, seriesList);
  }
  /* 删掉分类，底下的画面退回「未分类」——图片本身一张不丢 */
  function dropSeries(id) {
    // 先记下谁在这个分类里，等下 assignMap 清完就查不出来了
    var members = FRAMES.filter(function (f) { return seriesOf(f) === id; });

    seriesList = seriesList.filter(function (s) { return s.id !== id; });
    writeLS(LS_SERIES, seriesList);

    Object.keys(assignMap).forEach(function (k) {
      if (assignMap[k] === id) { delete assignMap[k]; }
    });
    writeLS(LS_ASSIGN, assignMap);

    // 只有被删这个分类下的自传图片需要改写记录，别的不许动
    members.forEach(function (f) {
      if (f.custom) { patchRecord(f.id, { series: UNSORTED }); }
    });
    return members.length;
  }

  function moveFrame(f, id) {
    if (!liveSeries(id)) { return false; }
    if (seriesOf(f) === id) {
      toast('已经归在「' + seriesName(id) + '」里了');
      return false;
    }
    assignMap[String(f.id)] = id;
    writeLS(LS_ASSIGN, assignMap);
    if (f.custom) { patchRecord(f.id, { series: id }); }

    var card = grid.querySelector('.card[data-id="' + f.id + '"]');
    if (card) { card.dataset.series = id; }

    refreshFilters();
    toast('已移到「' + seriesName(id) + '」');
    return true;
  }

  /* --- 环幕名单：内置的 8 张是默认值，用户改动会覆盖 --- */
  var HERO_MIN = 3;                // 少于三张就不成一个环了

  function inHero(f) {
    var o = heroMap[String(f.id)];
    return o === undefined ? !!f.hero : !!o;
  }
  function heroFrames() { return FRAMES.filter(inHero); }

  function setHero(f, on) {
    if (!on && heroFrames().length <= HERO_MIN) {
      toast('环幕至少留 ' + HERO_MIN + ' 张');
      return false;
    }
    heroMap[String(f.id)] = on;
    writeLS(LS_HERO, heroMap);
    if (f.custom) { patchRecord(f.id, { hero: on }); }
    buildRing();
    paintStats();
    return true;
  }

  /* ======================================================================
     二、环幕轮播
     ====================================================================== */
  var ring = $('#ring');
  var carousel = $('#carousel');

  var HERO = [];                   // 当前环幕上的画面，随用户增删而变
  var STEP = 45;                   // 相邻面板夹角 = 360 / 张数
  var AUTO_SPEED = 6;              // 自动旋转速度：度 / 秒
  var angle = 0;
  var velocity = 0;
  var dragging = false;
  var moved = false;               // 本次指针交互是否发生了位移（用于区分点击与拖拽）
  var auto = !REDUCE;
  var activeIndex = 0;
  var tween = null;
  var panelEls = [];

  var PERSPECTIVE = 2000;          // 与 components.css 里的 perspective 保持一致

  /* 重建环幕：面板张数变了，圆柱半径与夹角都要跟着变 */
  function buildRing() {
    HERO = heroFrames();
    STEP = 360 / Math.max(HERO.length, 1);

    ring.innerHTML = '';
    panelEls = [];
    angle = 0;
    velocity = 0;
    tween = null;
    activeIndex = 0;

    HERO.forEach(function (f, i) {
      var el = document.createElement('article');
      el.className = 'panel' + (i === 0 ? ' is-active' : '');
      el.style.setProperty('--i', i);

      var frame = document.createElement('div');
      frame.className = 'panel__frame';

      var img = document.createElement('img');
      img.className = 'panel__img';
      img.draggable = false;
      img.src = imgURL(f, 'hero');
      img.alt = (f.title ? f.title + '：' : '') + kindOf(f);
      frame.appendChild(img);

      var veil = document.createElement('span');
      veil.className = 'panel__veil';
      frame.appendChild(veil);

      el.appendChild(frame);
      el.addEventListener('click', function () {
        if (moved) { return; }                    // 拖拽后的误触不算点击
        if (i === activeIndex) { openLightbox(f); }
        else { goToIndex(i); }
      });
      ring.appendChild(el);
      panelEls.push(el);
    });

    layout();
  }

  /* --- 响应式尺寸 ---
     透视会把最前方那张放大 P/(P-R) 倍，所以先定"屏幕上想看到多大"，
     再反推面板实宽，这样环幕既够大、两侧又能留出环绕的余韵。 */
  function layout() {
    var rect = carousel.getBoundingClientRect();
    var vw = rect.width || window.innerWidth;
    var vh = window.innerHeight;
    var cot = 1 / Math.tan(Math.PI / Math.max(HERO.length, 3));   // 半径系数：R = (w/2)·cot

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
      if (t >= 1) { tween = null; }
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
  function stepBy(dir) { animateTo(angle - dir * STEP); }

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
    if (e.button !== undefined && e.button !== 0) { return; }
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
    if (!dragging) { return; }
    var dx = e.clientX - startX;
    if (Math.abs(dx) > 4) { moved = true; }
    angle = startAngle + dx * 0.22;               // 0.22 度 / 像素
    velocity = (e.clientX - lastX) * 0.22;
    lastX = e.clientX;
  });

  function endDrag() {
    if (!dragging) { return; }
    dragging = false;
    carousel.classList.remove('is-dragging');
    if (Math.abs(velocity) < 0.4) { velocity = 0; }
  }
  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointercancel', endDrag);
  carousel.addEventListener('pointerleave', endDrag);

  /* --- 触控板横向滑动：只接管横向，纵向滚动留给页面 --- */
  window.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) { return; }
    var rect = carousel.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) { return; }
    e.preventDefault();
    angle += e.deltaX * 0.28;
    auto = false;
  }, { passive: false });

  /* --- 键盘：← → 翻一张，空格切自动旋转 --- */
  document.addEventListener('keydown', function (e) {
    if (lb.classList.contains('is-open')) { return; }
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') { return; }

    if (e.key === 'Escape') { closeMover(); }
    else if (e.key === 'ArrowLeft') { auto = false; stepBy(-1); }
    else if (e.key === 'ArrowRight') { auto = false; stepBy(1); }
    else if (e.key === ' ' && document.activeElement === document.body) {
      e.preventDefault();
      auto = !auto;
    }
  });

  /* ======================================================================
     三、目录网格
     ====================================================================== */
  var grid = $('#grid');
  var filters = $('#filters');
  var empty = $('#empty');
  var currentSeries = ALL;
  var revealIO = null;
  var addBtn = null;
  var newBtn = null;
  var dragFrame = null;            // 正在被拖动的画面

  function buildCard(f, i) {
    var card = document.createElement('figure');
    card.className = 'card reveal';
    card.dataset.id = String(f.id);
    card.dataset.series = seriesOf(f);
    card.dataset.custom = f.custom ? '1' : '0';
    card.draggable = !NO_HOVER;
    // 同屏卡片错峰淡入，间隔 60ms 一档
    card.style.transitionDelay = (i % 4) * 60 + 'ms';

    var view = document.createElement('button');
    view.type = 'button';
    view.className = 'card__frame';
    view.setAttribute('aria-label', '放大查看' + (f.title ? '：' + f.title : '这张图片'));

    var img = document.createElement('img');
    img.className = 'card__img';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;                        // 拖拽交给整张卡片
    img.src = imgURL(f, 'grid');
    img.alt = (f.title ? f.title + '：' : '') + kindOf(f) + '，' + seriesName(seriesOf(f));
    view.appendChild(img);

    // 有题名的才在悬停时浮现题名条，没有的就保持干净
    if (f.title) {
      var hover = document.createElement('span');
      hover.className = 'card__hover';
      hover.textContent = f.title;
      view.appendChild(hover);
    }

    view.addEventListener('click', function () { openLightbox(f); });
    card.appendChild(view);

    /* --- 右上角操作条 ---
       桌面：悬停浮出三个（归类 / 环幕 / 移除）
       触屏：只留一个「归类」，其余动作收进浮层——不然三个按钮常驻会把画面盖住 */
    var tools = document.createElement('div');
    tools.className = 'card__tools';

    // 归类
    var tMove = iconBtn('移动到分类', ICON.move);
    tMove.addEventListener('click', function (e) {
      e.stopPropagation();
      openMover(f, tMove);
    });
    tools.appendChild(tMove);

    // 环幕开关：在环幕上的那张图标点亮成朱红
    if (!NO_HOVER) {
      var tRing = iconBtn('放到环幕上', ICON.ring);
      function paintRingBtn() {
        var on = inHero(f);
        tRing.classList.toggle('is-on', on);
        tRing.title = on ? '从环幕移出' : '放到环幕上';
        tRing.setAttribute('aria-label', tRing.title);
      }
      paintRingBtn();
      tRing.addEventListener('click', function (e) {
        e.stopPropagation();
        var on = !inHero(f);
        if (setHero(f, on)) {
          paintRingBtn();
          toast(on ? '已放到环幕上' : '已从环幕移出');
        }
      });
      tools.appendChild(tRing);
    }

    // 自传的才给移除
    if (f.custom && !NO_HOVER) {
      var tDel = iconBtn('移除这张图', ICON.x);
      tDel.addEventListener('click', function (e) {
        e.stopPropagation();
        removeCustom(f);
      });
      tools.appendChild(tDel);
    }
    card.appendChild(tools);

    /* --- 拖拽：把这张图拖到某个分类上 --- */
    card.addEventListener('dragstart', function (e) {
      dragFrame = f;
      card.classList.add('is-dragging');
      if (!e.dataTransfer) { return; }
      e.dataTransfer.effectAllowed = 'move';
      // 自定义类型用来跟"把本机图片拖进页面"区分开
      try { e.dataTransfer.setData('application/x-anime-frame', String(f.id)); } catch (err) {}
      try { e.dataTransfer.setData('text/plain', String(f.id)); } catch (err) {}
    });
    card.addEventListener('dragend', function () {
      dragFrame = null;
      card.classList.remove('is-dragging');
      clearDropHints();
    });

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

  /* --- 筛选条：全部 / 各番剧分类 / 未分类 / ＋ --- */
  function buildFilters() {
    filters.innerHTML = '';

    var items = [{ id: ALL, name: '全部' }];
    seriesList.forEach(function (s) { items.push({ id: s.id, name: s.name, own: true }); });
    items.push({ id: UNSORTED, name: '未分类' });

    items.forEach(function (it) {
      var slot = document.createElement('span');
      slot.className = 'chip-slot';

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (it.own ? ' chip--own' : '');
      chip.dataset.series = it.id;
      chip.setAttribute('aria-pressed', it.id === currentSeries ? 'true' : 'false');

      var label = document.createElement('span');
      label.textContent = it.name;
      chip.appendChild(label);

      var count = document.createElement('span');
      count.className = 'chip__count';
      count.textContent = pad(countIn(it.id));
      chip.appendChild(count);

      chip.addEventListener('click', function () { applyFilter(it.id); });

      // 「全部」是聚合视图，不是分类，所以不接受拖放
      if (it.id !== ALL) {
        chip.addEventListener('dragover', function (e) {
          if (!dragFrame) { return; }
          e.preventDefault();
          if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
          chip.classList.add('is-drop');
        });
        chip.addEventListener('dragleave', function () { chip.classList.remove('is-drop'); });
        chip.addEventListener('drop', function (e) {
          chip.classList.remove('is-drop');
          if (!dragFrame) { return; }
          e.preventDefault();
          e.stopPropagation();
          moveFrame(dragFrame, it.id);
        });
      }

      slot.appendChild(chip);

      if (it.own) {
        chip.title = it.name + (NO_HOVER ? '（长按改名）' : '（双击改名）');
        chip.addEventListener('dblclick', function () { openRename(chip, it); });

        // 触屏上没有双击，长按同样能改名
        var pressTimer = null;
        chip.addEventListener('touchstart', function () {
          pressTimer = setTimeout(function () { openRename(chip, it); }, 520);
        }, { passive: true });
        ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) {
          chip.addEventListener(ev, function () { clearTimeout(pressTimer); }, { passive: true });
        });

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'chip__del';
        del.title = '删除分类';
        del.setAttribute('aria-label', '删除分类「' + it.name + '」');
        del.innerHTML = icon(ICON.x);
        // 别让按下 × 的时候先把改名输入框给 blur 掉
        del.addEventListener('mousedown', function (e) { e.preventDefault(); });
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          var n = dropSeries(it.id);
          if (currentSeries === it.id) { currentSeries = ALL; }
          refreshFilters();
          toast('已删除「' + it.name + '」' + (n ? '，' + n + ' 张回到未分类' : ''));
        });
        slot.appendChild(del);
      }

      filters.appendChild(slot);
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

    // 新建分类：这个必须带字，否则没人猜得到它是干什么的
    newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.id = 'newBtn';
    newBtn.className = 'chip chip--add chip--new';
    newBtn.title = '新建分类';
    newBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
      '<span>分类</span>';
    newBtn.addEventListener('click', openNewSeries);
    filters.appendChild(newBtn);
  }

  /* 就地变成输入框新建分类——不弹系统对话框 */
  function openNewSeries() {
    if (filters.querySelector('.chip-input')) { return; }
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'chip-input';
    input.placeholder = '番剧名';
    input.maxLength = 24;
    input.setAttribute('aria-label', '新建分类');
    filters.insertBefore(input, newBtn);
    newBtn.hidden = true;
    input.focus();

    var closed = false;
    function done(commit) {
      if (closed) { return; }
      closed = true;
      var v = input.value.trim();
      input.parentNode.removeChild(input);
      newBtn.hidden = false;
      if (commit && v) {
        var s = createSeries(v);
        currentSeries = s.id;
        refreshFilters();
        toast('已新建「' + s.name + '」，把画面拖进来就行');
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { done(true); }
      else if (e.key === 'Escape') { done(false); }
    });
    input.addEventListener('blur', function () { done(true); });
  }

  /* 就地改名 */
  function openRename(chip, it) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'chip-input';
    input.value = it.name;
    input.maxLength = 24;
    input.setAttribute('aria-label', '重命名分类');
    chip.parentNode.replaceChild(input, chip);
    input.focus();
    input.select();

    var closed = false;
    function done(commit) {
      if (closed) { return; }
      closed = true;
      var v = input.value.trim();
      if (commit && v && v !== it.name) {
        renameSeries(it.id, v);
        toast('已改名为「' + v + '」');
        refreshFilters();
        return;
      }
      // 名字没动就原样换回去，省得整条筛选条白重建一次
      if (input.parentNode) { input.parentNode.replaceChild(chip, input); }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { done(true); }
      else if (e.key === 'Escape') { done(false); }
    });
    input.addEventListener('blur', function () { done(true); });
  }

  function clearDropHints() {
    Array.prototype.forEach.call(filters.querySelectorAll('.is-drop'), function (el) {
      el.classList.remove('is-drop');
    });
  }

  function applyFilter(id) {
    if (id !== ALL && !liveSeries(id)) { id = ALL; }
    currentSeries = id;

    Array.prototype.forEach.call(filters.querySelectorAll('.chip'), function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.series === id ? 'true' : 'false');
    });

    var shown = 0;
    Array.prototype.forEach.call(grid.children, function (card) {
      var hit = id === ALL || card.dataset.series === id;
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
      return currentSeries === ALL || seriesOf(f) === currentSeries;
    });
  }

  function paintStats() {
    $('#statCount').textContent = pad(FRAMES.length);
    $('#statHero').textContent = pad(heroFrames().length);
    $('#statSeries').textContent = pad(seriesList.length);
  }

  /* 分类结构动了之后统一刷新 */
  function refreshFilters() {
    buildFilters();
    applyFilter(currentSeries);
    paintStats();
    closeMover();
  }

  /* ======================================================================
     四、归类浮层
     拖拽是最快的路径，但触屏上没有 hover、也不好精确落到某个 chip 上，
     所以每条画面再给一个明确的文字入口，两条路都落到 moveFrame。
     ====================================================================== */
  var mover = $('#mover');
  var moverList = $('#moverList');
  var moverNew = $('#moverNew');
  var moverFrame = null;

  function placeMover(anchor) {
    var r = anchor.getBoundingClientRect();
    var mw = mover.offsetWidth || 212;
    var mh = mover.offsetHeight || 200;

    // 锚点量不到位置时（元素刚被隐藏之类）就摆在视口偏上居中，总之别跑到框外
    if (!r.width && !r.height) {
      mover.style.left = Math.max(8, Math.round((window.innerWidth - mw) / 2)) + 'px';
      mover.style.top = Math.round(Math.max(12, window.innerHeight * 0.26)) + 'px';
      return;
    }

    var left = r.right - mw;                       // 跟卡片的右边缘对齐
    if (left + mw > window.innerWidth - 8) { left = window.innerWidth - mw - 8; }
    if (left < 8) { left = 8; }

    var top = r.bottom + 8;
    if (top + mh > window.innerHeight - 8) { top = r.top - mh - 8; }
    if (top < 8) { top = 8; }

    mover.style.left = left + 'px';
    mover.style.top = top + 'px';
  }

  /* 触屏上卡片只留一个入口，环幕与移除这两个动作就落在浮层里 */
  function buildMoverActs(f) {
    var old = mover.querySelector('.mover__acts');
    if (old) { old.parentNode.removeChild(old); }
    if (!NO_HOVER) { return; }

    var acts = document.createElement('div');
    acts.className = 'mover__acts';

    var on = inHero(f);
    var aRing = document.createElement('button');
    aRing.type = 'button';
    aRing.className = 'mover__act';
    aRing.innerHTML = icon(ICON.ring) + '<span>' + (on ? '从环幕移出' : '放到环幕上') + '</span>';
    aRing.addEventListener('click', function () {
      if (setHero(f, !on)) {
        closeMover();
        toast(on ? '已从环幕移出' : '已放到环幕上');
      }
    });
    acts.appendChild(aRing);

    if (f.custom) {
      var aDel = document.createElement('button');
      aDel.type = 'button';
      aDel.className = 'mover__act is-danger';
      aDel.innerHTML = icon(ICON.x) + '<span>移除这张图</span>';
      aDel.addEventListener('click', function () {
        closeMover();
        removeCustom(f);
      });
      acts.appendChild(aDel);
    }

    mover.appendChild(acts);
  }

  function openMover(f, anchor) {
    moverFrame = f;
    moverList.innerHTML = '';

    var opts = [{ id: UNSORTED, name: '未分类' }].concat(
      seriesList.map(function (s) { return { id: s.id, name: s.name }; })
    );

    opts.forEach(function (o) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'mover__item' + (seriesOf(f) === o.id ? ' is-current' : '');

      item.appendChild(document.createTextNode(o.name));
      var c = document.createElement('span');
      c.textContent = pad(countIn(o.id));
      item.appendChild(c);

      item.addEventListener('click', function () {
        closeMover();
        moveFrame(f, o.id);
      });
      moverList.appendChild(item);
    });

    moverNew.value = '';
    mover.hidden = false;
    buildMoverActs(f);
    placeMover(anchor);
  }

  function closeMover() {
    if (mover.hidden) { return; }
    mover.hidden = true;
    moverFrame = null;
  }

  moverNew.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMover(); return; }
    if (e.key !== 'Enter' || !moverFrame) { return; }
    var v = moverNew.value.trim();
    if (!v) { return; }
    var f = moverFrame;
    var s = createSeries(v);
    closeMover();
    moveFrame(f, s.id);
  });

  // 点到浮层外面就收起来
  document.addEventListener('pointerdown', function (e) {
    if (mover.hidden) { return; }
    if (mover.contains(e.target)) { return; }
    if (e.target.closest && e.target.closest('.card__tools')) { return; }
    closeMover();
  }, true);

  window.addEventListener('scroll', closeMover, { passive: true });

  /* ======================================================================
     五、灯箱
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
    if (!f) { return; }
    lbImg.src = imgURL(f, 'view');
    lbImg.alt = (f.title ? f.title + '：' : '') + kindOf(f);
    lbTitle.textContent = f.title || '—';
    lbLatin.textContent = f.title ? (f.en || '') : '';
    lbMeta.textContent = pad(lbPos + 1) + ' / ' + pad(lbList.length) +
                         ' · ' + seriesName(seriesOf(f)) +
                         (f.date ? ' · ' + f.date : '');
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
    if (!lb.classList.contains('is-open')) { return; }
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
     六、上传本机图片
     流程：读文件 → canvas 缩放并编码为 WebP → 统计色调打标签 → 写库 → 插入网格
     色调统计刻意复刻构建内置素材时用的那套阈值，两边的标签才可比。
     ====================================================================== */
  var fileInput = $('#fileInput');
  var dropzone = $('#dropzone');
  var toastEl = $('#toast');

  var MAX_EDGE = 1440;             // 处理后长边上限
  var MAX_CUSTOM = 60;             // 最多留存张数，避免拖垮浏览器

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
      dbFailed = true;
    });
  }

  function dropRecord(id) {
    delete memFallback[id];
    return store('readwrite', function (s) { return s.delete(id); }).catch(function () {});
  }

  /* 就地补写一条记录的若干字段（改归属、改环幕状态时用） */
  function patchRecord(id, patch) {
    if (memFallback[id]) {
      Object.keys(patch).forEach(function (k) { memFallback[id][k] = patch[k]; });
    }
    return store('readwrite', function (s) {
      var req = s.get(id);
      req.onsuccess = function () {
        var rec = req.result;
        if (!rec) { return; }
        Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
        s.put(rec);
      };
      return req;
    }).catch(function () {});
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
          resolve({ blob: blob, tags: tagsOf(st), v: Math.round(st.v * 1000) / 1000, w: w, h: h });
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
      title: '',
      en: '',
      tags: rec.tags || [],
      v: rec.v || 0,
      date: rec.date || '',
      src: URL.createObjectURL(rec.blob)
    };
    FRAMES.unshift(f);

    /* 归属：记录里有就用它，否则跟随上传时所在的分类 ——
       在「电锯人」分类下上传的图，直接就进「电锯人」 */
    var target = (rec.series && liveSeries(rec.series)) ? rec.series
               : (currentSeries !== ALL ? currentSeries : UNSORTED);
    assignMap[String(rec.id)] = target;
    writeLS(LS_ASSIGN, assignMap);
    rec.series = target;

    if (rec.hero) {
      heroMap[String(rec.id)] = true;
      writeLS(LS_HERO, heroMap);
    }

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
      refreshFilters();

      var msg = ok ? '已加入 ' + ok + ' 张到「' + seriesName(currentSeries) + '」' : '没能读进来';
      if (bad) { msg += '，' + bad + ' 张跳过'; }
      if (skipped) { msg += '，另有 ' + skipped + ' 张超出上限'; }
      if (dbFailed) { msg += '（本次有效）'; }
      toast(msg);
    });
  }

  function removeCustom(f) {
    var wasHero = heroMap[String(f.id)] === true;

    var i = FRAMES.indexOf(f);
    if (i >= 0) { FRAMES.splice(i, 1); }

    var card = grid.querySelector('.card[data-id="' + f.id + '"]');
    if (card && card.parentNode) { card.parentNode.removeChild(card); }

    if (f.src) { URL.revokeObjectURL(f.src); }
    delete assignMap[String(f.id)];
    delete heroMap[String(f.id)];
    writeLS(LS_ASSIGN, assignMap);
    writeLS(LS_HERO, heroMap);
    dropRecord(f.id);

    if (wasHero) { buildRing(); }
    refreshFilters();
    toast('已移除');
  }

  /* --- 入口一：筛选条上的加号 --- */
  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = '';          // 允许重复选同一个文件
  });

  /* --- 入口二：把本机图片拖进页面 --- */
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
     七、入场编排与导航状态
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

      var anyHero = false;
      list.forEach(function (rec) {
        mountCustom(rec);
        if (rec.hero) { anyHero = true; }
      });

      refreshFilters();
      if (anyHero) { buildRing(); }
    });
  }

  /* --- 启动 --- */
  function init() {
    buildRing();
    renderGrid();
    buildFilters();
    observeReveals();
    paintStats();
    applyFilter(currentSeries);

    $('#year').textContent = new Date().getFullYear();

    if (!REDUCE) { requestAnimationFrame(loop); }

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { layout(); closeMover(); }, 140);
    });

    restoreCustom();
  }

  init();
})();
