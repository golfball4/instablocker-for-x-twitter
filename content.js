(() => {
  'use strict';

  // Public bearer token embedded in X's own web client (same for every user).
  const BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const BTN = 'instablock-btn';
  const HANDLE_RE = /^@([A-Za-z0-9_]{1,15})$/;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function makeIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '8.5');
    const slash = document.createElementNS(SVG_NS, 'path');
    slash.setAttribute('d', 'M6 6l12 12');
    svg.append(circle, slash);
    return svg;
  }

  const blocked = new Set(); // lowercase handles blocked this session

  // Firefox exposes content.fetch, which sends the request as the page itself
  // (same origin, page cookies). Fall back to plain fetch elsewhere.
  const pageFetch =
    typeof content !== 'undefined' && content.fetch
      ? content.fetch.bind(content)
      : window.fetch.bind(window);

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(selector, timeout = 2500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(50);
    }
    return null;
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function selfHandle() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = a && a.getAttribute('href');
    return href ? href.replace(/^\//, '').toLowerCase() : null;
  }

  function handleFrom(userNameEl) {
    for (const span of userNameEl.querySelectorAll('span')) {
      const m = span.textContent.trim().match(HANDLE_RE);
      if (m) return m[1];
    }
    return null;
  }

  // ---------- blocking ----------

  async function apiBlock(action, handle) {
    const csrf = csrfToken();
    if (!csrf) throw new Error('No ct0 cookie found; are you logged in?');

    const res = await pageFetch(`${location.origin}/i/api/1.1/blocks/${action}.json`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-csrf-token': csrf,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ screen_name: handle, skip_status: '1' }).toString(),
    });
    if (!res.ok) throw new Error(`blocks/${action} returned HTTP ${res.status}`);
    return res.json();
  }

  // Fallback for main posts: drive X's own "..." menu -> Block -> Confirm.
  async function menuBlock(caret) {
    caret.click();
    const item = await waitFor('[role="menu"] [data-testid="block"]');
    if (!item) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new Error('Block item not found in the post menu');
    }
    item.click();
    const confirm = await waitFor('[data-testid="confirmationSheetConfirm"]');
    if (!confirm) throw new Error('Block confirmation button not found');
    confirm.click();
  }

  // ---------- button ----------

  function syncButton(btn) {
    const handle = btn.dataset.handle;
    const isBlocked = blocked.has(handle.toLowerCase());
    btn.classList.toggle('ib-blocked', isBlocked);
    const label = isBlocked ? `Unblock @${handle}` : `Block @${handle}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function syncAll(key) {
    for (const btn of document.querySelectorAll(`.${BTN}`)) {
      if (btn.dataset.handle.toLowerCase() === key) syncButton(btn);
    }
  }

  function flashError(btn, err) {
    btn.classList.add('ib-error');
    btn.title = `Instablock failed: ${err.message}`;
    setTimeout(() => {
      btn.classList.remove('ib-error');
      syncButton(btn);
    }, 2500);
  }

  async function onClick(btn) {
    if (btn.dataset.busy) return;
    const handle = btn.dataset.handle;
    const key = handle.toLowerCase();
    const unblocking = blocked.has(key);

    btn.dataset.busy = '1';
    btn.classList.add('ib-busy');
    try {
      try {
        await apiBlock(unblocking ? 'destroy' : 'create', handle);
      } catch (err) {
        const caret =
          btn.dataset.kind === 'main' &&
          btn.closest('article')?.querySelector('[data-testid="caret"]');
        if (unblocking || !caret) throw err;
        console.warn('[Instablock] API block failed, using menu fallback:', err);
        await menuBlock(caret);
      }
      unblocking ? blocked.delete(key) : blocked.add(key);
      syncAll(key);
    } catch (err) {
      console.error('[Instablock]', err);
      flashError(btn, err);
    } finally {
      delete btn.dataset.busy;
      btn.classList.remove('ib-busy');
    }
  }

  function makeButton(handle, kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = kind === 'quote' ? `${BTN} ib-quote` : BTN;
    btn.dataset.handle = handle;
    btn.dataset.kind = kind;
    btn.appendChild(makeIcon());
    syncButton(btn);

    // Stop the click reaching X's handlers, which would open the post
    // (or the quoted post, since the whole quote card is a link).
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown']) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  // Place or refresh a button; X recycles DOM nodes, so fix stale handles.
  function ensure(existing, handle, create) {
    if (!existing) return create();
    if (existing.dataset.handle !== handle) {
      existing.dataset.handle = handle;
      syncButton(existing);
    }
  }

  // ---------- DOM scan ----------

  function processArticle(article, me) {
    let mainDone = false;

    for (const nameEl of article.querySelectorAll('[data-testid="User-Name"]')) {
      if (nameEl.closest('article') !== article) continue;

      const handle = handleFrom(nameEl);
      if (!handle || handle.toLowerCase() === me) continue;

      const linkWrap = nameEl.closest('div[role="link"]');
      const isQuote = !!(linkWrap && article.contains(linkWrap));

      if (isQuote) {
        ensure(nameEl.querySelector(`:scope > .${BTN}`), handle, () =>
          nameEl.appendChild(makeButton(handle, 'quote'))
        );
      } else if (!mainDone) {
        mainDone = true;
        const caret = article.querySelector('[data-testid="caret"]');
        const wrap = caret && caret.parentElement;
        if (!wrap) continue;
        // Live inside the caret's own wrapper, forced into a non-wrapping row,
        // so the button sits inline and doesn't push "..." onto a new line.
        wrap.classList.add('ib-host');
        wrap.parentElement?.classList.add('ib-row');
        ensure(wrap.querySelector(`:scope > .${BTN}`), handle, () =>
          wrap.insertBefore(makeButton(handle, 'main'), caret)
        );
      }
    }
  }

  let scheduled = false;
  function scan() {
    scheduled = false;
    const me = selfHandle();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      processArticle(article, me);
    }
  }

  new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(scan);
    }
  }).observe(document.body, { childList: true, subtree: true });

  scan();
})();
