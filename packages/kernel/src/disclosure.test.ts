/**
 * Tests for the ingest-time disclosure guard (no-comp/no-PII).
 *
 * The guard must agree with `intent-os/ci/disclosure-gate.sh`: hard-fail on
 * unambiguous compensation/PII patterns, but NOT on bare category words that
 * appear legitimately in governance docs, and NOT on allowed client-revenue $.
 */

import { describe, expect, it } from 'vitest';

import { disclosureLabel, scanForDisclosure } from './disclosure.js';

describe('scanForDisclosure — compensation/comp-split (hard-fail)', () => {
  it.each([
    ['base salary line', 'His base salary is competitive.'],
    ['vesting schedule', 'A 4-year vesting schedule with a 1-year cliff.'],
    ['ratio split', 'The arrangement is a 60/40 split between the parties.'],
    ['ratio share', 'We agreed on a 70/30 share.'],
    ['equity grant', 'The offer included an equity grant on day one.'],
    ['equity stake', 'He holds an equity stake in the venture.'],
    ['RSUs', 'Part of the package is RSUs.'],
    ['stock options', 'They were granted stock options.'],
    ['strike price', 'The strike price was set at grant.'],
    ['launch bonus', 'A launch bonus is paid at go-live.'],
    ['sign-on bonus', 'There is a sign-on bonus.'],
    ['revenue-share with number', 'revenue-share 30 to the operator'],
    ['7-bucket', 'See the 7-bucket framework.'],
    ['take-home pay', 'His take-home pay after taxes.'],
  ])('flags %s', (_label, text) => {
    const v = scanForDisclosure(text);
    expect(v).not.toBeNull();
    expect(v?.category).toBe('comp');
  });
});

describe('scanForDisclosure — PII (hard-fail)', () => {
  it.each([
    ['SSN digits', 'employee ssn is 123-45-6789 on file'],
    ['SSN acronym', 'Do not store the SSN anywhere.'],
    ['social security number', 'Provide your social security number.'],
    ['background-check result', 'background-check passed for the contractor'],
    ['date of birth', 'date of birth on the application'],
    ['DOB field', 'DOB: 1990-01-01'],
  ])('flags %s', (_label, text) => {
    const v = scanForDisclosure(text);
    expect(v).not.toBeNull();
    expect(v?.category).toBe('pii');
  });
});

describe('scanForDisclosure — clean content (must NOT flag)', () => {
  it.each([
    ['plain prose', 'The doctrine describes how the company operates.'],
    // The disclosure-tier rule itself NAMES "compensation" in order to forbid it —
    // a bare category word must pass, or we would reject our own governance docs.
    ['bare comp word in policy text', 'Never write compensation or anyone’s pay into this repo.'],
    ['payout policy word', 'No payout terms belong here; move them to Jeremy-private.'],
    ['allowed client revenue $', 'The deal closed at $40,000 in ARR for the client.'],
    ['pricing menu figure', 'The learn-with-jeremy package is priced at $2,500.'],
    ['bare ratio without comp', 'The image is a 16/9 aspect ratio.'],
  ])('passes %s', (_label, text) => {
    expect(scanForDisclosure(text)).toBeNull();
  });
});

describe('scanForDisclosure — normalization', () => {
  it('catches an NFKC-foldable fullwidth-digit SSN', () => {
    // Fullwidth digits normalize to ASCII under NFKC, so the SSN pattern still fires.
    const fullwidth = '１２３-４５-６７８９';
    const v = scanForDisclosure(`id ${fullwidth} here`);
    expect(v?.category).toBe('pii');
  });
});

describe('disclosureLabel', () => {
  it('maps categories to human labels', () => {
    expect(disclosureLabel('pii')).toBe('PII');
    expect(disclosureLabel('comp')).toBe('compensation/comp-split');
  });
});
