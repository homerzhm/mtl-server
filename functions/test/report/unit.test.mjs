import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {parseReportRequest, requireReportAdmin} from '../../lib/report/service.js';

const google = {sign_in_provider: 'google.com'};

test('strict boolean Admin claim works with or without Staff', () => {
  for (const staff of [undefined, false, true]) {
    assert.deepEqual(requireReportAdmin({uid: 'admin', token: {firebase: google, admin: true, staff, name: '  Anna  '}}),
      {uid: 'admin', name: 'Anna'});
  }
  for (const admin of [undefined, false, 'true', 1]) {
    assert.throws(() => requireReportAdmin({uid: 'staff', token: {firebase: google, staff: true, admin}}),
      {code: 'permission-denied'});
  }
  assert.throws(() => requireReportAdmin({uid: 'admin', token: {firebase: {sign_in_provider: 'password'}, admin: true}}),
    {code: 'permission-denied'});
  assert.throws(() => requireReportAdmin(undefined), {code: 'unauthenticated'});
});

test('normalizes canonical write fields and rejects invalid amounts, types and dates', () => {
  const change = {requestID: randomUUID().toUpperCase(), entryID: randomUUID(), action: 'create',
    day: '2028-02-29', type: 'adjust', amountCents: -2147483647, notes: '  Till  '};
  const parse = fields => parseReportRequest({actorID: 'admin', action: 'create', change: {...change, ...fields}}, 'admin');
  assert.deepEqual(parse({}), {...change, notes: 'Till', requestID: change.requestID.toLowerCase()});
  for (const fields of [{day: '2026-02-29'}, {day: '2026-11-1'}, {amountCents: 0}, {amountCents: 2.5},
    {amountCents: -2147483648}, {type: 'paybill'}, {type: 'other'}, {notes: 7}]) {
    assert.throws(() => parse(fields), {code: 'invalid-argument'});
  }
  assert.throws(() => parseReportRequest({actorID: 'other', action: 'create', change}, 'admin'),
    {code: 'permission-denied'});
});
