// Site behaviour: the mobile menu and the "Book a demo" form. No dependencies, no tracking.
(function () {
  "use strict";

  var header = document.getElementById("site-header");
  var toggle = document.getElementById("menu-toggle");
  if (header && toggle) {
    toggle.addEventListener("click", function () {
      var open = header.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Close" : "Menu";
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && header.classList.contains("nav-open")) {
        header.classList.remove("nav-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "Menu";
        toggle.focus();
      }
    });
  }

  var form = document.getElementById("demo-form");
  if (!form) return;

  var api = form.getAttribute("data-api");
  var contact = form.getAttribute("data-contact") || "";
  var status = document.getElementById("form-status");
  var done = document.getElementById("form-done");
  var submit = document.getElementById("form-submit");

  // ?interest=payroll (links from product pages) pre-selects the matching box.
  try {
    var wanted = new URLSearchParams(location.search).getAll("interest");
    wanted.forEach(function (v) {
      var box = form.querySelector('input[name="interests"][value="' + v.replace(/[^a-z-]/g, "") + '"]');
      if (box) box.checked = true;
    });
  } catch (e) {}

  function setInvalid(name, bad) {
    var el = form.querySelector('[data-field="' + name + '"]');
    if (!el) return;
    if (bad) el.setAttribute("data-invalid", "");
    else el.removeAttribute("data-invalid");
  }

  function show(kind, html) {
    status.className = "form-status show " + kind;
    status.innerHTML = html;
    status.focus();
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
    Object.keys(bad).forEach(function (k) {
      setInvalid(k, bad[k]);
      if (bad[k] && !first) first = k;
    });
    if (first) {
      var el = form.elements[first];
      if (el && el.focus) el.focus();
      return null;
    }
    return v;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    status.className = "form-status";
    var v = validate();
    if (!v) return;

    var interests = Array.prototype.map.call(form.querySelectorAll('input[name="interests"]:checked'), function (c) {
      return c.value;
    });
    var body = {
      fullName: v.fullName,
      workEmail: v.workEmail,
      companyName: v.companyName,
      consentPrivacy: true,
      website: form.website.value,
      sourcePage: location.pathname,
    };
    if (v.phone) body.phone = v.phone;
    if (form.jobTitle.value.trim()) body.jobTitle = form.jobTitle.value.trim();
    if (form.employeeCount.value) body.employeeCount = form.employeeCount.value;
    if (interests.length) body.interests = interests;
    if (form.message.value.trim()) body.message = form.message.value.trim();

    submit.disabled = true;
    submit.textContent = "Sending…";

    var fallback = contact
      ? 'Please try again, or email <a href="mailto:' + contact + '">' + contact + "</a>."
      : "Please try again in a few minutes.";

    fetch(api + "/public/demo-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
      })
      .then(function (r) {
        if (r.res.ok && r.data && r.data.ok) {
          form.hidden = true;
          status.className = "form-status";
          done.hidden = false;
          document.getElementById("done-email").textContent = v.workEmail;
          document.getElementById("done-ref").textContent = r.data.reference || "";
          done.focus();
          return;
        }
        if (r.res.status === 429) {
          show("bad", "Too many requests from this connection just now. " + fallback);
        } else if (r.res.status === 400) {
          show("bad", "Some details need another look. Check the highlighted fields and the privacy tick box, then send again.");
        } else {
          show("bad", "We could not save your request. " + fallback);
        }
      })
      .catch(function () {
        show("bad", "We could not reach the server. Check your connection. " + fallback);
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = "Send request";
      });
  });
})();
