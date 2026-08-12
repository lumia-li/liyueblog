(function () {
  const STYLE_ID = 'twikoo-drawing-style';
  const ACTIVE_CLASS = 'tk-drawing-active';
  const INIT_ATTR = 'data-drawing-init';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .tk-drawing-canvas-wrap {
        display: none;
        border: 1px solid var(--twikoo-border-color, #e0e0e0);
        border-radius: 8px;
        background: #fff;
        padding: 8px;
        margin-bottom: 8px;
      }
      .tk-drawing-active .tk-drawing-canvas-wrap { display: block; }
      .tk-drawing-active .tk-input { display: none !important; }
      .tk-drawing-canvas {
        width: 100%;
        height: 220px;
        border: 1px dashed #ccc;
        border-radius: 4px;
        background: #fff;
        cursor: crosshair;
        touch-action: none;
      }
      .tk-drawing-toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .tk-drawing-toolbar button {
        border: 1px solid #ccc;
        background: #fff;
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        color: #333;
      }
      .tk-drawing-toolbar button.active {
        background: #333;
        color: #fff;
        border-color: #333;
      }
      .tk-drawing-color {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid transparent;
        padding: 0;
      }
      .tk-drawing-color.active { border-color: #333; }
      .tk-drawing-uploading { opacity: .6; pointer-events: none; }
      .tk-drawing-preview { display: none; }
      .tk-drawing-preview-active .tk-drawing-toolbar,
      .tk-drawing-preview-active .tk-drawing-canvas { display: none; }
      .tk-drawing-preview-active .tk-drawing-preview { display: block; }
      .tk-drawing-preview img { max-width: 100%; border: 1px dashed #ccc; border-radius: 4px; background: #fff; }
    `;
    document.head.appendChild(style);
  }

  function createCanvasWrap() {
    const wrap = document.createElement('div');
    wrap.className = 'tk-drawing-canvas-wrap';
    wrap.innerHTML = `
      <div class="tk-drawing-toolbar">
        <button type="button" class="tk-drawing-color active" data-color="#000000" style="background:#000000" title="黑色"></button>
        <button type="button" class="tk-drawing-color" data-color="#4caf50" style="background:#4caf50" title="绿色"></button>
        <button type="button" class="tk-drawing-color" data-color="#ff9800" style="background:#ff9800" title="橙色"></button>
        <button type="button" class="tk-drawing-color" data-color="#f44336" style="background:#f44336" title="红色"></button>
        <button type="button" class="tk-drawing-size active" data-width="2">细</button>
        <button type="button" class="tk-drawing-size" data-width="5">中</button>
        <button type="button" class="tk-drawing-size" data-width="10">粗</button>
        <button type="button" class="tk-drawing-undo">撤销</button>
        <button type="button" class="tk-drawing-eraser">橡皮</button>
        <button type="button" class="tk-drawing-clear">清空</button>
      </div>
      <canvas class="tk-drawing-canvas"></canvas>
      <div class="tk-drawing-preview">
        <img src="" alt="涂鸦预览" />
      </div>
    `;
    return wrap;
  }

  function initForm(submitRoot) {
    if (submitRoot.hasAttribute(INIT_ATTR)) return;
    submitRoot.setAttribute(INIT_ATTR, 'true');

    const textarea = submitRoot.querySelector('.el-textarea__inner');
    const sendBtn = submitRoot.querySelector('.tk-send');
    const actionsRow = submitRoot.querySelector('.tk-row.actions');
    if (!textarea || !sendBtn || !actionsRow) return;

    const inputWrap = textarea.closest('.tk-input');
    if (!inputWrap) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'el-button el-button--default el-button--small tk-drawing-toggle';
    toggleBtn.textContent = '画板';
    actionsRow.insertBefore(toggleBtn, sendBtn);

    const wrap = createCanvasWrap();
    inputWrap.parentNode.insertBefore(wrap, inputWrap.nextSibling);

    const canvas = wrap.querySelector('.tk-drawing-canvas');
    const ctx = canvas.getContext('2d');

    // 初始化画布尺寸
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      redraw();
    }

    let penColor = '#000000';
    let penWidth = 2;
    let isEraser = false;
    let drawing = false;
    let currentStroke = null;
    let strokes = [];
    let isUploading = false;
    let mode = 'text';
    let isPreview = false;

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      let clientX, clientY;
      if (e.touches && e.touches.length) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (e.changedTouches && e.changedTouches.length) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function drawDot(pos) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, Math.max(penWidth / 2, 1), 0, Math.PI * 2);
      ctx.fillStyle = isEraser ? '#ffffff' : penColor;
      ctx.fill();
    }

    function startStroke(e) {
      e.preventDefault();
      if (canvas.width === 0 || canvas.height === 0) resizeCanvas();
      drawing = true;
      const pos = getPos(e);
      currentStroke = { color: penColor, width: penWidth, eraser: isEraser, points: [pos] };
      drawDot(pos);
    }

    function moveStroke(e) {
      if (!drawing) return;
      e.preventDefault();
      const pos = getPos(e);
      const last = currentStroke.points[currentStroke.points.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = isEraser ? '#ffffff' : penColor;
      ctx.lineWidth = penWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      currentStroke.points.push(pos);
    }

    function endStroke() {
      if (!drawing) return;
      drawing = false;
      if (currentStroke && currentStroke.points.length > 1) {
        strokes.push(currentStroke);
      }
      currentStroke = null;
    }

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const stroke of strokes) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.strokeStyle = stroke.eraser ? '#ffffff' : stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    function clearCanvas() {
      strokes = [];
      redraw();
    }

    function undo() {
      strokes.pop();
      redraw();
    }

    function isBlank() {
      return strokes.length === 0;
    }

    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch {}
        startStroke(e);
      });
      canvas.addEventListener('pointermove', (e) => {
        e.preventDefault();
        moveStroke(e);
      });
      canvas.addEventListener('pointerup', (e) => {
        endStroke();
        try {
          if (canvas.hasPointerCapture(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
          }
        } catch {}
      });
      canvas.addEventListener('pointercancel', endStroke);
    } else {
      canvas.addEventListener('mousedown', startStroke);
      canvas.addEventListener('mousemove', moveStroke);
      window.addEventListener('mouseup', endStroke);
      canvas.addEventListener('touchstart', startStroke, { passive: false });
      canvas.addEventListener('touchmove', moveStroke, { passive: false });
      window.addEventListener('touchend', endStroke);
    }

    // 工具栏事件
    wrap.querySelectorAll('.tk-drawing-color').forEach((btn) => {
      btn.addEventListener('click', () => {
        penColor = btn.dataset.color;
        isEraser = false;
        wrap.querySelectorAll('.tk-drawing-color').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        wrap.querySelector('.tk-drawing-eraser').classList.remove('active');
      });
    });

    wrap.querySelectorAll('.tk-drawing-size').forEach((btn) => {
      btn.addEventListener('click', () => {
        penWidth = Number(btn.dataset.width);
        wrap.querySelectorAll('.tk-drawing-size').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    wrap.querySelector('.tk-drawing-undo').addEventListener('click', undo);
    wrap.querySelector('.tk-drawing-clear').addEventListener('click', clearCanvas);

    const eraserBtn = wrap.querySelector('.tk-drawing-eraser');
    eraserBtn.addEventListener('click', () => {
      isEraser = !isEraser;
      eraserBtn.classList.toggle('active', isEraser);
    });

    toggleBtn.addEventListener('click', () => {
      const wasDrawing = mode === 'drawing';
      mode = wasDrawing ? 'text' : 'drawing';
      submitRoot.classList.toggle(ACTIVE_CLASS, mode === 'drawing');
      toggleBtn.textContent = mode === 'drawing' ? '文字' : '画板';
      if (mode === 'drawing') {
        isPreview = false;
        wrap.classList.remove('tk-drawing-preview-active');
        sendBtn.disabled = false;
        sendBtn.classList.remove('is-disabled');
        requestAnimationFrame(resizeCanvas);
      }
    });

    async function uploadDrawingAndTrigger(triggerBtn) {
      if (isUploading || isBlank()) return;
      isUploading = true;
      triggerBtn.classList.add('tk-drawing-uploading');

      try {
        const dataUrl = canvas.toDataURL('image/png');
        const res = await fetch('/api/drawing-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || 'Upload failed');

        textarea.value = `![drawing](${data.url})`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        clearCanvas();
        isPreview = false;
        wrap.classList.remove('tk-drawing-preview-active');
        mode = 'text';
        submitRoot.classList.remove(ACTIVE_CLASS);
        toggleBtn.textContent = '画板';
        triggerBtn.classList.remove('tk-drawing-uploading');
        isUploading = false;

        triggerBtn.click();
      } catch (err) {
        alert('涂鸦上传失败：' + (err.message || '未知错误'));
        isUploading = false;
        triggerBtn.classList.remove('tk-drawing-uploading');
      }
    }

    // 拦截发送按钮，先上传涂鸦
    sendBtn.addEventListener('click', async (e) => {
      if (mode !== 'drawing' || isUploading || isBlank()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await uploadDrawingAndTrigger(sendBtn);
    }, true);

    // 拦截预览按钮：本地预览，不上传
    const previewBtn = submitRoot.querySelector('.tk-preview');
    if (previewBtn) {
      previewBtn.addEventListener('click', (e) => {
        if (mode !== 'drawing' || isUploading || isBlank()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isPreview) {
          isPreview = false;
          wrap.classList.remove('tk-drawing-preview-active');
          return;
        }
        const previewImg = wrap.querySelector('.tk-drawing-preview img');
        if (previewImg) previewImg.src = canvas.toDataURL('image/png');
        isPreview = true;
        wrap.classList.add('tk-drawing-preview-active');
      }, true);
    }
  }

  function scan() {
    document.querySelectorAll('.tk-submit:not([' + INIT_ATTR + '])').forEach(initForm);
  }

  function init() {
    ensureStyles();
    scan();
    const target = document.getElementById('comment') || document.body;
    if (!target._twikooDrawingObserver) {
      const observer = new MutationObserver(scan);
      observer.observe(target, { childList: true, subtree: true });
      target._twikooDrawingObserver = observer;
    }
  }

  window.initTwikooDrawing = init;
})();
