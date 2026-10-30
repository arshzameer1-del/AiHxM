// AiHxM site behaviour. No dependencies, no cookies, no analytics. Everything here improves a page that already works
// without it: menus fall back to CSS, tabs and filters show all content, forms are validated again by the server.
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };

  /* ---------- header: scrolled state ---------- */
  var header = $("#site-header");
  function onScroll() { if (header) header.classList.toggle("scrolled", window.scrollY > 8); }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- mega menus ---------- */
  var items = $$(".has-mega");
  var closeTimer = null;
  function setOpen(li, open) {
    var b = $(".nav-link", li);
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
    li.classList.toggle("open", open);
  }
  function closeAll(except) { items.forEach(function (li) { if (li !== except) setOpen(li, false); }); }
  items.forEach(function (li) {
    var b = $(".nav-link", li);
    b.addEventListener("click", function () {
      // A pointer that just opened the menu by hovering must not close it again with the click that follows.
      if (b.getAttribute("aria-expanded") === "true" && li._hoverAt && Date.now() - li._hoverAt < 600) return;
      var willOpen = b.getAttribute("aria-expanded") !== "true";
      closeAll(li);
      setOpen(li, willOpen);
    });
    if (finePointer) {
      li.addEventListener("pointerenter", function () { clearTimeout(closeTimer); closeAll(li); li._hoverAt = Date.now(); setOpen(li, true); });
      li.addEventListener("pointerleave", function () { closeTimer = setTimeout(function () { setOpen(li, false); }, 140); });
    }
    li.addEventListener("focusout", function (e) { if (!li.contains(e.relatedTarget)) setOpen(li, false); });
  });
  doc.addEventListener("click", function (e) { if (!e.target.closest(".has-mega")) closeAll(); });
  doc.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var openLi = items.filter(function (li) { return li.classList.contains("open"); })[0];
    if (openLi) { setOpen(openLi, false); $(".nav-link", openLi).focus(); }
    if (header && header.classList.contains("nav-open")) toggleMobile(false);
  });

  /* ---------- mobile menu ---------- */
  var menuBtn = $("#menu-toggle");
  function toggleMobile(open) {
    if (!header || !menuBtn) return;
    header.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    root.classList.toggle("no-scroll", open);
  }
  if (menuBtn) menuBtn.addEventListener("click", function () { toggleMobile(!header.classList.contains("nav-open")); });
  $$("#mobile-nav a").forEach(function (a) { a.addEventListener("click", function () { toggleMobile(false); }); });

  /* ---------- site search ---------- */
  var dlg = $("#search-dialog");
  var openBtn = $("#search-open");
  var input = $("#search-input");
  var results = $("#search-results");
  var index = null;
  function loadIndex(cb) {
    if (index) return cb();
    fetch("/search-index.json").then(function (r) { return r.json(); }).then(function (j) { index = j; cb(); }).catch(function () { index = []; cb(); });
  }
  function render(q) {
    q = q.trim().toLowerCase();
    results.innerHTML = "";
    var list = index;
    if (q) {
      var terms = q.split(/\s+/);
      list = index.map(function (x) {
        var hay = (x.t + " " + x.d + " " + x.k).toLowerCase();
        var score = 0;
        for (var i = 0; i < terms.length; i++) {
          if (hay.indexOf(terms[i]) < 0) return null;
          score += x.t.toLowerCase().indexOf(terms[i]) >= 0 ? 3 : 1;
        }
        return { x: x, s: score };
      }).filter(Boolean).sort(function (a, b) { return b.s - a.s; }).map(function (r) { return r.x; });
    } else {
      list = index.filter(function (x) { return x.k === "Product"; }).slice(0, 8);
    }
    if (!list.length) {
      var li = doc.createElement("li");
      li.className = "none";
      li.textContent = "Nothing matches that. Try a module name such as payroll, leave or attendance.";
      results.appendChild(li);
      return;
    }
    list.slice(0, 10).forEach(function (x) {
      var li = doc.createElement("li");
      var a = doc.createElement("a");
      a.href = x.u;
      var k = doc.createElement("span");
      k.className = "sr-kind";
      k.textContent = x.k;
      var t = doc.createElement("strong");
      t.textContent = x.t;
      var d = doc.createElement("small");
      d.textContent = x.d.length > 110 ? x.d.slice(0, 107) + "…" : x.d;
      a.appendChild(k); a.appendChild(t); a.appendChild(d);
      li.appendChild(a);
      results.appendChild(li);
    });
  }
  function openSearch() {
    if (!dlg || typeof dlg.showModal !== "function") { location.href = "/platform/"; return; }
    if (!dlg.open) dlg.showModal();
    loadIndex(function () { render(input.value); });
    input.focus();
  }
  if (openBtn) openBtn.addEventListener("click", openSearch);
  if (input) input.addEventListener("input", function () { loadIndex(function () { render(input.value); }); });
  if (input) input.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); dlg.close(); } });
  if (dlg) dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  doc.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
    if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); openSearch(); }
  });

  /* ---------- reveal on scroll ---------- */
  // Content is visible at rest. Only elements below the first screen are hidden, and only once this script runs.
  var animHosts = $$(".reveal, .stage, .life-wrap, .hero-visual, .pay-visual, .big-ico, .cta-band");
  var vh = window.innerHeight || 800;
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.remove("pre");
        en.target.classList.add("in");
        io.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    animHosts.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top > vh * 0.92) { if (el.classList.contains("reveal")) el.classList.add("pre"); io.observe(el); }
      else el.classList.add("in");
    });
  } else {
    animHosts.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- tabs (lifecycle and payroll) ---------- */
  $$("[data-tabs]").forEach(function (wrap) {
    var tabs = $$('[role="tab"]', wrap);
    var panels = $$('[role="tabpanel"]', wrap);
    function select(i, focus) {
      tabs.forEach(function (t, k) {
        var on = k === i;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        t.classList.toggle("on", on);
        if (panels[k]) panels[k].hidden = !on;
      });
      wrap.style.setProperty("--p", ((i + 0.5) / tabs.length).toFixed(3));
      if (focus) tabs[i].focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(i); });
      t.addEventListener("keydown", function (e) {
        var n = tabs.length;
        var k = e.key;
        if (k === "ArrowRight" || k === "ArrowDown") { e.preventDefault(); select((i + 1) % n, true); }
        else if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); select((i + n - 1) % n, true); }
        else if (k === "Home") { e.preventDefault(); select(0, true); }
        else if (k === "End") { e.preventDefault(); select(n - 1, true); }
      });
    });
    select(0);
  });
  // The payroll tabs sit in a plain container (not the wrap), so wire them explicitly as well.
  $$(".pay-tabs[data-tabs]").forEach(function (tabsEl) {
    var host = tabsEl.parentNode;
    var tabs = $$('[role="tab"]', tabsEl);
    var panels = $$('[role="tabpanel"]', host);
    function select(i, focus) {
      tabs.forEach(function (t, k) {
        var on = k === i;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        t.classList.toggle("on", on);
        if (panels[k]) panels[k].hidden = !on;
      });
      if (focus) tabs[i].focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(i); });
      t.addEventListener("keydown", function (e) {
        var n = tabs.length;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select((i + 1) % n, true); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select((i + n - 1) % n, true); }
      });
    });
    select(0);
  });

  /* ---------- module filter ---------- */
  var filters = $$(".filter");
  var mods = $$(".mods .mod");
  filters.forEach(function (f) {
    f.addEventListener("click", function () {
      var g = f.getAttribute("data-filter");
      filters.forEach(function (x) { var on = x === f; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on ? "true" : "false"); });
      mods.forEach(function (m) { m.hidden = !(g === "All" || m.getAttribute("data-group") === g); });
    });
  });

  /* ---------- counters ---------- */
  var counters = $$("[data-count]");
  function runCounter(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var prefix = el.getAttribute("data-prefix") || "";
    var start = null;
    var dur = 1100;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = prefix + Math.round(target * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  if (counters.length && "IntersectionObserver" in window && !reduced) {
    var co = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { runCounter(en.target); co.unobserve(en.target); } });
    }, { threshold: 0.6 });
    counters.forEach(function (c) { co.observe(c); });
  }

  /* ---------- subtle tilt and parallax (fine pointers only) ---------- */
  if (finePointer && !reduced) {
    $$(".tilt").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty("--ry", (x * 5).toFixed(2) + "deg");
        card.style.setProperty("--rx", (-y * 5).toFixed(2) + "deg");
        card.style.setProperty("--mx", ((x + 0.5) * 100).toFixed(0) + "%");
        card.style.setProperty("--my", ((y + 0.5) * 100).toFixed(0) + "%");
      });
      card.addEventListener("pointerleave", function () { card.style.removeProperty("--ry"); card.style.removeProperty("--rx"); });
    });
    $$("[data-parallax]").forEach(function (stage) {
      var layers = $$("[data-depth]", stage);
      var raf = 0;
      stage.addEventListener("pointermove", function (e) {
        var r = stage.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () {
          layers.forEach(function (l) {
            var d = parseFloat(l.getAttribute("data-depth")) / 10;
            l.style.setProperty("--px", (x * d * -2).toFixed(1) + "px");
            l.style.setProperty("--py", (y * d * -2).toFixed(1) + "px");
          });
        });
      });
      stage.addEventListener("pointerleave", function () { layers.forEach(function (l) { l.style.removeProperty("--px"); l.style.removeProperty("--py"); }); });
    });
  }

  /* ---------- article table of contents ---------- */
  var toc = $$(".toc a");
  if (toc.length && "IntersectionObserver" in window) {
    var map = {};
    toc.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          toc.forEach(function (a) { a.removeAttribute("aria-current"); });
          var a = map[en.target.id];
          if (a) a.setAttribute("aria-current", "true");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    $$(".prose h2[id]").forEach(function (h) { so.observe(h); });
  }

  /* ---------- lead form (demo, contact, consultation) ---------- */
  var form = $("#lead-form");
  if (!form) return;
  var api = form.getAttribute("data-api");
  var contact = form.getAttribute("data-contact") || "";
  var kind = form.getAttribute("data-kind") || "demo";
  var statusEl = $("#form-status");
  var done = $("#form-done");
  var submit = $("#form-submit");
  var params = new URLSearchParams(location.search);

  if (kind === "demo" && params.get("type") === "consultation") {
    kind = "consultation";
    submit.textContent = "Request consultation";
    var h = $("#form-title");
    if (h) h.textContent = "Request a consultation";
  }
  params.getAll("interest").forEach(function (v) {
    var box = form.querySelector('input[name="interests"][value="' + v.replace(/[^a-z-]/g, "") + '"]');
    if (box) box.checked = true;
  });

  function setInvalid(name, bad) {
    var el = form.querySelector('[data-field="' + name + '"]');
    if (!el) return;
    var ctl = el.querySelector("input,select,textarea");
    if (bad) { el.setAttribute("data-invalid", ""); if (ctl) { ctl.setAttribute("aria-invalid", "true"); ctl.setAttribute("aria-describedby", "e-" + name); } }
    else { el.removeAttribute("data-invalid"); if (ctl) { ctl.removeAttribute("aria-invalid"); ctl.removeAttribute("aria-describedby"); } }
  }
  function show(type, html) {
    statusEl.className = "form-status show " + type;
    statusEl.innerHTML = html;
    statusEl.focus();
  }
  function validate() {
    var v = {
      fullName: form.fullName.value.trim(),
      workEmail: form.workEmail.value.trim(),
      companyName: form.companyName.value.trim(),
      phone: form.phone.value.trim(),
    };
    var bad = {
      fullName: v.fullName.length < 2,
      workEmail: !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.workEmail),
      companyName: v.companyName.length < 2,
      phone: v.phone !== "" && !/^[0-9+()\-\s]{6,25}$/.test(v.phone),
      consentPrivacy: !form.consentPrivacy.checked,
    };
    var first = null;
    Object.keys(bad).forEach(function (k) { setInvalid(k, bad[k]); if (bad[k] && !first) first = k; });
    if (first) { var el = form.elements[first]; if (el && el.focus) el.focus(); return null; }
    return v;
  }
  ["fullName", "workEmail", "companyName", "phone", "consentPrivacy"].forEach(function (n) {
    var el = form.elements[n];
    if (el) el.addEventListener("input", function () { setInvalid(n, false); });
    if (el && n === "consentPrivacy") el.addEventListener("change", function () { setInvalid(n, false); });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    statusEl.className = "form-status";
    var v = validate();
    if (!v) return;

    var interests = $$('input[name="interests"]:checked', form).map(function (c) { return c.value; });
    var extra = $$('input[name="extra"]:checked', form).map(function (c) { return c.value; });
    var method = ($('input[name="method"]:checked', form) || {}).value || "";
    var lines = ["Request type: " + { demo: "Demo", contact: "Contact message", consultation: "Consultation" }[kind]];
    if (form.industry.value) lines.push("Industry: " + form.industry.value);
    if (method) lines.push("Preferred contact: " + method);
    if (extra.length) lines.push("Also interested in: " + extra.join(", "));
    if (form.message.value.trim()) lines.push("Message: " + form.message.value.trim());

    var body = {
      fullName: v.fullName,
      workEmail: v.workEmail,
      companyName: v.companyName,
      consentPrivacy: true,
      website: form.website.value,
      sourcePage: location.pathname,
      message: lines.join("\n").slice(0, 2000),
    };
    if (v.phone) body.phone = v.phone;
    if (form.employeeCount.value) body.employeeCount = form.employeeCount.value;
    if (interests.length) body.interests = interests;

    var label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Sending…";
    var fallback = contact ? 'Please try again, or email <a href="mailto:' + contact + '">' + contact + "</a>." : "Please try again in a few minutes.";

    fetch(api + "/public/demo-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
      .then(function (r) {
        // Only the server's confirmation counts. Anything else is shown as not sent.
        if (r.res.ok && r.data && r.data.ok) {
          form.hidden = true;
          statusEl.className = "form-status";
          done.hidden = false;
          $("#done-ref").textContent = r.data.reference || "";
          done.focus();
          return;
        }
        if (r.res.status === 429) show("bad", "Too many requests from this connection just now. " + fallback);
        else if (r.res.status === 400) show("bad", "Some details need another look. Check the highlighted fields and the privacy tick box, then send again.");
        else show("bad", "We could not save your request, so nothing has been sent. " + fallback);
      })
      .catch(function () { show("bad", "We could not reach the server, so nothing has been sent. Check your connection. " + fallback); })
      .then(function () { submit.disabled = false; submit.textContent = label; });
  });
})();
