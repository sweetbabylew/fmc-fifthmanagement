/* review-app.js — interactivity for the internal photo-review page.
 *
 * Copied verbatim to corporate/review/app.js by build-review.js. Plain ES5-ish
 * browser JS, no build step, no dependencies (same philosophy as the rest of
 * the repo). The page works without it — you just get a read-only gallery.
 *
 * What it adds:
 *   - a name box at the top (who is reviewing)
 *   - thumbs up / thumbs down / comment on every photo
 *   - everyone's marks visible on every card
 *   - filters, progress, "next unmarked", keyboard-driven lightbox
 *   - CSV download of all marks
 *
 * Saving: marks go into a local queue first (localStorage), then POST in
 * batches to the Worker (see worker/src/review.js). Nothing is lost if the
 * network drops or the tab closes mid-save — the queue is replayed on reload.
 */
(function () {
  "use strict";

  var body = document.body;
  var API = (body.getAttribute("data-api") || "").replace(/\/+$/, "");
  // Local preview: talk to `wrangler dev` instead of production. Override with
  // ?api=http://... on the URL for anything else.
  var qsApi = /[?&]api=([^&]+)/.exec(location.search);
  if (qsApi) API = decodeURIComponent(qsApi[1]).replace(/\/+$/, "");
  else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname)) API = "http://127.0.0.1:8787";

  var LS = {
    name: "fmcReview.name",
    queue: "fmcReview.queue",
    recent: "fmcReview.recent",
    filter: "fmcReview.filter",
  };

  var cards = [].slice.call(document.querySelectorAll(".card[data-pid]"));
  if (!cards.length) return;

  var byPid = {};
  cards.forEach(function (c) { byPid[c.dataset.pid] = c; });

  var state = {
    name: load(LS.name, ""),
    id: "",
    mine: {},    // pid -> {vote, comment}   (what I believe my marks are)
    peers: {},   // pid -> [{id,name,vote,comment,at}]  (everyone, from the server)
    queue: loadJson(LS.queue, {}), // pid -> {vote, comment} not yet acknowledged
    // Marks the server has accepted in the last couple of minutes. KV is
    // eventually consistent, so a poll (or a reload) right after a save can
    // still answer with the old value; without this the thumb you just clicked
    // would flicker off. Persisted, because the reload case is the visible one.
    recent: loadJson(LS.recent, {}), // pid -> {vote, comment, at:<ms>}
    filter: load(LS.filter, "all"),
  };
  state.id = slug(state.name);
  var RECENT_MS = 120000;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function load(k, dflt) { try { var v = localStorage.getItem(k); return v === null ? dflt : v; } catch (e) { return dflt; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function loadJson(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) || dflt; } catch (e) { return dflt; } }
  function saveJson(k, v) { save(k, JSON.stringify(v)); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  // Two characters, so Lewis and Lauren don't both read as "L".
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length > 1) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    return parts[0].charAt(0).toUpperCase() + (parts[0].charAt(1) || "").toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Top bar
  // ---------------------------------------------------------------------------
  var bar = el("div", "mebar");
  bar.innerHTML =
    '<div class="me-who">' +
    '<label for="me-name">You are</label>' +
    '<input id="me-name" type="text" autocomplete="given-name" spellcheck="false" placeholder="your name" maxlength="40">' +
    "</div>" +
    '<div class="me-progress"><span id="me-count">0</span> of ' + cards.length + " marked" +
    '<span class="me-bar"><i id="me-fill"></i></span></div>' +
    '<div class="me-filters" id="me-filters">' +
    chip("all", "All") +
    chip("unmarked", "Not marked by me") +
    chip("mine-up", "My 👍") +
    chip("mine-down", "My 👎") +
    chip("any-down", "Any 👎") +
    chip("commented", "Commented") +
    chip("disagree", "Disagreements") +
    "</div>" +
    '<div class="me-actions">' +
    '<button type="button" id="me-next" class="btn">Next unmarked →</button>' +
    '<a id="me-csv" class="btn ghost" href="#">Download CSV</a>' +
    '<span id="me-status" class="status">…</span>' +
    "</div>";

  function chip(key, label) {
    return '<button type="button" class="fchip" data-filter="' + key + '">' + label + "</button>";
  }

  var nav = document.querySelector("nav");
  nav.parentNode.insertBefore(bar, nav.nextSibling);

  var nameInput = document.getElementById("me-name");
  var statusEl = document.getElementById("me-status");
  var countEl = document.getElementById("me-count");
  var fillEl = document.getElementById("me-fill");
  nameInput.value = state.name;
  document.getElementById("me-csv").href = API + "/review/export.csv";

  nameInput.addEventListener("change", onNameChange);
  nameInput.addEventListener("blur", onNameChange);
  function onNameChange() {
    var next = nameInput.value.trim().slice(0, 40);
    if (next === state.name) return;
    // Save anything outstanding under the name it was marked with, and clear it
    // on success — otherwise handing the laptop over would re-file the previous
    // person's unsaved marks under the new name.
    if (state.id && Object.keys(state.queue).length) flush(false, state.name);
    state.name = next;
    state.id = slug(next);
    save(LS.name, next);
    rebuildMineFromPeers();
    renderAll();
    setStatus(next ? "Reviewing as " + next : "Add your name to start marking", next ? "ok" : "warn");
  }

  document.getElementById("me-filters").addEventListener("click", function (e) {
    var b = e.target.closest(".fchip");
    if (!b) return;
    state.filter = b.dataset.filter;
    save(LS.filter, state.filter);
    applyFilter();
  });

  document.getElementById("me-next").addEventListener("click", function () {
    var next = visibleCards().filter(function (c) { return !state.mine[c.dataset.pid]; })[0] ||
               cards.filter(function (c) { return !state.mine[c.dataset.pid]; })[0];
    if (!next) return setStatus("Everything is marked 🎉", "ok");
    next.scrollIntoView({ behavior: "smooth", block: "center" });
    openLightbox(next);
  });

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "status " + (kind || "");
  }

  // ---------------------------------------------------------------------------
  // Per-card controls
  // ---------------------------------------------------------------------------
  cards.forEach(function (card) {
    var tools = el("div", "tools");
    tools.innerHTML =
      '<button type="button" class="tbtn up" data-act="up" title="Thumbs up">👍</button>' +
      '<button type="button" class="tbtn down" data-act="down" title="Thumbs down">👎</button>' +
      '<button type="button" class="tbtn note" data-act="note" title="Add a comment">💬</button>' +
      '<span class="peers"></span>';
    var box = el("div", "notebox");
    box.innerHTML = '<textarea rows="2" maxlength="1000" placeholder="Comment (saved automatically)"></textarea>';
    card.appendChild(tools);
    card.appendChild(box);

    tools.addEventListener("click", function (e) {
      var b = e.target.closest(".tbtn");
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === "note") return toggleNote(card, true);
      setVote(card.dataset.pid, b.dataset.act);
    });

    var ta = box.querySelector("textarea");
    ta.addEventListener("click", function (e) { e.stopPropagation(); });
    ta.addEventListener("input", function () { setComment(card.dataset.pid, ta.value, true); });
    ta.addEventListener("blur", function () { if (!ta.value.trim()) box.classList.remove("open"); });
  });

  function toggleNote(card, focus) {
    var box = card.querySelector(".notebox");
    box.classList.toggle("open");
    if (focus && box.classList.contains("open")) box.querySelector("textarea").focus();
  }

  // ---------------------------------------------------------------------------
  // Marking
  // ---------------------------------------------------------------------------
  function requireName() {
    if (state.id) return true;
    nameInput.focus();
    nameInput.classList.add("shake");
    setTimeout(function () { nameInput.classList.remove("shake"); }, 600);
    setStatus("Put your name in first — marks are saved under it", "warn");
    return false;
  }

  function setVote(pid, vote) {
    if (!requireName()) return;
    var cur = state.mine[pid] || { vote: null, comment: "" };
    var next = cur.vote === vote ? null : vote; // clicking the same thumb clears it
    writeMark(pid, { vote: next, comment: cur.comment || "" });
  }

  function setComment(pid, text, debounced) {
    if (!requireName()) return;
    var cur = state.mine[pid] || { vote: null, comment: "" };
    writeMark(pid, { vote: cur.vote || null, comment: text }, debounced);
  }

  function writeMark(pid, mark, debounced) {
    state.mine[pid] = { vote: mark.vote || null, comment: mark.comment || "" };
    if (!state.mine[pid].vote && !state.mine[pid].comment) delete state.mine[pid];
    state.queue[pid] = { vote: mark.vote || null, comment: mark.comment || "" };
    saveJson(LS.queue, state.queue);
    renderCard(pid);
    renderProgress();
    if (lb.pid === pid) renderLightbox();
    scheduleFlush(debounced ? 900 : 250);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderCard(pid) {
    var card = byPid[pid];
    if (!card) return;
    var mine = state.mine[pid] || {};
    var tools = card.querySelector(".tools");
    tools.querySelector(".up").classList.toggle("on", mine.vote === "up");
    tools.querySelector(".down").classList.toggle("on", mine.vote === "down");
    tools.querySelector(".note").classList.toggle("on", !!mine.comment);

    var box = card.querySelector(".notebox");
    var ta = box.querySelector("textarea");
    if (document.activeElement !== ta && ta.value !== (mine.comment || "")) ta.value = mine.comment || "";
    if (mine.comment) box.classList.add("open");

    var others = (state.peers[pid] || []).filter(function (m) { return m.id !== state.id; });
    tools.querySelector(".peers").innerHTML = others
      .map(function (m) {
        var t = m.name + (m.vote === "up" ? " 👍" : m.vote === "down" ? " 👎" : "") +
                (m.comment ? ": " + m.comment : "");
        return '<span class="peer ' + (m.vote || "none") + '" title="' + esc(t) + '">' + esc(initials(m.name)) + "</span>";
      })
      .join("");

    var notes = card.querySelector(".peernotes");
    var withComments = others.filter(function (m) { return m.comment; });
    if (withComments.length) {
      if (!notes) { notes = el("div", "peernotes"); card.appendChild(notes); }
      notes.innerHTML = withComments
        .map(function (m) { return "<b>" + esc(m.name) + ":</b> " + esc(m.comment); })
        .join("<br>");
    } else if (notes) {
      notes.remove();
    }

    card.classList.toggle("pending", Object.prototype.hasOwnProperty.call(state.queue, pid));
    card.classList.toggle("mine-up", mine.vote === "up");
    card.classList.toggle("mine-down", mine.vote === "down");
  }

  function renderAll() {
    cards.forEach(function (c) { renderCard(c.dataset.pid); });
    renderProgress();
    applyFilter();
  }

  // Section card lists and their badges are fixed for the life of the page —
  // resolve them once, since renderProgress runs on every keystroke in a comment.
  var sectionInfo = [].slice.call(document.querySelectorAll("section[id]")).map(function (sec) {
    var badge = el("span", "secprog");
    var h2 = sec.querySelector("h2");
    if (h2) h2.appendChild(badge);
    return { sec: sec, badge: badge, cards: [].slice.call(sec.querySelectorAll(".card[data-pid]")) };
  });

  function renderProgress() {
    var n = cards.filter(function (c) { return state.mine[c.dataset.pid]; }).length;
    countEl.textContent = n;
    fillEl.style.width = Math.round((n / cards.length) * 100) + "%";
    sectionInfo.forEach(function (s) {
      var done = s.cards.filter(function (c) { return state.mine[c.dataset.pid]; }).length;
      s.badge.textContent = done + "/" + s.cards.length + " marked";
      s.badge.classList.toggle("done", done === s.cards.length && s.cards.length > 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  function matches(card) {
    var pid = card.dataset.pid;
    var mine = state.mine[pid];
    var all = state.peers[pid] || [];
    switch (state.filter) {
      case "unmarked": return !mine;
      case "mine-up": return !!mine && mine.vote === "up";
      case "mine-down": return !!mine && mine.vote === "down";
      case "any-down": return all.some(function (m) { return m.vote === "down"; }) || (mine && mine.vote === "down");
      case "commented": return all.some(function (m) { return m.comment; }) || (mine && mine.comment);
      case "disagree":
        var votes = all.map(function (m) { return m.vote; }).filter(Boolean);
        if (mine && mine.vote) votes.push(mine.vote);
        return votes.indexOf("up") > -1 && votes.indexOf("down") > -1;
      default: return true;
    }
  }

  function applyFilter() {
    document.querySelectorAll(".fchip").forEach(function (b) {
      b.classList.toggle("on", b.dataset.filter === state.filter);
    });
    cards.forEach(function (c) { c.classList.toggle("hide", !matches(c)); });
    sectionInfo.forEach(function (s) {
      s.sec.classList.toggle("hide", !s.cards.some(function (c) { return !c.classList.contains("hide"); }));
    });
    // Never talk over a save that hasn't landed yet.
    if (state.filter !== "all" && !Object.keys(state.queue).length) {
      var shown = visibleCards().length;
      setStatus(shown + " photo" + (shown === 1 ? "" : "s") + " match this filter", "");
    }
  }

  function visibleCards() {
    return cards.filter(function (c) { return !c.classList.contains("hide"); });
  }

  // ---------------------------------------------------------------------------
  // Lightbox — click a photo, then work through them with the keyboard
  // ---------------------------------------------------------------------------
  var lbEl = document.getElementById("lb");
  var lbImg = lbEl.querySelector("img");
  var lbMeta = lbEl.querySelector(".meta");
  var lbTools = el("div", "lbtools");
  lbTools.innerHTML =
    '<button type="button" class="lbnav" data-act="prev" title="Previous (←)">‹</button>' +
    '<button type="button" class="tbtn up" data-act="up" title="Thumbs up (u)">👍</button>' +
    '<button type="button" class="tbtn down" data-act="down" title="Thumbs down (d)">👎</button>' +
    '<button type="button" class="lbnav" data-act="next" title="Next (→)">›</button>';
  var lbNote = el("div", "lbnote");
  lbNote.innerHTML = '<textarea rows="2" maxlength="1000" placeholder="Comment (saved automatically)"></textarea>';
  lbEl.appendChild(lbTools);
  lbEl.appendChild(lbNote);
  var lbTa = lbNote.querySelector("textarea");
  var lb = { pid: null, list: [] };

  lbTools.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.act === "prev") return step(-1);
    if (b.dataset.act === "next") return step(1);
    setVote(lb.pid, b.dataset.act);
  });
  lbNote.addEventListener("click", function (e) { e.stopPropagation(); });
  lbTa.addEventListener("input", function () { setComment(lb.pid, lbTa.value, true); });

  cards.forEach(function (card) {
    card.addEventListener("click", function (e) {
      if (e.target.closest(".tools") || e.target.closest(".notebox")) return;
      openLightbox(card);
    });
  });

  function openLightbox(card) {
    lb.list = visibleCards();
    if (lb.list.indexOf(card) < 0) lb.list = cards;
    lb.pid = card.dataset.pid;
    lbEl.classList.add("open");
    renderLightbox();
  }

  function step(delta) {
    var i = lb.list.map(function (c) { return c.dataset.pid; }).indexOf(lb.pid);
    var next = lb.list[i + delta];
    if (!next) return;
    lb.pid = next.dataset.pid;
    next.scrollIntoView({ block: "center" });
    renderLightbox();
  }

  function renderLightbox() {
    var card = byPid[lb.pid];
    if (!card) return;
    lbImg.src = card.dataset.full;
    lbImg.alt = card.dataset.name;

    var cls = card.classList.contains("keep") ? "k"
      : card.classList.contains("reject") ? "r"
      : card.classList.contains("ai") ? "a"
      : card.classList.contains("gap") ? "g" : "h";
    var i = lb.list.map(function (c) { return c.dataset.pid; }).indexOf(lb.pid);
    var others = (state.peers[lb.pid] || []).filter(function (m) { return m.id !== state.id; });
    var peerHtml = others.length
      ? '<div class="lbpeers">' + others.map(function (m) {
          return "<span>" + esc(m.name) + " " +
            (m.vote === "up" ? "👍" : m.vote === "down" ? "👎" : "—") +
            (m.comment ? " " + esc(m.comment) : "") + "</span>";
        }).join("") + "</div>"
      : "";

    lbMeta.innerHTML =
      '<b class="' + cls + '">' + esc(card.dataset.verdict) + "</b> — " + esc(card.dataset.name) +
      " · " + esc(card.dataset.source) +
      (i > -1 ? ' <span class="lbpos">' + (i + 1) + " of " + lb.list.length + "</span>" : "") +
      "<br>" + esc(card.dataset.reason) + peerHtml;

    var mine = state.mine[lb.pid] || {};
    lbTools.querySelector(".up").classList.toggle("on", mine.vote === "up");
    lbTools.querySelector(".down").classList.toggle("on", mine.vote === "down");
    if (document.activeElement !== lbTa) lbTa.value = mine.comment || "";
  }

  function closeLightbox() { lbEl.classList.remove("open"); lbImg.src = ""; lb.pid = null; }

  lbEl.addEventListener("click", function (e) {
    if (e.target === lbEl || e.target.classList.contains("x")) closeLightbox();
  });

  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test((e.target.tagName || "").toUpperCase());
    if (e.key === "Escape") {
      if (typing) return e.target.blur();
      return closeLightbox();
    }
    if (typing || !lbEl.classList.contains("open")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "u" || e.key === "U") { setVote(lb.pid, "up"); step(1); }
    else if (e.key === "d" || e.key === "D") { setVote(lb.pid, "down"); step(1); }
    else if (e.key === "c" || e.key === "C") { e.preventDefault(); lbTa.focus(); }
  });

  // ---------------------------------------------------------------------------
  // Sync with the Worker
  // ---------------------------------------------------------------------------
  var flushTimer = null;
  var inFlight = false;
  var backoff = 0;

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
    setStatus("Saving…", "busy");
  }

  // 50 marks × a 1000-char comment stays well inside the Worker's body cap, so a
  // big backlog can never wedge itself into a permanent 413 retry loop.
  var BATCH = 50;

  function flush(sync, asName) {
    clearTimeout(flushTimer);
    var pids = Object.keys(state.queue);
    if (!pids.length) { setStatus(state.name ? "All saved" : "Add your name to start marking", state.name ? "ok" : "warn"); return; }
    if (!state.id) { setStatus("Put your name in first", "warn"); return; }
    if (inFlight && !sync) return;

    var who = asName || state.name;
    var batch = pids.slice(0, BATCH);
    var sent = {};
    var updates = batch.map(function (pid) {
      var m = state.queue[pid];
      sent[pid] = JSON.stringify(m);
      return { photo: pid, vote: m.vote, comment: m.comment };
    });
    var payload = JSON.stringify({ reviewer: who, updates: updates });

    // Tab closing: hand the batch to the browser to deliver in the background.
    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon(API + "/review/feedback", new Blob([payload], { type: "application/json" }));
      return;
    }

    inFlight = true;
    var status = 0;
    fetch(API + "/review/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
      .then(function (r) { status = r.status; return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        inFlight = false;
        if (!res || !res.ok) throw new Error((res && res.message) || "save failed");
        backoff = 0;
        var now = Date.now();
        // Only clear entries the user has not changed since this request left.
        batch.forEach(function (pid) {
          if (JSON.stringify(state.queue[pid]) !== sent[pid]) return;
          delete state.queue[pid];
          var m = state.mine[pid];
          state.recent[pid] = { who: slug(who), vote: (m && m.vote) || null, comment: (m && m.comment) || "", at: now };
        });
        saveJson(LS.queue, state.queue);
        saveJson(LS.recent, state.recent);
        batch.forEach(applyMineToPeers);
        setStatus(Object.keys(state.queue).length ? "Saving…" : "All saved", Object.keys(state.queue).length ? "busy" : "ok");
        if (Object.keys(state.queue).length) scheduleFlush(300);
      })
      .catch(function (err) {
        inFlight = false;
        console.warn("review save failed:", err && err.message);
        // 4xx means this batch will never be accepted (bad name, bad photo id,
        // too big). Retrying it forever would also block everything behind it,
        // so drop it and say so rather than spinning.
        if (status >= 400 && status < 500 && status !== 429) {
          batch.forEach(function (pid) { delete state.queue[pid]; });
          saveJson(LS.queue, state.queue);
          setStatus((err && err.message) || "That mark was refused", "warn");
          if (Object.keys(state.queue).length) scheduleFlush(500);
          return;
        }
        backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
        setStatus("Not saved yet — retrying (" + Object.keys(state.queue).length + " waiting)", "warn");
        flushTimer = setTimeout(flush, backoff);
      });
  }

  // Show my own just-saved mark in the shared view without waiting for a poll.
  function applyMineToPeers(pid) {
    var mine = state.mine[pid];
    var list = (state.peers[pid] || []).filter(function (m) { return m.id !== state.id; });
    if (mine) list.push({ id: state.id, name: state.name, vote: mine.vote, comment: mine.comment, at: "" });
    state.peers[pid] = list;
    renderCard(pid);
  }

  function pull() {
    return fetch(API + "/review/feedback", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.message) || "load failed");
        state.peers = res.feedback || {};
        rebuildMineFromPeers();
        Object.keys(state.recent).forEach(function (pid) {
          if (state.recent[pid] && state.recent[pid].who === state.id) applyMineToPeers(pid);
        });
        renderAll();
        // Don't paper over a failing save with a cheerful roll-call.
        if (Object.keys(state.queue).length) return;
        var who = (res.reviewers || []).filter(function (r) { return r.marks; })
          .map(function (r) { return r.name + " (" + r.marks + ")"; }).join(", ");
        setStatus(who ? "Reviewing: " + who : (state.name ? "All saved" : "Add your name to start marking"),
                  state.name || who ? "ok" : "warn");
      })
      .catch(function (err) {
        setStatus("Working offline — your marks are held in this browser", "warn");
        console.warn("review load failed:", err && err.message);
        renderAll();
      });
  }

  // Server truth for me, then anything the server has accepted too recently to
  // be certain of reading back, then the not-yet-saved queue on top of that.
  function rebuildMineFromPeers() {
    state.mine = {};
    if (!state.id) return;
    Object.keys(state.peers).forEach(function (pid) {
      (state.peers[pid] || []).forEach(function (m) {
        if (m.id === state.id) state.mine[pid] = { vote: m.vote || null, comment: m.comment || "" };
      });
    });
    var cutoff = Date.now() - RECENT_MS;
    var pruned = false;
    Object.keys(state.recent).forEach(function (pid) {
      var r = state.recent[pid];
      if (!r || r.at < cutoff) { delete state.recent[pid]; pruned = true; return; }
      if (r.who !== state.id) return; // someone else's recent save, not mine
      if (!r.vote && !r.comment) delete state.mine[pid];
      else state.mine[pid] = { vote: r.vote, comment: r.comment };
    });
    if (pruned) saveJson(LS.recent, state.recent);
    Object.keys(state.queue).forEach(function (pid) {
      var q = state.queue[pid];
      if (!q.vote && !q.comment) delete state.mine[pid];
      else state.mine[pid] = { vote: q.vote || null, comment: q.comment || "" };
    });
  }

  window.addEventListener("beforeunload", function () {
    if (Object.keys(state.queue).length) flush(true);
  });
  window.addEventListener("online", function () { backoff = 0; scheduleFlush(200); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") pull();
  });
  setInterval(function () { if (document.visibilityState === "visible" && !inFlight) pull(); }, 60000);

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------
  applyFilter();
  pull().then(function () {
    if (Object.keys(state.queue).length) scheduleFlush(500);
    if (!state.name) nameInput.focus();
  });
})();
