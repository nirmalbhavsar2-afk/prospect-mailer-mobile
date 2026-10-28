// Rich-text message box with a small formatting toolbar (bold, italic, underline, font, size,
// colour, lists, link, clear). Classic script so both the LinkedIn panel (content script) and the
// dashboard can use it: window.PMRich.create(hostElement, { placeholder, rows }).
// The returned editor element behaves like a textarea for existing code:
//   el.value          → plain text (get/set; setting replaces content with plain text)
//   el.html           → formatted HTML for the email (sanitised)
//   el.insertText(s)  → insert at the cursor
(function () {
  if (globalThis.PMRich) return;

  const FONTS = [
    ['Verdana', 'Verdana, Geneva, sans-serif'],
    ['Arial', 'Arial, Helvetica, sans-serif'],
    ['Calibri', 'Calibri, Carlito, Arial, sans-serif'],
    ['Georgia', 'Georgia, serif'],
    ['Times New Roman', '"Times New Roman", Times, serif'],
    ['Tahoma', 'Tahoma, Geneva, sans-serif'],
    ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
    ['Courier New', '"Courier New", monospace'],
  ];
  const SIZES = [['Small', '10px'], ['Normal', '12px'], ['Large', '16px'], ['Huge', '20px']];
  const COLORS = ['#222222', '#073763', '#1a56db', '#c62828', '#e8590c'];
  const BASE_STYLE = 'font-family:Verdana,Geneva,sans-serif;font-size:12px;line-height:1.5;color:#222';

  const CSS = `
.pmr { border: 1px solid #d5dedb; border-radius: 8px; background: #fff; display: flex; flex-direction: column; }
.pmr:focus-within { border-color: #ff6b1a; box-shadow: 0 0 0 3px rgba(255,107,26,.15); }
.pmr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px; border-bottom: 1px solid #e6ece9; background: #f8faf9; border-radius: 8px 8px 0 0; position: relative; }
.pmr-bar button { border: 0; background: transparent; min-width: 26px; height: 26px; border-radius: 5px; cursor: pointer; font: 600 13px/1 Arial, sans-serif; color: #333; padding: 0 5px; }
.pmr-bar button:hover, .pmr-bar button.on { background: #e3ece8; }
.pmr-bar select { height: 26px; border: 1px solid #d5dedb; border-radius: 5px; background: #fff; font: 12px Arial, sans-serif; padding: 0 4px; color: #333; width: auto; margin: 0; }
.pmr-sep { width: 1px; height: 18px; background: #dfe6e3; margin: 0 3px; }
.pmr-color { display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-top: 1px; }
.pmr-pal { position: absolute; top: 32px; z-index: 5; background: #fff; border: 1px solid #d5dedb; border-radius: 8px; padding: 6px; display: grid; grid-template-columns: repeat(5, 22px); gap: 5px; box-shadow: 0 6px 20px rgba(0,0,0,.15); }
.pmr-pal[hidden] { display: none; }
.pmr-pal button { width: 22px; height: 22px; min-width: 0; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #d5dedb; padding: 0; }
.pmr-ed { ${BASE_STYLE}; padding: 9px 11px; overflow-y: auto; outline: none; white-space: pre-wrap; word-wrap: break-word; cursor: text; }
.pmr-ed:empty::before { content: attr(data-placeholder); color: #98a3a0; }
.pmr-ed ul, .pmr-ed ol { margin: 4px 0; padding-left: 24px; }
.pmr-ed a { color: #1a56db; }
`;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const textToHtml = (t) => esc(t).replace(/\r?\n/g, '<br>');

  // DOM → plain text (works even when the element isn't rendered, unlike innerText)
  function toText(root) {
    let out = '';
    const block = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE)$/;
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' '); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'BR') { out += '\n'; return; }
      const isBlock = block.test(n.tagName);
      if (isBlock && out && !out.endsWith('\n')) out += '\n';
      if (n.tagName === 'LI') out += n.parentElement?.tagName === 'OL' ? `${[...n.parentElement.children].indexOf(n) + 1}. ` : '• ';
      n.childNodes.forEach(walk);
      if (isBlock && !out.endsWith('\n')) out += '\n';
    };
    root.childNodes.forEach(walk);
    return out.replace(/\n$/, '');
  }

  // Keep only safe tags and the few styles we create
  const OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'DIV', 'P', 'BR', 'UL', 'OL', 'LI', 'A', 'FONT']);
  const OK_STYLES = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line'];
  function sanitize(root) {
    const clone = root.cloneNode(true);
    const clean = (el) => {
      [...el.children].forEach((c) => {
        if (!OK_TAGS.has(c.tagName)) { c.replaceWith(...c.childNodes); return clean(el); }
        const keepStyle = OK_STYLES.map((p) => (c.style.getPropertyValue(p) ? `${p}:${c.style.getPropertyValue(p)}` : '')).filter(Boolean).join(';');
        const href = c.tagName === 'A' ? c.getAttribute('href') : '';
        const color = c.tagName === 'FONT' ? c.getAttribute('color') : '';
        const face = c.tagName === 'FONT' ? c.getAttribute('face') : '';
        [...c.attributes].forEach((a) => c.removeAttribute(a.name));
        if (keepStyle) c.setAttribute('style', keepStyle);
        if (href && /^(https?:|mailto:)/i.test(href)) { c.setAttribute('href', href); c.setAttribute('target', '_blank'); }
        if (color) c.setAttribute('color', color);
        if (face) c.setAttribute('face', face);
        clean(c);
      });
    };
    clean(clone);
    return clone.innerHTML;
  }

  function create(host, { placeholder = '', rows = 10 } = {}) {
    const root = host.getRootNode();
    // styles once per document / shadow root
    const styleHost = root.nodeType === 11 ? root : document.head;
    if (!styleHost.querySelector('style[data-pmr]')) {
      const st = document.createElement('style');
      st.dataset.pmr = '1';
      st.textContent = CSS;
      styleHost.appendChild(st);
    }
    host.classList.add('pmr');
    host.innerHTML = `
      <div class="pmr-bar">
        <button type="button" data-cmd="bold" title="Bold (⌘/Ctrl+B)"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic (⌘/Ctrl+I)"><i style="font-family:Georgia,serif">I</i></button>
        <button type="button" data-cmd="underline" title="Underline (⌘/Ctrl+U)"><u>U</u></button>
        <span class="pmr-sep"></span>
        <select data-font title="Font">${FONTS.map(([n, v]) => `<option value='${v}'>${n}</option>`).join('')}</select>
        <select data-size title="Size">${SIZES.map(([n, v]) => `<option value="${v}" ${v === '12px' ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button type="button" data-colorbtn title="Text colour">A<span class="pmr-color" style="background:#c62828;display:block"></span></button>
        <div class="pmr-pal" hidden>${COLORS.map((c) => `<button type="button" data-color="${c}" title="${c === '#073763' ? 'Dark blue (RGB 7, 55, 99)' : c}" style="background:${c}"></button>`).join('')}</div>
        <span class="pmr-sep"></span>
        <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">•≡</button>
        <button type="button" data-cmd="insertOrderedList" title="Numbered list">1≡</button>
        <button type="button" data-link title="Add link">🔗</button>
        <button type="button" data-cmd="removeFormat" title="Clear formatting">⨯</button>
      </div>
      <div class="pmr-ed" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true"></div>`;
    const ed = host.querySelector('.pmr-ed');
    const bar = host.querySelector('.pmr-bar');
    const pal = host.querySelector('.pmr-pal');
    ed.dataset.placeholder = placeholder;
    ed.style.minHeight = Math.round(rows * 21) + 'px';
    ed.style.maxHeight = '60vh';

    const getSel = () => (root.getSelection ? root.getSelection() : document.getSelection());
    let saved = null;
    const inside = (n) => n && (n === ed || ed.contains(n));
    const save = () => { const s = getSel(); if (s && s.rangeCount && inside(s.getRangeAt(0).commonAncestorContainer)) saved = s.getRangeAt(0).cloneRange(); };
    const restore = () => {
      ed.focus();
      const s = getSel();
      if (saved && s) { s.removeAllRanges(); s.addRange(saved); }
      else if (s && !inside(s.anchorNode)) { const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
    };
    ['keyup', 'mouseup', 'input', 'focus'].forEach((ev) => ed.addEventListener(ev, () => { save(); updateState(); }));
    document.addEventListener('selectionchange', save);
    const fire = () => ed.dispatchEvent(new Event('input', { bubbles: true }));
    const exec = (cmd, val, css = false) => {
      restore();
      document.execCommand('styleWithCSS', false, css);
      document.execCommand(cmd, false, val);
      save(); fire(); updateState();
    };
    function updateState() {
      bar.querySelectorAll('[data-cmd]').forEach((b) => {
        try { b.classList.toggle('on', ['bold', 'italic', 'underline'].includes(b.dataset.cmd) && document.queryCommandState(b.dataset.cmd)); } catch { /* ignore */ }
      });
    }
    // keep the text selection when clicking toolbar buttons
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => exec(b.dataset.cmd, null)));
    bar.querySelector('[data-font]').addEventListener('change', (e) => exec('fontName', e.target.value, true));
    bar.querySelector('[data-size]').addEventListener('change', (e) => {
      const px = e.target.value;
      exec('fontSize', '7');
      const made = [];
      ed.querySelectorAll('font[size="7"]').forEach((f) => { const s = document.createElement('span'); s.style.fontSize = px; s.append(...f.childNodes); f.replaceWith(s); made.push(s); });
      ed.querySelectorAll('span').forEach((s) => { if (s.style.fontSize === 'xxx-large' || s.style.fontSize === '-webkit-xxx-large') { s.style.fontSize = px; made.push(s); } });
      if (made.length) {
        // keep the same text selected so font / colour can be applied next
        const r = document.createRange();
        r.setStartBefore(made[0]); r.setEndAfter(made[made.length - 1]);
        const sel = getSel(); sel.removeAllRanges(); sel.addRange(r);
        saved = r.cloneRange();
      } else save();
      fire();
    });
    bar.querySelector('[data-colorbtn]').addEventListener('click', (e) => {
      pal.hidden = !pal.hidden;
      // keep the palette inside the box
      pal.style.left = Math.max(0, Math.min(e.currentTarget.offsetLeft, bar.clientWidth - pal.offsetWidth - 4)) + 'px';
    });
    pal.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
      pal.hidden = true;
      bar.querySelector('.pmr-color').style.background = b.dataset.color;
      exec('foreColor', b.dataset.color, true);
    }));
    bar.querySelector('[data-link]').addEventListener('click', () => {
      const url = prompt('Link address (https://…)');
      if (!url) return;
      const href = /^(https?:|mailto:)/i.test(url) ? url : 'https://' + url;
      const s = getSel();
      if (saved && !saved.collapsed) exec('createLink', href);
      else { restore(); document.execCommand('insertHTML', false, `<a href="${esc(href)}">${esc(url)}</a>`); save(); fire(); }
      if (s) s.collapseToEnd?.();
    });
    // paste as plain text so LinkedIn / Word styling doesn't come along
    ed.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
    host.addEventListener('keydown', (e) => { if (e.key === 'Escape') pal.hidden = true; });

    Object.defineProperty(ed, 'value', {
      get: () => toText(ed),
      set: (t) => { ed.innerHTML = t ? textToHtml(t) : ''; saved = null; },
    });
    Object.defineProperty(ed, 'html', { get: () => sanitize(ed) });
    ed.insertText = (t) => {
      restore();
      if (!document.execCommand('insertText', false, t)) {
        const s = getSel(); const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(t)); r.collapse(false);
      }
      save(); fire();
    };
    return ed;
  }

  // Wrap the message HTML for sending, adding the signature the same way withSignature does for text.
  function emailHtml(html, text, sig) {
    const s = (sig || '').trim();
    let h = (html || '').replace(/\{\{\s*signature\s*\}\}/gi, textToHtml(s));
    if (s && !(text || '').includes(s)) h += (/[,，]\s*$/.test(text || '') ? '<br>' : '<br><br>') + textToHtml(s);
    return `<div style="${BASE_STYLE}">${h}</div>`;
  }

  globalThis.PMRich = { create, emailHtml, toText, textToHtml, sanitize };
})();
