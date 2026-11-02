// Pitchbird: the bird logo, and the little bird that flies off when an email is sent.
// Classic script (works in the LinkedIn panel, the dashboard and the phone app): window.PBBird.
(function () {
  if (globalThis.PBBird) return;
  const PATH = 'M3 14.5c2.6.4 4.8-.2 6.6-1.7L5 5.2c3.6 1.2 6.4 3.7 8.2 6.8.9-2.5.7-5.3-.3-7.8 3 2 4.6 5.1 4.7 8.3l2-1.2c.9-.5 2.1-.3 2.7.5l.7 1-2 .6c-.6 3.7-3.9 6.4-7.8 6.4-3.2 0-6.6-1.6-10.2-4.8z';
  const svg = (size, fill = '#fff') => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="${fill}" d="${PATH}"/></svg>`;

  // Fly a bird from `fromEl` up and away to the top-right. `root` = document or a shadow root.
  function fly(fromEl, root = document) {
    try {
      if (globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const r = fromEl.getBoundingClientRect();
      const host = root.nodeType === 11 ? root : document.body;
      const wrap = document.createElement('div');
      const id = 'pbg' + Math.random().toString(36).slice(2, 7);
      wrap.style.cssText = `position:fixed;left:${r.left + r.width / 2 - 28}px;top:${r.top + r.height / 2 - 28}px;width:56px;height:56px;z-index:2147483647;pointer-events:none;`;
      wrap.innerHTML = `<svg viewBox="0 0 24 24" width="56" height="56" style="overflow:visible;filter:drop-shadow(0 4px 8px rgba(242,84,27,.35))"><defs><linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff7a1a"/><stop offset=".55" stop-color="#e2508f"/><stop offset="1" stop-color="#3461ff"/></linearGradient></defs><path fill="url(#${id})" d="${PATH}"/></svg>`;
      host.appendChild(wrap);
      const bird = wrap.firstChild;
      if (r.left > window.innerWidth / 2) bird.style.transform = 'scaleX(-1)';
      // fly up and across the page (towards whichever side has more room), then out of sight
      const room = r.left > window.innerWidth / 2 ? -1 : 1;
      const dx = room * Math.min(560, Math.max(260, (room < 0 ? r.left : window.innerWidth - r.right) - 40));
      const dy = -(r.top + 120);
      // the flight path: a little hop, then a curve up and away
      const flight = wrap.animate([
        { transform: 'translate(0,0) scale(.6) rotate(0deg)', opacity: 0 },
        { transform: 'translate(-6px,-26px) scale(1.05) rotate(-8deg)', opacity: 1, offset: 0.15 },
        { transform: `translate(${dx * 0.3}px,${dy * 0.25}px) scale(1.15) rotate(${room < 0 ? 8 : -14}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx * 0.7}px,${dy * 0.65}px) scale(1) rotate(${room < 0 ? 14 : -20}deg)`, opacity: 1, offset: 0.75 },
        { transform: `translate(${dx}px,${dy}px) scale(.7) rotate(${room < 0 ? 18 : -24}deg)`, opacity: 0 },
      ], { duration: 1900, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'forwards' });
      // wing flaps
      const flip = r.left > window.innerWidth / 2 ? 'scaleX(-1) ' : '';
      bird.animate([{ transform: flip + 'scaleY(1)' }, { transform: flip + 'scaleY(.55) translateY(4px)' }, { transform: flip + 'scaleY(1)' }], { duration: 230, iterations: 8, easing: 'ease-in-out' });
      // a few sparkles left behind
      for (let i = 0; i < 4; i++) {
        const dot = document.createElement('div');
        dot.style.cssText = `position:fixed;left:${r.left + r.width / 2 - 3 + (i - 1.5) * 9}px;top:${r.top + r.height / 2 - 3}px;width:6px;height:6px;border-radius:50%;background:${['#ff7a1a', '#e2508f', '#3461ff', '#ff9a3d'][i]};z-index:2147483646;pointer-events:none;`;
        host.appendChild(dot);
        dot.animate([{ transform: 'translate(0,0) scale(1)', opacity: 0.9 }, { transform: `translate(${(i - 1.5) * 14}px,${-30 - i * 8}px) scale(.2)`, opacity: 0 }], { duration: 700 + i * 120, delay: 120, easing: 'ease-out', fill: 'forwards' }).onfinish = () => dot.remove();
      }
      flight.onfinish = () => wrap.remove();
      setTimeout(() => wrap.remove(), 2800);
    } catch (e) { /* purely decorative */ }
  }

  globalThis.PBBird = { PATH, svg, fly };
})();
