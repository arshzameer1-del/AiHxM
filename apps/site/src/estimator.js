/* Scope estimator. Builds the SHAPE of a project (plan structure, scope size, phases) from what the visitor enters.
   It shows a price only when the business has approved one (cfg.published and cfg.prices set); otherwise it says so.
   Nothing is sent anywhere: the only outgoing step is a normal link the visitor chooses to follow. */
(function (root) {
  "use strict";

  function bandBounds(v) {
    var m = /^(\d+)-(\d+)$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
    var p = /^(\d+)\+$/.exec(v);
    return p ? [Number(p[1]), null] : [0, null];
  }

  function calc(cfg, input) {
    var mods = (input.mods || []).slice();
    var byKey = {};
    cfg.planModules.forEach(function (m) { byKey[m.key] = m; });
    var tier = 0;
    mods.forEach(function (k) { if (byKey[k] && byKey[k].tier > tier) tier = byKey[k].tier; });
    var plan = cfg.planNames[tier];
    var hasPayroll = mods.indexOf("payroll") >= 0;
    var band = cfg.bands.filter(function (b) { return b[0] === input.emp; })[0] || cfg.bands[0];
    var loc = Math.max(1, Math.min(500, Math.floor(Number(input.loc) || 1)));
    var pack = input.pack === "" || input.pack == null ? null : cfg.packages[Number(input.pack)] || null;
    var phaseName = {};
    cfg.phases.forEach(function (p) { phaseName[p[0]] = p[1]; });
    var phases = pack ? pack.phases.slice() : [];
    var suggestions = [];
    if (input.mig && input.mig !== "none" && (!pack || phases.indexOf("migration") < 0)) suggestions.push("Employee migration");
    if (hasPayroll && (!pack || phases.indexOf("payroll-setup") < 0)) suggestions.push("Payroll setup");
    var parallel = hasPayroll && input.par !== "no";
    if (parallel && (!pack || phases.indexOf("parallel") < 0)) suggestions.push("Payroll parallel testing");

    var score = band[2] + (hasPayroll ? 2 : 0) + (mods.length > 8 ? 1 : 0) + (loc > 3 ? 1 : 0) + (loc > 10 ? 1 : 0) +
      (input.mig === "system" ? 2 : input.mig === "sheet" ? 1 : 0) + (pack ? Math.round(phases.length / 2) : 0) +
      (mods.indexOf("dedicated") >= 0 ? 2 : 0) + (mods.indexOf("sso") >= 0 ? 1 : 0);
    var size = score <= 6 ? "Smaller" : score <= 11 ? "Medium" : "Larger";

    var price = null;
    var plans = cfg.prices && cfg.prices.plans;
    if (cfg.published && plans && plans[plan] && typeof plans[plan].perEmployeeMonth === "number") {
      var b = bandBounds(band[0]);
      var rate = plans[plan].perEmployeeMonth, min = plans[plan].minimumMonthly || 0;
      price = {
        currency: plans[plan].currency || "",
        low: Math.max(min, rate * b[0]),
        high: b[1] == null ? null : Math.max(min, rate * b[1]),
      };
    }

    var lines = [
      ["Employees", band[1]],
      ["Locations", String(loc)],
      ["Modules", mods.map(function (k) { return byKey[k] ? byKey[k].label : k; }).join(", ") || "None selected"],
      ["Implementation", pack ? pack.name + " (" + phases.map(function (k) { return phaseName[k]; }).join(", ") + ")" : "Self-service setup"],
      ["Migration", { none: "Nothing to migrate", sheet: "From spreadsheets", system: "From another system" }[input.mig] || "Nothing to migrate"],
      ["Payroll parallel test", hasPayroll ? (parallel ? "Recommended" : "Declined") : "Not applicable"],
      ["Support tier", (cfg.tiers.filter(function (t) { return t.key === input.sup; })[0] || {}).name || "Not decided"],
    ];
    var scope = "Scope estimate (not a price): plan structure " + plan + "; " + lines.map(function (l) { return l[0] + ": " + l[1]; }).join("; ");
    if (suggestions.length) scope += "; also needed: " + suggestions.join(", ");
    return { plan: plan, size: size, lines: lines, suggestions: suggestions, price: price, scope: scope.slice(0, 600) };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { calc: calc };
  if (typeof document === "undefined") return;

  var form = document.getElementById("estimator");
  var out = document.getElementById("est-out");
  if (!form || !out) return;
  var cfg;
  try { cfg = JSON.parse(form.getAttribute("data-config")); } catch (e) { return; }

  var sel = form.elements.emp;
  cfg.bands.forEach(function (b, i) {
    var o = document.createElement("option");
    o.value = b[0]; o.textContent = b[1];
    if (i === 1) o.selected = true;
    sel.appendChild(o);
  });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function read() {
    return {
      emp: form.elements.emp.value, loc: form.elements.loc.value,
      mods: Array.prototype.map.call(form.querySelectorAll('input[name="mod"]:checked'), function (c) { return c.value; }),
      pack: form.elements.pack.value, mig: form.elements.mig.value, sup: form.elements.sup.value, par: form.elements.par.value,
    };
  }
  function money(n, cur) { return cur + " " + n.toLocaleString("en-US"); }
  function render() {
    var r = calc(cfg, read());
    out.textContent = "";
    var h = el("h3", "est-plan", "Plan structure: " + r.plan);
    out.appendChild(h);
    var chip = el("p", "est-size");
    chip.appendChild(el("span", "chip soon", r.size + " scope"));
    chip.appendChild(document.createTextNode(" An indication of how much work is involved. Not a price."));
    out.appendChild(chip);
    var dl = el("dl", "facts est-facts");
    r.lines.forEach(function (l) {
      var d = el("div"); d.appendChild(el("dt", null, l[0])); d.appendChild(el("dd", null, l[1])); dl.appendChild(d);
    });
    out.appendChild(dl);
    if (r.suggestions.length) out.appendChild(el("p", "est-sug", "Based on your answers you will probably also want: " + r.suggestions.join(", ") + "."));
    if (r.price) {
      out.appendChild(el("p", "est-price", "Approved subscription estimate: " + money(r.price.low, r.price.currency) + (r.price.high != null ? " to " + money(r.price.high, r.price.currency) : " and above") + " per month. The written quotation is what applies."));
    } else {
      out.appendChild(el("p", "est-price", "Price: quoted for your company. No approved price is published, so none is shown."));
    }
    var a = el("a", "btn btn-primary", "Send this scope with a quote request");
    a.href = "/book-a-demo/?type=quote&scope=" + encodeURIComponent(r.scope);
    out.appendChild(a);
  }
  form.addEventListener("input", render);
  form.addEventListener("change", render);
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  render();
})(typeof window !== "undefined" ? window : this);
