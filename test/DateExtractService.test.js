/**
 * DateExtractService.test.js — chronological filing depends on these dates
 * being RIGHT: a misparsed date silently files a document into the wrong
 * year for good. Every format the wild throws at us gets a case here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractDocumentDate, chronoSubfolder } = require("../src/main/services/DateExtractService");

function d(res) { return res && `${res.year}-${String(res.month).padStart(2, "0")}-${String(res.day).padStart(2, "0")}`; }

test("filename dates win over text dates", () => {
  const r = extractDocumentDate("2026-03-15_invoice.pdf", "Date: January 1, 2020");
  assert.equal(d(r), "2026-03-15");
  assert.equal(r.source, "filename");
});

test("compact camera-style filename: IMG_20260315.jpg", () => {
  assert.equal(d(extractDocumentDate("IMG_20260315.jpg", "")), "2026-03-15");
});

test("labeled text dates: 'Invoice date: March 5, 2026'", () => {
  const r = extractDocumentDate("scan001.pdf", "ACME Corp\nInvoice date: March 5, 2026\nTotal: $410");
  assert.equal(d(r), "2026-03-05");
  assert.equal(r.source, "label");
});

test("day-first written format: '5 March 2026'", () => {
  assert.equal(d(extractDocumentDate("x.pdf", "Signed on this day, 5 March 2026")), "2026-03-05");
});

test("US numeric 03/15/2026 and impossible-month swap 25/12/2026", () => {
  assert.equal(d(extractDocumentDate("x.pdf", "Statement 03/15/2026")), "2026-03-15");
  assert.equal(d(extractDocumentDate("x.pdf", "delivered 25/12/2026")), "2026-12-25");
});

test("month-year only: 'March 2026' → first of month", () => {
  assert.equal(d(extractDocumentDate("x.pdf", "Statement period: March 2026")), "2026-03-01");
});

test("rejects garbage: invoice numbers, versions, phone digits, Feb 31", () => {
  assert.equal(extractDocumentDate("invoice_48372.pdf", "Ref 20991 v2.3.1 call 555-0142"), null);
  assert.equal(extractDocumentDate("x.pdf", "backup from 2026-02-31 nope"), null);
  // Year outside sanity window
  assert.equal(extractDocumentDate("x.pdf", "founded 1776-07-04"), null);
});

test("no date at all → null (caller falls back to mtime)", () => {
  assert.equal(extractDocumentDate("notes.txt", "buy milk, call mom"), null);
});

test("chronoSubfolder formats", () => {
  const r = extractDocumentDate("2026-03-15_invoice.pdf", "");
  assert.equal(chronoSubfolder(r, "year"), "2026");
  assert.equal(chronoSubfolder(r, "year-month"), "2026-03");
  assert.equal(chronoSubfolder(null), "");
});
