/* Public playground. Everything here is FICTIONAL sample data held in memory in this page. There is no network request,
   no storage and no link to any real company: closing the page discards it. The tax bands and the contribution are
   invented demo settings and are not Pakistan's rates. */
(function () {
  "use strict";
  var root = document.getElementById("playground");
  if (!root) return;

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function n0(n) { return Math.round(n).toLocaleString("en-US"); }
  function pkr(n) { return "PKR " + n0(n); }
  function iso(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function parse(s) { var p = s.split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function fmt(d) { return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function nextMonday() { var d = new Date(); d.setHours(0, 0, 0, 0); do { d = addDays(d, 1); } while (d.getDay() !== 1); return d; }
  function workdays(a, b) { var c = 0; for (var d = new Date(a.getTime()); d <= b; d = addDays(d, 1)) { var w = d.getDay(); if (w !== 0 && w !== 6) c++; } return c; }

  // ---------- fictional data ----------
  var MON = nextMonday();
  var COMPANY = "Sample Company (Pvt) Ltd";
  var DEPTS = ["Finance", "Operations", "Sales", "People"];
  var TEAM = [
    ["Zara Demo", "Finance", "Accounts Officer", 150000, 21], ["Hamza Sample", "Finance", "Accountant", 210000, 19], ["Mehwish Test", "Finance", "Finance Manager", 340000, 22],
    ["Bilal Sample", "Operations", "Operations Lead", 300000, 20], ["Sana Demo", "Operations", "Coordinator", 120000, 22], ["Owais Test", "Operations", "Supervisor", 140000, 18],
    ["Hina Sample", "Sales", "Sales Executive", 160000, 20], ["Rayyan Demo", "Sales", "Sales Executive", 155000, 21], ["Iqra Test", "Sales", "Sales Manager", 320000, 22],
    ["Taha Sample", "People", "HR Officer", 135000, 22], ["Amna Demo", "People", "HR Manager", 330000, 21], ["Saad Test", "People", "Recruiter", 125000, 19],
  ];
  var ABSENT = [["Hamza Sample", 1, 2], ["Mehwish Test", 7, 9], ["Sana Demo", 2, 3]]; // teammates already off (day offsets from next Monday)
  var BANDS = [[500000, 0], [1500000, 0.04], [Infinity, 0.08]]; // demo bands, NOT Pakistan's
  var CONTRIB = 0.03; // demo contribution on basic
  var WORKING_DAYS = 22;

  function fresh() {
    return {
      step: 0,
      emp: { name: "Zara Demo", id: "DEMO-0042", dept: "Finance", title: "Accounts Officer", manager: "Bilal Sample", location: "Head office (sample)", joined: "2023-02-01", status: "Active", basic: 90000, house: 40000, transport: 10000 },
      bal: { Annual: 14, Sick: 8, Casual: 6, Unpaid: 0 },
      leaves: [], seq: 1, msg: "", punch: { in: "", out: "" },
      week: [["09:02", "18:05"], ["08:55", "18:00"], ["09:21", "18:30"], ["09:00", "17:58"], ["", ""]],
      lastDecision: null,
    };
  }
  var S = fresh();

  // ---------- derived numbers ----------
  function unpaidDays() { return S.leaves.filter(function (l) { return l.status === "Approved" && l.type === "Unpaid"; }).reduce(function (a, l) { return a + l.days; }, 0); }
  function pay() {
    var e = S.emp, gross = e.basic + e.house + e.transport;
    var ded = unpaidDays() * (gross / WORKING_DAYS);
    var taxable = gross - ded, annual = taxable * 12, tax = 0, lo = 0;
    var rows = [];
    for (var i = 0; i < BANDS.length; i++) {
      var hi = BANDS[i][0], r = BANDS[i][1];
      var part = Math.max(0, Math.min(annual, hi) - lo);
      if (part > 0) { rows.push([lo, hi, r, part * r]); tax += part * r; }
      lo = hi;
    }
    var contrib = e.basic * CONTRIB;
    return { gross: gross, unpaidDed: ded, taxable: taxable, annual: annual, annualTax: tax, tax: tax / 12, contrib: contrib, net: gross - ded - tax / 12 - contrib, rows: rows };
  }
  function overlap(from, to) {
    return ABSENT.filter(function (a) { var s = addDays(MON, a[1]), e = addDays(MON, a[2]); return s <= to && e >= from; }).length;
  }

  // ---------- steps ----------
  var STEPS = ["Employee profile", "Attendance", "Leave request", "Manager approval", "Payroll calculation", "Payslip preview", "Analytics"];

  function dlist(rows) { return '<dl class="facts pg-facts">' + rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("") + "</dl>"; }

  var views = [
    function profile() {
      var e = S.emp;
      return '<h3>' + esc(e.name) + '</h3><p class="pg-sub">' + esc(e.title) + " · " + esc(e.dept) + ' <span class="chip ok">' + esc(e.status) + "</span></p>" +
        dlist([["Employee ID", e.id], ["Reports to", e.manager], ["Location", e.location], ["Joined", fmt(parse(e.joined)) + " " + parse(e.joined).getFullYear()], ["Monthly basic", pkr(e.basic)], ["Allowances", pkr(e.house + e.transport) + " (house and transport)"]]) +
        '<p class="pg-hint">In the real product the employee record also holds documents, history with effective dates, statutory IDs and your own custom fields. Everything above is invented.</p>';
    },
    function attendance() {
      var days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      var rows = S.week.map(function (w, i) {
        var d = addDays(MON, i - 7);
        var late = w[0] && w[0] > "09:10";
        return "<tr><th scope=\"row\">" + esc(days[i]) + " " + esc(fmt(d).replace(/^\w+,? /, "")) + "</th><td>" + (w[0] || "—") + "</td><td>" + (w[1] || "—") + "</td><td>" + (!w[0] ? '<span class="chip soon">No punch</span>' : late ? '<span class="chip setup">Late</span>' : '<span class="chip ok">On time</span>') + "</td></tr>";
      }).join("");
      var t = S.punch;
      return "<h3>Last week</h3><p class=\"pg-sub\">Shift 09:00 to 18:00 with a 10-minute grace period (sample policy).</p>" +
        '<div class="tbl-wrap" tabindex="0" role="region" aria-label="Sample attendance for last week"><table class="tbl"><caption class="sr">Sample attendance</caption><thead><tr><th scope="col">Day</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Status</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<h3>Today</h3><p class="pg-sub" id="pg-punch">' + (t.in ? "Clocked in at " + esc(t.in) + (t.out ? ", out at " + esc(t.out) : ".") : "You have not clocked in yet.") + '</p><div class="btn-row"><button type="button" class="btn btn-primary btn-sm" data-act="clock-in"' + (t.in ? " disabled" : "") + '>Clock in</button><button type="button" class="btn btn-ghost btn-sm" data-act="clock-out"' + (!t.in || t.out ? " disabled" : "") + ">Clock out</button></div>" +
        '<p class="pg-hint">The punch uses your own device clock and lives only on this page.</p>';
    },
    function leave() {
      var b = S.bal, to = addDays(MON, 1);
      var balRows = ["Annual", "Sick", "Casual"].map(function (k) { return [k + " leave balance", b[k] + " days"]; });
      var mine = S.leaves.length ? '<h3>Your requests</h3><ul class="pg-list">' + S.leaves.map(function (l) { return "<li><span>" + esc(l.type) + ", " + esc(fmt(l.from)) + (l.days > 1 ? " to " + esc(fmt(l.to)) : "") + " (" + l.days + " working " + (l.days === 1 ? "day" : "days") + ")</span><span class=\"chip " + (l.status === "Approved" ? "ok" : l.status === "Rejected" ? "no" : "setup") + '">' + esc(l.status) + "</span></li>"; }).join("") + "</ul>" : "";
      return "<h3>Request leave</h3>" + dlist(balRows) +
        '<form id="pg-leave" class="lead-form pg-form" novalidate><div class="row2"><div class="field"><label for="pg-type">Leave type</label><select id="pg-type" name="type"><option>Annual</option><option>Sick</option><option>Casual</option><option>Unpaid</option></select></div><div class="field"><label for="pg-from">From</label><input id="pg-from" name="from" type="date" value="' + iso(MON) + '"></div></div>' +
        '<div class="row2"><div class="field"><label for="pg-to">To</label><input id="pg-to" name="to" type="date" value="' + iso(to) + '"></div><div class="field"><label for="pg-reason">Reason (optional)</label><input id="pg-reason" name="reason" maxlength="120"></div></div>' +
        '<p class="err show" id="pg-err" role="alert"></p><button class="btn btn-primary btn-sm" type="submit">Submit request</button></form>' + S.msg + mine +
        '<p class="pg-hint">Working days exclude Saturday and Sunday in this sample. A real company sets its own weekend, holidays and policies.</p>';
    },
    function approval() {
      var pending = S.leaves.filter(function (l) { return l.status === "Pending"; });
      var done = S.leaves.filter(function (l) { return l.status !== "Pending"; });
      var out = '<p class="pg-sub">You are now viewing as <strong>Bilal Sample</strong>, the manager of Zara Demo.</p>';
      if (!pending.length) {
        out += '<div class="pg-empty"><p>' + (S.leaves.length ? "No requests are waiting for you." : "Nothing is waiting. Submit a leave request in the previous step, then come back.") + '</p>' + (S.leaves.length ? "" : '<button type="button" class="btn btn-ghost btn-sm" data-go="2">Go to leave request</button>') + "</div>";
      }
      pending.forEach(function (l) {
        var after = l.type === "Unpaid" ? "not counted" : S.bal[l.type] - l.days + " days";
        out += '<div class="pg-card"><h3>' + esc(l.type) + " leave: " + l.days + " working " + (l.days === 1 ? "day" : "days") + "</h3>" +
          dlist([["Employee", S.emp.name], ["Dates", fmt(l.from) + (l.days > 1 ? " to " + fmt(l.to) : "")], ["Reason", l.reason || "Not given"], ["Balance after approval", after], ["Team on leave in the same dates", overlap(l.from, l.to) + " of 11 colleagues"]]) +
          '<div class="field"><label for="pg-cmt-' + l.id + '">Comment (optional)</label><input id="pg-cmt-' + l.id + '" maxlength="120"></div><div class="btn-row"><button type="button" class="btn btn-primary btn-sm" data-act="approve" data-id="' + l.id + '">Approve</button><button type="button" class="btn btn-ghost btn-sm" data-act="reject" data-id="' + l.id + '">Reject</button></div></div>';
      });
      if (done.length) out += '<h3>Decisions</h3><ul class="pg-list">' + done.map(function (l) { return "<li><span>" + esc(l.type) + ", " + esc(fmt(l.from)) + (l.comment ? ' · "' + esc(l.comment) + '"' : "") + '</span><span class="chip ' + (l.status === "Approved" ? "ok" : "no") + '">' + esc(l.status) + "</span></li>"; }).join("") + "</ul>";
      return out + '<p class="pg-hint">In the real product the approver sees the same balance and team calendar, can comment, delegate while away, and you design the approval steps yourself.</p>';
    },
    function payroll() {
      var p = pay(), u = unpaidDays();
      var rows = p.rows.map(function (r) { return "<tr><td>" + n0(r[0]) + (r[1] === Infinity ? " and above" : " to " + n0(r[1])) + "</td><td>" + (r[2] * 100).toFixed(0) + "%</td><td>" + pkr(r[3]) + "</td></tr>"; }).join("");
      return '<h3>This month for ' + esc(S.emp.name) + '</h3><div class="field pg-basic"><label for="pg-basic">Monthly basic salary (try changing it)</label><input id="pg-basic" type="number" min="0" max="2000000" step="5000" value="' + S.emp.basic + '" inputmode="numeric"></div>' +
        dlist([["Gross (basic + allowances)", pkr(p.gross)], ["Unpaid leave", u + (u === 1 ? " day" : " days") + (u ? " deducts " + pkr(p.unpaidDed) + " (gross ÷ " + WORKING_DAYS + " working days)" : " (approve an unpaid request to see it)")], ["Annualised taxable pay", pkr(p.annual)], ["Sample tax for the year", pkr(p.annualTax)], ["Monthly sample tax", pkr(p.tax)], ["Sample contribution (" + CONTRIB * 100 + "% of basic)", pkr(p.contrib)], ["Net pay", pkr(p.net)]]) +
        '<h3>Sample tax bands</h3><div class="tbl-wrap" tabindex="0" role="region" aria-label="Sample tax bands"><table class="tbl"><caption class="sr">Sample tax bands used in this demo</caption><thead><tr><th scope="col">Annual pay band</th><th scope="col">Rate</th><th scope="col">Tax in band</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<p class="pg-hint warn"><strong>These bands are invented for the demo and are not Pakistan\'s rates.</strong> In a real company your accountant supplies the slabs and contributions, you enter them with an effective date, and AiHxM calculates from them.</p>';
    },
    function payslip() {
      var p = pay(), e = S.emp, u = unpaidDays(), m = MON.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      function row(a, b, cls) { return '<tr class="' + (cls || "") + '"><th scope="row">' + esc(a) + "</th><td>" + esc(b) + "</td></tr>"; }
      return '<div class="slip" role="group" aria-label="Sample payslip"><div class="slip-mark" aria-hidden="true">SAMPLE · FICTIONAL</div><div class="slip-head"><div><strong>' + esc(COMPANY) + '</strong><span>Payslip for ' + esc(m) + '</span></div><div><strong>' + esc(e.name) + '</strong><span>' + esc(e.id) + " · " + esc(e.title) + "</span></div></div>" +
        '<table class="tbl slip-t"><caption class="sr">Sample payslip</caption><tbody>' + row("Earnings", "", "slip-sec") + row("Basic salary", pkr(e.basic)) + row("House allowance", pkr(e.house)) + row("Transport allowance", pkr(e.transport)) + row("Gross", pkr(p.gross), "slip-sum") + row("Deductions", "", "slip-sec") +
        (u ? row("Unpaid leave (" + u + (u === 1 ? " day)" : " days)"), "− " + pkr(p.unpaidDed)) : "") + row("Sample income tax", "− " + pkr(p.tax)) + row("Sample contribution", "− " + pkr(p.contrib)) + row("Net pay", pkr(p.net), "slip-net") + "</tbody></table>" +
        '<p class="slip-foot">The calculation is stored with the payslip: gross ' + n0(p.gross) + (u ? " − unpaid " + n0(p.unpaidDed) : "") + " − tax " + n0(p.tax) + " − contribution " + n0(p.contrib) + " = " + n0(p.net) + ". All figures are fictional.</p></div>" +
        '<p class="pg-hint">Change the basic salary or approve an unpaid leave request and this payslip changes with them.</p>';
    },
    function analytics() {
      var ap = S.leaves.filter(function (l) { return l.status === "Approved"; });
      var byDept = DEPTS.map(function (d) {
        var m = TEAM.filter(function (t) { return t[1] === d; });
        var cost = m.reduce(function (a, t) { return a + (t[0] === S.emp.name ? S.emp.basic * 1 + S.emp.house + S.emp.transport : t[3]); }, 0);
        var att = m.reduce(function (a, t) { return a + t[4] / 22; }, 0) / m.length;
        return { d: d, n: m.length, cost: cost, att: att * 100 };
      });
      var leaveBy = { Annual: 38, Sick: 17, Casual: 12, Unpaid: 3 };
      ap.forEach(function (l) { leaveBy[l.type] += l.days; });
      function bars(title, rows, unit, max) {
        return '<div class="pg-chart"><h3>' + esc(title) + '</h3><ul class="bars" role="list">' + rows.map(function (r) { return '<li><span class="b-l">' + esc(r[0]) + '</span><span class="b-t"><span class="b-f" style="width:' + Math.max(2, Math.round(r[1] / max * 100)) + '%"></span></span><span class="b-v">' + esc(r[2]) + "</span></li>"; }).join("") + "</ul></div>";
      }
      var maxCost = Math.max.apply(null, byDept.map(function (x) { return x.cost; }));
      var maxLeave = Math.max.apply(null, Object.keys(leaveBy).map(function (k) { return leaveBy[k]; }));
      return '<p class="pg-sub">12 fictional employees across four departments. Approving leave in the earlier steps updates the leave chart.</p><div class="grid g2 pg-grid">' +
        bars("Headcount by department", byDept.map(function (x) { return [x.d, x.n, String(x.n)]; }), "", 4) +
        bars("Attendance rate by department", byDept.map(function (x) { return [x.d, x.att, x.att.toFixed(0) + "%"]; }), "%", 100) +
        bars("Leave days taken this year", Object.keys(leaveBy).map(function (k) { return [k, leaveBy[k], String(leaveBy[k])]; }), "", maxLeave) +
        bars("Monthly gross payroll by department", byDept.map(function (x) { return [x.d, x.cost, pkr(x.cost)]; }), "", maxCost) + "</div>" +
        '<p class="pg-hint">Real reports can be filtered, exported and scheduled, and respect each viewer\'s data access. These are fixed sample figures plus whatever you approved.</p>';
    },
  ];

  // ---------- render ----------
  function render(focusTab) {
    var tabs = STEPS.map(function (t, i) {
      return '<button type="button" role="tab" class="pg-tab' + (i === S.step ? " on" : "") + '" id="pg-t' + i + '" aria-controls="pg-p" aria-selected="' + (i === S.step) + '" tabindex="' + (i === S.step ? 0 : -1) + '"><b>' + (i + 1) + "</b>" + esc(t) + "</button>";
    }).join("");
    root.innerHTML = '<div class="pg-bar"><p class="pg-badge">Sample data · nothing is saved or sent</p><button type="button" class="btn btn-ghost btn-sm" data-act="reset">Start over</button></div>' +
      '<div class="pg-tabs" role="tablist" aria-label="Playground steps">' + tabs + '</div><div class="pg-panel" id="pg-p" role="tabpanel" tabindex="0" aria-labelledby="pg-t' + S.step + '"><h2 class="pg-h">' + (S.step + 1) + ". " + esc(STEPS[S.step]) + "</h2>" + views[S.step]() +
      '<div class="pg-nav">' + (S.step > 0 ? '<button type="button" class="btn btn-ghost btn-sm" data-go="' + (S.step - 1) + '">Back</button>' : "<span></span>") + (S.step < STEPS.length - 1 ? '<button type="button" class="btn btn-primary btn-sm" data-go="' + (S.step + 1) + '">Next: ' + esc(STEPS[S.step + 1]) + "</button>" : '<a class="btn btn-primary btn-sm" href="/book-a-demo/">Book a demo with your own data</a>') + "</div></div>";
    if (focusTab) { var t = document.getElementById("pg-t" + S.step); if (t) t.focus(); }
  }

  function go(i) { S.step = Math.max(0, Math.min(STEPS.length - 1, i)); S.msg = ""; render(true); }

  root.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act],[data-go],.pg-tab");
    if (!t) return;
    if (t.classList.contains("pg-tab")) { go(Number(t.id.replace("pg-t", ""))); return; }
    if (t.hasAttribute("data-go")) { go(Number(t.getAttribute("data-go"))); return; }
    var a = t.getAttribute("data-act");
    if (a === "reset") { S = fresh(); render(true); return; }
    if (a === "clock-in" || a === "clock-out") {
      var d = new Date(), hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      if (a === "clock-in") S.punch.in = hm; else S.punch.out = hm;
      render(false); var b = root.querySelector("#pg-punch"); if (b) b.focus && b.setAttribute("tabindex", "-1"); return;
    }
    if (a === "approve" || a === "reject") {
      var id = Number(t.getAttribute("data-id"));
      var l = S.leaves.filter(function (x) { return x.id === id; })[0];
      if (!l) return;
      var c = document.getElementById("pg-cmt-" + id);
      l.comment = c ? c.value.trim() : "";
      if (a === "approve") { l.status = "Approved"; if (l.type !== "Unpaid") S.bal[l.type] -= l.days; } else l.status = "Rejected";
      render(false);
      var p = document.getElementById("pg-p"); if (p) p.focus();
    }
  });

  root.addEventListener("keydown", function (e) {
    if (!e.target.classList || !e.target.classList.contains("pg-tab")) return;
    var k = e.key, i = S.step;
    if (k === "ArrowRight") i++; else if (k === "ArrowLeft") i--; else if (k === "Home") i = 0; else if (k === "End") i = STEPS.length - 1; else return;
    e.preventDefault(); go(i);
  });

  root.addEventListener("input", function (e) {
    if (e.target.id === "pg-basic") {
      var v = Math.max(0, Math.min(2000000, Number(e.target.value) || 0));
      S.emp.basic = v;
      // re-render only the numbers, keep focus in the field
      var keep = e.target.selectionStart;
      render(false);
      var f = document.getElementById("pg-basic"); if (f) { f.focus(); try { f.setSelectionRange(keep, keep); } catch (x) { /* number inputs may refuse */ } }
    }
  });

  root.addEventListener("submit", function (e) {
    if (e.target.id !== "pg-leave") return;
    e.preventDefault();
    var f = e.target, err = document.getElementById("pg-err");
    var type = f.type.value, from = f.from.value && parse(f.from.value), to = f.to.value && parse(f.to.value);
    function bad(m) { err.textContent = m; err.className = "err show"; }
    if (!from || !to) return bad("Choose both dates.");
    if (to < from) return bad("The end date is before the start date.");
    var days = workdays(from, to);
    if (days < 1) return bad("That range has no working days (weekends are excluded in this sample).");
    if (days > 30) return bad("Please keep the sample request to 30 working days or fewer.");
    if (type !== "Unpaid" && days > S.bal[type]) return bad("You only have " + S.bal[type] + " days of " + type.toLowerCase() + " leave left in this sample.");
    S.leaves.push({ id: S.seq++, type: type, from: from, to: to, days: days, reason: f.reason.value.trim(), status: "Pending", comment: "" });
    S.msg = '<div class="notice" role="status"><strong>Request sent.</strong> It is now waiting for Bilal Sample. <button type="button" class="linklike" data-go="3">Open the manager view</button></div>';
    render(false);
    var p = document.getElementById("pg-p"); if (p) p.focus();
  });

  render(false);
})();
