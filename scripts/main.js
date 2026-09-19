/* ==========================================================================
   main.js — 交互层
   一、分类体系（按番剧名归类：新建 / 改名 / 删除 / 拖拽转移）
   二、环幕轮播（3D 圆柱：自转 / 拖拽惯性 / 吸附 / 键盘 / 触点，画面可自选）
   三、目录网格（分类筛选 + 自传图片的插入与移除）
   四、批量选择（点选 / 框选 / 拖拽整批转移 / 批量移除）
   五、归类浮层与灯箱（触屏、键盘的替代路径 + 放大查看）
   六、上传（本机图片 → canvas 缩放编码 → 色调统计 → IndexedDB 落盘）
      · 六·补 环幕管理（自主增删环幕上的画面）
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

  /* --- 素材寻址 ---------------------------------------------------------
     内置截图有三档：hero(1600) / view(1200) / grid(800)，但只有一部分图
     备了大图。所以 hero 档必须先查名单，没有就退回 view —— 否则用户把
     任意一张放上环幕，浏览器就会去请求不存在的 assets/hero/xx.webp。 */
  var HERO_ASSETS = {};
  (DATA.heroAssets || []).forEach(function (n) { HERO_ASSETS[n] = true; });

  function imgURL(f, size) {
    if (f.custom) { return f.src; }
    var tier = size;
    if (tier === 'hero' && !HERO_ASSETS[f.name]) { tier = 'view'; }
    return 'assets/' + tier + '/' + f.name + '.webp';
  }
  function kindOf(f) { return f.custom ? '自传图片' : '动画截图'; }

  /* 真正取不到的图（自传图的数据坏了、或文件被挪走）不能只留一个破图标：
     逐级降档，全挂就把这张记进 deadIds，管理面板里给一条去路。 */
  var deadIds = {};

  function deadLabel(el) {
    var box = document.createElement('span');
    box.className = 'dead';
    box.textContent = '素材缺失';
    el.appendChild(box);
  }

  function armImage(img, f, size) {
    // 灯箱里是同一个 img 反复换图，所以先把上一轮的处理摘掉
    if (img._armErr) { img.removeEventListener('error', img._armErr); }
    var tier = size;
    img._armErr = function () {
      if (!f.custom && tier !== 'grid') {
        tier = tier === 'hero' ? 'view' : 'grid';
        img.src = 'assets/' + tier + '/' + f.name + '.webp';
        return;
      }
      var fresh = !deadIds[String(f.id)];
      deadIds[String(f.id)] = true;
      img.classList.add('is-dead');
      var box = img.parentNode;
      if (box && !box.querySelector('.dead')) { deadLabel(box); }
      // 这张确实取不出来了，先从环幕上撤掉，再等用户决定去留
      if (fresh) { buildRing(); }
      paintRingBar();
    };
    img.addEventListener('error', img._armErr);
  }

  var ICON = {
    ring: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4.4v5h-5"/>',
    move: '<path d="M4 7h6M4 12h5M4 17h6"/><path d="M14 12h7m-3-3 3 3-3 3"/>',
    pick: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="m8 12.3 2.7 2.7 5.3-6"/>',
    check: '<path d="m5 12.4 4.6 4.6L19 7.4"/>',
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
  var LS_HIDDEN = 'anime-stills:hidden';

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
  /* 被"移除"的内置截图记在这里。内置素材是仓库里的文件，删不掉，
     所以对它们来说"删除"等于隐藏 —— 记一笔，随时能整批恢复。 */
  var hiddenSet = readLS(LS_HIDDEN, {});
  if (!Array.isArray(seriesList)) { seriesList = []; }
  seriesList = seriesList.filter(function (s) { return s && s.id && s.name; });

  function isHidden(f) { return !!hiddenSet[String(f.id)]; }
  /* 目录里真正露面的那些：内置素材减去被隐藏的 */
  function shownFrames() {
    return FRAMES.filter(function (f) { return !isHidden(f); });
  }
  function hiddenCount() {
    return FRAMES.filter(function (f) { return isHidden(f); }).length;
  }

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
    var list = shownFrames();
    if (id === ALL) { return list.length; }
    return list.filter(function (f) { return seriesOf(f) === id; }).length;
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

  /* 转移归类：单张与整批走同一条路，差别只在传进来几张 */
  function moveFrames(list, id) {
    if (!list || !list.length) { return false; }
    if (!liveSeries(id)) { return false; }

    var moved = 0;
    list.forEach(function (f) {
      if (seriesOf(f) === id) { return; }        // 已经在这一类里的跳过
      assignMap[String(f.id)] = id;
      if (f.custom) { patchRecord(f.id, { series: id }); }
      var card = grid.querySelector('.card[data-id="' + f.id + '"]');
      if (card) { card.dataset.series = id; }
      moved++;
    });

    if (!moved) {
      toast(list.length > 1
        ? '这几张已经都在「' + seriesName(id) + '」里了'
        : '已经归在「' + seriesName(id) + '」里了');
      return false;
    }

    writeLS(LS_ASSIGN, assignMap);
    refreshFilters();
    toast(list.length > 1
      ? '已把 ' + moved + ' 张移到「' + seriesName(id) + '」'
      : '已移到「' + seriesName(id) + '」');
    return true;
  }

  /* --- 环幕名单：内置的 8 张是默认值，用户改动会覆盖 --- */
  var HERO_MIN = 3;                // 少于三张就不成一个环了

  function inHero(f) {
    var o = heroMap[String(f.id)];
    return o === undefined ? !!f.hero : !!o;
  }
  /* 在不在环幕上：名单之外还要过两道 —— 被隐藏的、素材缺失的都不算 */
  function onRing(f) {
    return inHero(f) && !isHidden(f) && !deadIds[String(f.id)];
  }
  function heroFrames() { return FRAMES.filter(onRing); }

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
      img.alt = (f.title ? f.title + '：' : '') + kindOf(f);
      armImage(img, f, 'hero');          // 先挂降档处理，再给 src
      img.src = imgURL(f, 'hero');
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

    // 名单变了：入口上的数字、About 里的统计都跟着变，面板开着就顺手刷一遍
    paintRingBar();
    paintStats();
    if (ringbox && !ringbox.hidden) { syncRingBox(); }
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
    if (!HERO.length) { return; }        // 全部撤下环幕时别去 mod 0
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

  /* --- 键盘：← → 翻一张，空格切自动旋转，Esc 退出选择 --- */
  document.addEventListener('keydown', function (e) {
    if (lb.classList.contains('is-open')) { return; }
    // 环幕管理面板开着的时候，方向键留给面板自己用
    if (ringbox && !ringbox.hidden) {
      if (e.key === 'Escape') { closeRingBox(); }
      return;
    }
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') { return; }

    if (e.key === 'Escape') {
      if (!mover.hidden) { closeMover(); }
      else if (selectMode) { setSelectMode(false); }
    }
    else if (selectMode && (e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      pickAll();
    }
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
  var selChip = null;
  var dragFrames = null;           // 正在被拖动的画面（可能是一批）

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
    img.alt = (f.title ? f.title + '：' : '') + kindOf(f) + '，' + seriesName(seriesOf(f));
    armImage(img, f, 'grid');
    img.src = imgURL(f, 'grid');
    view.appendChild(img);

    // 有题名的才在悬停时浮现题名条，没有的就保持干净
    if (f.title) {
      var hover = document.createElement('span');
      hover.className = 'card__hover';
      hover.textContent = f.title;
      view.appendChild(hover);
    }

    view.addEventListener('click', function (e) {
      // 选择模式下点画面是「挑中它」，不打开灯箱
      if (selectMode) { togglePick(f, e.shiftKey); return; }
      openLightbox(f);
    });
    card.appendChild(view);

    /* --- 左上角的选择圈：只在选择模式里现身 --- */
    var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'card__pick';
    pick.setAttribute('aria-label', '选中这张');
    pick.innerHTML = icon(ICON.check);
    pick.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePick(f, e.shiftKey);
    });
    card.appendChild(pick);

    /* --- 右上角操作条 ---
       桌面：悬停浮出三个（归类 / 环幕 / 移除）
       触屏：只留一个「归类」，其余动作收进浮层——不然三个按钮常驻会把画面盖住 */
    var tools = document.createElement('div');
    tools.className = 'card__tools';

    // 归类
    var tMove = iconBtn('移动到分类', ICON.move);
    tMove.addEventListener('click', function (e) {
      e.stopPropagation();
      openMover([f], tMove);
    });
    tools.appendChild(tMove);

    // 环幕开关：在环幕上的那张图标点亮成朱红
    if (!NO_HOVER) {
      var tRing = iconBtn('放到环幕上', ICON.ring);
      function paintRingBtn() {
        var on = onRing(f);
        tRing.classList.toggle('is-on', on);
        tRing.title = on ? '从环幕移出' : '放到环幕上';
        tRing.setAttribute('aria-label', tRing.title);
      }
      paintRingBtn();
      tRing.addEventListener('click', function (e) {
        e.stopPropagation();
        if (deadIds[String(f.id)]) {          // 素材读不出来，放上去也是空白
          toast('这张素材读不出来，先换一张');
          return;
        }
        var on = !onRing(f);
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

    /* --- 拖拽：把这张图拖到某个分类上 ---
       如果这张正好在被选中的那一批里，拖的就是整批 —— 省得一张一张搬 */
    card.addEventListener('dragstart', function (e) {
      var batch = (selectMode && picked[String(f.id)] && pickCount() > 1)
        ? pickedFrames()
        : [f];
      dragFrames = batch;
      batch.forEach(function (x) {
        var el = grid.querySelector('.card[data-id="' + x.id + '"]');
        if (el) { el.classList.add('is-dragging'); }
      });

      if (!e.dataTransfer) { return; }
      e.dataTransfer.effectAllowed = 'move';
      // 自定义类型用来跟"把本机图片拖进页面"区分开
      try { e.dataTransfer.setData('application/x-anime-frame', String(f.id)); } catch (err) {}
      try { e.dataTransfer.setData('text/plain', String(f.id)); } catch (err) {}
    });
    card.addEventListener('dragend', function () {
      dragFrames = null;
      Array.prototype.forEach.call(grid.querySelectorAll('.is-dragging'), function (el) {
        el.classList.remove('is-dragging');
      });
      clearDropHints();
    });

    return card;
  }

  /* revealNow=true 时留给 IntersectionObserver 播入场（首次渲染用）；
     其余情况整表重建，直接呈现，免得删几张之后整屏重播一次入场动画 */
  function renderGrid(revealNow) {
    var frag = document.createDocumentFragment();
    FRAMES.forEach(function (f, i) {
      if (isHidden(f)) { return; }
      frag.appendChild(buildCard(f, i));
    });
    grid.innerHTML = '';
    grid.appendChild(frag);

    if (revealNow) {
      if (revealIO) {
        Array.prototype.forEach.call(grid.children, function (el) { revealIO.observe(el); });
      }
      return;
    }
    Array.prototype.forEach.call(grid.children, function (el) {
      el.style.transitionDelay = '0ms';
      el.classList.add('is-in');
    });
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
          if (!dragFrames) { return; }
          e.preventDefault();
          if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
          chip.classList.add('is-drop');
        });
        chip.addEventListener('dragleave', function () { chip.classList.remove('is-drop'); });
        chip.addEventListener('drop', function (e) {
          chip.classList.remove('is-drop');
          if (!dragFrames) { return; }
          e.preventDefault();
          e.stopPropagation();
          moveFrames(dragFrames, it.id);
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
    addBtn.addEventListener('click', function () {
      clearPendingRing();                   // 普通上传不往环幕上塞
      fileInput.click();
    });
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

    // 批量选择的开关。放在最后，跟前面一串筛选状态分开
    selChip = document.createElement('button');
    selChip.type = 'button';
    selChip.id = 'selChip';
    selChip.className = 'chip chip--pick';
    selChip.title = '批量选择画面';
    selChip.setAttribute('aria-pressed', 'false');
    selChip.innerHTML = icon(ICON.pick) + '<span>选择</span>';
    selChip.addEventListener('click', function () { setSelectMode(!selectMode); });
    filters.appendChild(selChip);

    // 有隐藏的画面才出现，点一下整批放回来
    var hid = hiddenCount();
    if (hid) {
      var restoreChip = document.createElement('button');
      restoreChip.type = 'button';
      restoreChip.className = 'chip chip--restore';
      restoreChip.title = '把隐藏的内置截图放回目录';
      restoreChip.innerHTML = '<span>恢复隐藏</span><span class="chip__count">' + pad(hid) + '</span>';
      restoreChip.addEventListener('click', restoreHidden);
      filters.appendChild(restoreChip);
    }
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

  /* 当前筛选下真正露面的画面：灯箱翻页、全选、框选都以它为准 */
  function visibleFrames() {
    return shownFrames().filter(function (f) {
      return currentSeries === ALL || seriesOf(f) === currentSeries;
    });
  }

  function paintStats() {
    $('#statCount').textContent = pad(shownFrames().length);
    $('#statHero').textContent = pad(heroFrames().length);
    $('#statSeries').textContent = pad(seriesList.length);
  }

  /* 分类结构动了之后统一刷新 */
  function refreshFilters() {
    buildFilters();
    applyFilter(currentSeries);
    paintStats();
    closeMover();
    syncPickUI();
  }

  /* ======================================================================
     四、批量选择
     一屏几十张的时候一张一张点太慢，所以给三种选法：
     点一下挑一张、按住 Shift 连选一段、在空白处拖个框圈住一片。
     选完可以整批搬去某个分类，也可以整批移除。
     ====================================================================== */
  var selbar = $('#selbar');
  var selCount = $('#selCount');
  var selBtnMove = $('#selMove');
  var selBtnDel = $('#selDel');
  var indexSection = $('#index');

  var selectMode = false;
  var picked = {};                 // id -> true
  var lastPickedId = null;         // 供 Shift 连选定位
  var lastBarH = -1;

  function pickCount() { return Object.keys(picked).length; }
  function pickedFrames() {
    return FRAMES.filter(function (f) { return picked[String(f.id)]; });
  }
  function copyPicked() {
    var o = {};
    Object.keys(picked).forEach(function (k) { o[k] = true; });
    return o;
  }

  /* --- 状态一变就重绘：计数、卡片描边、底部操作条 --- */
  function syncPickUI() {
    Array.prototype.forEach.call(grid.children, function (card) {
      card.classList.toggle('is-picked', !!picked[card.dataset.id]);
    });

    var n = pickCount();
    selCount.textContent = n;
    selbar.classList.toggle('is-on', selectMode);
    grid.classList.toggle('is-picking', selectMode);
    document.body.classList.toggle('is-picking', selectMode);

    selBtnMove.disabled = n === 0;
    selBtnDel.disabled = n === 0;

    if (selChip) { selChip.setAttribute('aria-pressed', selectMode ? 'true' : 'false'); }

    // 提示条得让开操作条，所以先把操作条的高度量下来存进变量
    if (selectMode) {
      var h = selbar.offsetHeight;
      if (h && h !== lastBarH) {
        lastBarH = h;
        document.body.style.setProperty('--selbar-h', h + 'px');
      }
    } else if (lastBarH !== -1) {
      lastBarH = -1;
      document.body.style.removeProperty('--selbar-h');
    }
  }

  function setSelectMode(on) {
    on = !!on;
    if (on === selectMode) { return; }
    selectMode = on;
    disarmDel();
    if (!selectMode) {
      picked = {};
      lastPickedId = null;
      mqEnd();
      closeMover();
    }
    syncPickUI();
    toast(selectMode
      ? (NO_HOVER ? '点一下画面选中，再点一下取消' : '点画面选中，Shift 连选，空白处拖框圈一片')
      : '已退出选择');
  }

  function togglePick(f, range) {
    var id = String(f.id);

    // Shift：把上一次点的那张到这一张之间整段一起选上
    if (range && lastPickedId) {
      var list = visibleFrames();
      var a = -1, b = -1, i;
      for (i = 0; i < list.length; i++) {
        var k = String(list[i].id);
        if (k === lastPickedId) { a = i; }
        if (k === id) { b = i; }
      }
      if (a >= 0 && b >= 0) {
        var on = !picked[id];
        for (i = Math.min(a, b); i <= Math.max(a, b); i++) {
          var ki = String(list[i].id);
          if (on) { picked[ki] = true; } else { delete picked[ki]; }
        }
        lastPickedId = id;
        syncPickUI();
        return;
      }
    }

    if (picked[id]) { delete picked[id]; } else { picked[id] = true; }
    lastPickedId = id;
    syncPickUI();
  }

  /* 全选 / 反选 / 清空都只看当前筛选下露面的那些 */
  function pickAll() {
    visibleFrames().forEach(function (f) { picked[String(f.id)] = true; });
    syncPickUI();
  }
  function pickInvert() {
    visibleFrames().forEach(function (f) {
      var id = String(f.id);
      if (picked[id]) { delete picked[id]; } else { picked[id] = true; }
    });
    syncPickUI();
  }
  function pickNone() {
    picked = {};
    lastPickedId = null;
    syncPickUI();
  }

  /* --- 框选：在空白处按住拖出一个矩形，压到多少选多少 ---
     只走鼠标：触屏上按住拖动是滚动页面，硬接管会跟系统手势打架 */
  var marqueeEl = null;
  var mqFrom = null;
  var mqBase = null;

  function mqMove(e) {
    if (!mqFrom) { return; }
    var x = e.clientX, y = e.clientY;
    if (Math.abs(x - mqFrom.x) < 4 && Math.abs(y - mqFrom.y) < 4) { return; }

    var box = {
      l: Math.min(x, mqFrom.x), t: Math.min(y, mqFrom.y),
      r: Math.max(x, mqFrom.x), b: Math.max(y, mqFrom.y)
    };
    marqueeEl.hidden = false;
    marqueeEl.style.left = box.l + 'px';
    marqueeEl.style.top = box.t + 'px';
    marqueeEl.style.width = (box.r - box.l) + 'px';
    marqueeEl.style.height = (box.b - box.t) + 'px';
    document.body.classList.add('is-marquee');

    // 按住 Shift 是在原有选择上叠加，否则每一帧都按框重算
    var next = mqBase || {};
    Array.prototype.forEach.call(grid.children, function (card) {
      if (card.classList.contains('is-hidden')) { return; }
      var r = card.getBoundingClientRect();
      if (r.right > box.l && r.left < box.r && r.bottom > box.t && r.top < box.b) {
        next[card.dataset.id] = true;
      }
    });
    picked = next;
    syncPickUI();
  }

  function mqEnd() {
    mqFrom = null;
    mqBase = null;
    if (marqueeEl) { marqueeEl.hidden = true; }
    document.body.classList.remove('is-marquee');
    document.removeEventListener('pointermove', mqMove);
    document.removeEventListener('pointerup', mqEnd);
    document.removeEventListener('pointercancel', mqEnd);
  }

  indexSection.addEventListener('pointerdown', function (e) {
    if (!selectMode || NO_HOVER) { return; }
    if (e.button !== undefined && e.button !== 0) { return; }
    // 卡片、筛选条、按钮上的按下都不算框选
    if (e.target.closest && e.target.closest('.card, .chip, .chip-slot, .selbar, a, button, input')) {
      return;
    }
    e.preventDefault();

    if (!marqueeEl) {
      marqueeEl = document.createElement('div');
      marqueeEl.className = 'marquee';
      marqueeEl.hidden = true;
      document.body.appendChild(marqueeEl);
    }
    mqFrom = { x: e.clientX, y: e.clientY };
    mqBase = e.shiftKey ? copyPicked() : null;
    document.addEventListener('pointermove', mqMove);
    document.addEventListener('pointerup', mqEnd);
    document.addEventListener('pointercancel', mqEnd);
  });

  /* --- 移除：自传图片是真删且不可逆，所以让它多按一下 --- */
  var delArmed = false;
  var delTimer = null;

  function disarmDel() {
    delArmed = false;
    clearTimeout(delTimer);
    selBtnDel.textContent = '移除';
    selBtnDel.classList.remove('is-armed');
  }

  /* 批量移除：自传的真删，内置的记一笔隐藏（可整批恢复） */
  function removeFrames(list) {
    if (!list || !list.length) { return; }

    var gone = 0, hid = 0, ringDirty = false;
    list.forEach(function (f) {
      if (f.custom) {
        if (removeCustomCore(f)) { ringDirty = true; }
        gone++;
      } else {
        hiddenSet[String(f.id)] = true;
        delete picked[String(f.id)];
        delete deadIds[String(f.id)];
        hid++;
      }
    });

    writeLS(LS_HIDDEN, hiddenSet);
    // 撤掉的画面可能正在环幕上，名单一变就得重算夹角
    if (ringDirty || hid) { buildRing(); }
    renderGrid();
    refreshFilters();

    var msg = [];
    if (gone) { msg.push('移除 ' + gone + ' 张'); }
    if (hid) { msg.push('隐藏 ' + hid + ' 张内置截图，点「恢复隐藏」能放回来'); }
    toast(msg.join('，'));
  }

  function restoreHidden() {
    hiddenSet = {};
    writeLS(LS_HIDDEN, hiddenSet);
    renderGrid();
    buildRing();
    refreshFilters();
    toast('已把隐藏的画面放回目录');
  }

  $('#selAll').addEventListener('click', pickAll);
  $('#selInvert').addEventListener('click', pickInvert);
  $('#selClear').addEventListener('click', pickNone);
  $('#selDone').addEventListener('click', function () { setSelectMode(false); });

  selBtnMove.addEventListener('click', function () {
    var list = pickedFrames();
    if (!list.length) { return; }
    openMover(list, selBtnMove);
  });

  selBtnDel.addEventListener('click', function () {
    var list = pickedFrames();
    if (!list.length) { return; }

    var customN = list.filter(function (f) { return f.custom; }).length;
    // 只有内置截图时不用确认 —— 隐藏随时能还原
    if (customN && !delArmed) {
      delArmed = true;
      selBtnDel.textContent = '确认删掉 ' + customN + ' 张？';
      selBtnDel.classList.add('is-armed');
      clearTimeout(delTimer);
      delTimer = setTimeout(disarmDel, 3600);
      return;
    }
    disarmDel();
    removeFrames(list);
  });

  window.addEventListener('resize', function () {
    if (!selectMode) { return; }
    lastBarH = -1;               // 屏幕尺寸变了，操作条高度得重新量
    syncPickUI();
  });

  /* ======================================================================
     五、归类浮层
     拖拽是最快的路径，但触屏上没有 hover、也不好精确落到某个 chip 上，
     所以每条画面再给一个明确的文字入口，两条路都落到 moveFrames。
     ====================================================================== */
  var mover = $('#mover');
  var moverList = $('#moverList');
  var moverNew = $('#moverNew');
  var moverHead = $('#moverHead');
  var moverFrames = null;          // 待归类的一批（单张也是一个元素的数组）

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
    if (!NO_HOVER || !f) { return; }

    var acts = document.createElement('div');
    acts.className = 'mover__acts';

    var on = onRing(f);
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

  function openMover(list, anchor) {
    moverFrames = list.slice();

    var only = moverFrames.length === 1 ? moverFrames[0] : null;
    moverHead.textContent = only ? '移动到' : '移动 ' + moverFrames.length + ' 张到';

    moverList.innerHTML = '';

    var opts = [{ id: UNSORTED, name: '未分类' }].concat(
      seriesList.map(function (s) { return { id: s.id, name: s.name }; })
    );

    opts.forEach(function (o) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'mover__item' + (only && seriesOf(only) === o.id ? ' is-current' : '');

      item.appendChild(document.createTextNode(o.name));
      var c = document.createElement('span');
      c.textContent = pad(countIn(o.id));
      item.appendChild(c);

      item.addEventListener('click', function () {
        var batch = moverFrames;
        closeMover();
        moveFrames(batch, o.id);
      });
      moverList.appendChild(item);
    });

    moverNew.value = '';
    mover.hidden = false;
    // 触屏专用的那条动作栏只对单张有意义，整批时不出现
    buildMoverActs(only);
    placeMover(anchor);
  }

  function closeMover() {
    if (mover.hidden) { return; }
    mover.hidden = true;
    moverFrames = null;
  }

  moverNew.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMover(); return; }
    if (e.key !== 'Enter' || !moverFrames) { return; }
    var v = moverNew.value.trim();
    if (!v) { return; }
    var batch = moverFrames;
    var s = createSeries(v);
    closeMover();
    moveFrames(batch, s.id);
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
    armImage(lbImg, f, 'view');
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

  /* 上传的图落到哪儿：正看着某个分类就进那个分类，否则进「未分类」 */
  function uploadTarget() {
    return currentSeries !== ALL ? currentSeries : UNSORTED;
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
    var target = (rec.series && liveSeries(rec.series)) ? rec.series : uploadTarget();
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
      var f = mountCustom(rec);
      return saveRecord(rec).then(function () { return f; });
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
    var made = [];                       // 这一轮新进来的画面
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return addOne(file).then(
          function (f) { ok++; made.push(f); },
          function () { bad++; }
        );
      });
    });

    chain.then(function () {
      if (addBtn) { addBtn.classList.remove('is-busy'); }

      /* 从环幕面板点的上传：传完直接放上去，省得再一张张挑 */
      var onRing = 0;
      if (pendingRing) {
        clearPendingRing();
        made.forEach(function (f) {
          if (!f || inHero(f)) { return; }
          if (heroFrames().length >= MAX_HERO) { return; }
          heroMap[String(f.id)] = true;
          patchRecord(f.id, { hero: true });
          onRing++;
        });
        if (onRing) {
          writeLS(LS_HERO, heroMap);
          buildRing();
        }
      }

      refreshFilters();

      var msg = ok ? '已加入 ' + ok + ' 张到「' + seriesName(uploadTarget()) + '」' : '没能读进来';
      if (bad) { msg += '，' + bad + ' 张跳过'; }
      if (skipped) { msg += '，另有 ' + skipped + ' 张超出上限'; }
      if (onRing) { msg += '，已放到环幕上'; }
      if (dbFailed) { msg += '（本次有效）'; }
      if (!ringbox.hidden) { syncRingBox(); }
      toast(msg);
    });
  }

  /* 拆掉一张自传图片，返回它原先在不在环幕上（调用方据此决定要不要重建环幕） */
  function removeCustomCore(f) {
    var wasHero = heroMap[String(f.id)] === true;

    var i = FRAMES.indexOf(f);
    if (i >= 0) { FRAMES.splice(i, 1); }

    var card = grid.querySelector('.card[data-id="' + f.id + '"]');
    if (card && card.parentNode) { card.parentNode.removeChild(card); }

    if (f.src) { URL.revokeObjectURL(f.src); }
    delete assignMap[String(f.id)];
    delete heroMap[String(f.id)];
    delete picked[String(f.id)];
    delete deadIds[String(f.id)];
    writeLS(LS_ASSIGN, assignMap);
    writeLS(LS_HERO, heroMap);
    dropRecord(f.id);
    return wasHero;
  }

  function removeCustom(f) {
    if (removeCustomCore(f)) { buildRing(); }
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
    clearPendingRing();                    // 拖进来的按普通上传处理
    handleFiles(e.dataTransfer.files);
  });

  /* ======================================================================
     六·补 环幕管理（自己决定环幕上放哪几张）
     环幕上放哪几张完全交给用户：面板里点一下就加上、再点一下移下，
     也能整批放上去或恢复默认。名单沿用 localStorage 的 hero 表，
     自传图片再往库里补写一份，清了浏览器数据也还在。
     ====================================================================== */
  var MAX_HERO = 24;              // 再多下去，一圈面板会把浏览器拖慢
  var ringBar = $('#ringBar');
  var ringBarCount = $('#ringBarCount');
  var ringbox = $('#ringbox');
  var ringOnRow = $('#ringOn');
  var ringOffRow = $('#ringOff');
  var ringDeadRow = $('#ringDead');
  var ringDeadSec = $('#ringDeadSec');
  var ringBoxEmpty = $('#ringBoxEmpty');
  var ringBoxOn = $('#ringBoxOn');
  var pendingRing = false;        // 从面板点的"上传"，传完直接放上环幕
  var pendingTimer = null;

  function clearPendingRing() {
    pendingRing = false;
    clearTimeout(pendingTimer);
  }

  function paintRingBar() {
    if (!ringBarCount) { return; }
    var n = heroFrames().length;
    ringBarCount.textContent = pad(n);
    ringBar.title = '环幕上现有 ' + n + ' 张，点开可自行增删';
  }

  function deadFrames() {
    return FRAMES.filter(function (f) { return deadIds[String(f.id)]; });
  }

  /* --- 面板里的一个小格：缩略图 + ×/＋ --- */
  function ringThumb(f, mode) {
    var cell = document.createElement('div');
    cell.className = 'rt rt--' + mode;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rt__btn';
    var label = f.title || seriesName(seriesOf(f));
    btn.title = (mode === 'on' ? '从环幕移下：' : '放到环幕上：') + label;
    btn.setAttribute('aria-label', btn.title);

    var img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    armImage(img, f, 'grid');
    img.src = imgURL(f, 'grid');
    btn.appendChild(img);

    var mark = document.createElement('span');
    mark.className = 'rt__mark';
    mark.textContent = mode === 'on' ? '×' : '＋';
    btn.appendChild(mark);

    if (mode === 'on') {
      var no = document.createElement('span');
      no.className = 'rt__no';
      no.textContent = pad(heroFrames().indexOf(f) + 1);
      cell.appendChild(no);
    }
    if (f.custom) {
      var tag = document.createElement('span');
      tag.className = 'rt__tag';
      tag.textContent = '自传';
      cell.appendChild(tag);
    }

    btn.addEventListener('click', function () {
      if (mode === 'on') { takeOffRing(f); } else { putOnRing(f); }
    });

    cell.appendChild(btn);
    return cell;
  }

  /* --- 取不出来的那几张：给一个明确的去路，而不是留着破图 --- */
  function deadThumb(f) {
    var cell = document.createElement('div');
    cell.className = 'rt rt--dead';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rt__btn';
    btn.title = '清掉这张读不出来的画面';
    btn.setAttribute('aria-label', btn.title);

    var box = document.createElement('span');
    box.className = 'rt__ph';
    box.textContent = '缺失';
    btn.appendChild(box);

    btn.addEventListener('click', function () { removeFrames([f]); });
    cell.appendChild(btn);
    return cell;
  }

  function putOnRing(f) {
    if (inHero(f)) { return; }
    if (heroFrames().length >= MAX_HERO) {
      toast('环幕最多 ' + MAX_HERO + ' 张，先移下几张');
      return;
    }
    if (!setHero(f, true)) { return; }
    toast('已放到环幕上');
  }

  function takeOffRing(f) {
    if (!inHero(f)) { return; }
    if (!setHero(f, false)) { return; }        // 少于 3 张时 setHero 会拦下
    toast('已从环幕移下');
  }

  function syncRingBox() {
    var on = heroFrames();

    ringBoxOn.textContent = pad(on.length);
    ringOnRow.innerHTML = '';
    on.forEach(function (f) { ringOnRow.appendChild(ringThumb(f, 'on')); });

    var off = FRAMES.filter(function (f) { return !onRing(f); });   // 缺失的走下面那段单独列
    ringOffRow.innerHTML = '';
    if (off.length) {
      off.forEach(function (f) { ringOffRow.appendChild(ringThumb(f, 'off')); });
    } else {
      var done = document.createElement('p');
      done.className = 'ringbox__hint';
      done.textContent = '目录里的画面都在环幕上了。';
      ringOffRow.appendChild(done);
    }

    var dead = deadFrames();
    ringDeadSec.hidden = !dead.length;
    ringDeadRow.innerHTML = '';
    dead.forEach(function (f) { ringDeadRow.appendChild(deadThumb(f)); });

    if (ringBoxEmpty) {
      ringBoxEmpty.hidden = (on.length + off.length + dead.length) > 0;
    }
  }

  function openRingBox() {
    syncRingBox();
    ringbox.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { ringbox.classList.add('is-open'); });
    $('#ringBoxClose').focus();
  }

  function closeRingBox() {
    if (ringbox.hidden) { return; }
    ringbox.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(function () {
      if (!ringbox.classList.contains('is-open')) { ringbox.hidden = true; }
    }, 260);
    if (ringBar) { ringBar.focus(); }
  }

  ringBar.addEventListener('click', openRingBox);
  $('#ringBoxClose').addEventListener('click', closeRingBox);
  $('#ringDone').addEventListener('click', closeRingBox);
  ringbox.addEventListener('click', function (e) {
    if (e.target === ringbox) { closeRingBox(); }
  });

  // 传完直接上环幕。标记用超时兜底：用户取消文件框也不会留下后遗症
  $('#ringAdd').addEventListener('click', function () {
    pendingRing = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { pendingRing = false; }, 60000);
    fileInput.click();
  });

  $('#ringAll').addEventListener('click', function () {
    var room = MAX_HERO - heroFrames().length;
    if (room <= 0) { toast('环幕已经满 ' + MAX_HERO + ' 张了'); return; }

    var off = FRAMES.filter(function (f) { return !onRing(f); });   // 缺失的走下面那段单独列
    off.slice(0, room).forEach(function (f) {
      heroMap[String(f.id)] = true;
      if (f.custom) { patchRecord(f.id, { hero: true }); }
    });
    writeLS(LS_HERO, heroMap);
    buildRing();
    toast(off.length > room
      ? '已放到环幕上 ' + room + ' 张，到上限了'
      : '这一屏的画面都放上环幕了');
  });

  $('#ringReset').addEventListener('click', function () {
    heroMap = {};
    writeLS(LS_HERO, heroMap);
    buildRing();
    toast('环幕已恢复默认的 8 张');
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
    renderGrid(true);              // 首次渲染，入场交给 IntersectionObserver
    buildFilters();
    observeReveals();
    paintStats();
    applyFilter(currentSeries);
    syncPickUI();

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
