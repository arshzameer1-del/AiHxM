import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServiceRequest, emptyRequestForm, requestFormProblem, requestTitle } from "./serviceRequests";

test("a loan needs an amount and a reason; instalments are optional but must be whole numbers", () => {
  const f = emptyRequestForm("loan");
  assert.match(requestFormProblem(f) ?? "", /amount/);
  assert.match(requestFormProblem({ ...f, amount: "-5", purpose: "x" }) ?? "", /amount/);
  assert.match(requestFormProblem({ ...f, amount: "5000", purpose: " " }) ?? "", /why/);
  assert.match(requestFormProblem({ ...f, amount: "5000", installments: "2.5", purpose: "x" }) ?? "", /Instalments/);
  assert.equal(requestFormProblem({ ...f, amount: "5000", purpose: "Repairs" }), null);
});

test("a letter only needs a reason", () => {
  assert.equal(requestFormProblem({ ...emptyRequestForm("letter"), purpose: "Visa" }), null);
});

test("buildServiceRequest sends only what applies to the kind", () => {
  const loan = buildServiceRequest({ ...emptyRequestForm("salary_advance"), amount: "20000", installments: "4", loanTypeId: "t1", purpose: " School ", letterType: "noc", addressedTo: "ignored" });
  assert.deepEqual(loan, { kind: "salary_advance", purpose: "School", amount: 20000, installmentsCount: 4, loanTypeId: "t1" });
  const letter = buildServiceRequest({ ...emptyRequestForm("letter"), letterType: "noc", addressedTo: " Embassy ", neededBy: "2026-11-01", purpose: "Visa", amount: "99" });
  assert.deepEqual(letter, { kind: "letter", purpose: "Visa", neededBy: "2026-11-01", letterType: "noc", addressedTo: "Embassy" });
});

test("requestTitle names the request", () => {
  assert.equal(requestTitle({ kind: "letter", letterType: "salary_certificate", amount: null }), "Salary certificate");
  assert.match(requestTitle({ kind: "loan", letterType: null, amount: 60000 }), /^Loan of 60[,.]?000$/);
});
