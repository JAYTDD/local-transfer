import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraeStatus } from '../src/panel/trae-status.mjs';
import { createPanelApi } from '../src/panel/api.mjs';

function deps({ region = 'cn', checkinStatus, claimCheckin } = {}) {
  const provider = {
    store: { status: async () => ({ state: 'signed-in' }), accounts: async () => [] },
    models: () => [],
    usage: {
      checkinStatus: checkinStatus ?? (async () => ({ checkedIn: false, credits: 5, enabled: true, didCheckedIn: false })),
      claimCheckin: claimCheckin ?? (async () => ({ claimed: true, code: 0, message: '' })),
    },
  };
  const prefix = region === 'ai' ? 'traeg' : 'trae';
  const providers = [{ def: { prefix, kind: 'trae' }, provider, models: [] }];
  return { providers: () => providers };
}

test('正常领取返回 updated 且 claimed:true', async () => {
  const out = await createTraeStatus(deps()).checkin('cn');
  assert.equal(out.state, 'updated');
  assert.equal(out.claimed, true);
});

test('今天已签过则不调 claimCheckin（先读后写的核心）', async () => {
  let claimed = false;
  const out = await createTraeStatus(deps({
    checkinStatus: async () => ({ checkedIn: true, credits: 5, enabled: true, didCheckedIn: true }),
    claimCheckin: async () => { claimed = true; return { claimed: true, code: 0, message: '' }; },
  })).checkin('cn');
  assert.equal(claimed, false, '已经签过还去打上游 = 守卫没生效');
  assert.equal(out.state, 'updated');
  assert.equal(out.claimed, false);
  assert.match(out.reason, /already/i);
});

test('本设备已签过则不调 claimCheckin', async () => {
  let claimed = false;
  const out = await createTraeStatus(deps({
    checkinStatus: async () => ({ checkedIn: false, credits: 5, enabled: true, didCheckedIn: true }),
    claimCheckin: async () => { claimed = true; return { claimed: true, code: 0, message: '' }; },
  })).checkin('cn');
  assert.equal(claimed, false);
  assert.equal(out.claimed, false);
  assert.match(out.reason, /device/i);
});

test('活动未开启时拒绝且不打上游', async () => {
  let claimed = false;
  const out = await createTraeStatus(deps({
    checkinStatus: async () => ({ checkedIn: false, credits: 0, enabled: false, didCheckedIn: false }),
    claimCheckin: async () => { claimed = true; return { claimed: true, code: 0, message: '' }; },
  })).checkin('cn');
  assert.equal(claimed, false);
  assert.equal(out.state, 'updated');
  assert.equal(out.claimed, false);
  assert.match(out.reason, /not enabled/i);
});

test('读签到状态失败时不打写接口，报 failed', async () => {
  let claimed = false;
  const out = await createTraeStatus(deps({
    checkinStatus: async () => { throw new Error('status unreachable'); },
    claimCheckin: async () => { claimed = true; return { claimed: true, code: 0, message: '' }; },
  })).checkin('cn');
  assert.equal(claimed, false, '状态读不到就不该盲写');
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /status unreachable/);
});

test('上游业务拒绝（code 非零）报 claimed:false 而非抛错', async () => {
  const out = await createTraeStatus(deps({
    claimCheckin: async () => ({ claimed: false, code: 9004, message: 'no device id' }),
  })).checkin('cn');
  assert.equal(out.state, 'updated', '业务拒绝仍是一次完成的往返，不是 failed');
  assert.equal(out.claimed, false);
  assert.equal(out.code, 9004);
  assert.match(out.message, /no device id/);
});

test('网络异常报 failed 并带原因', async () => {
  const out = await createTraeStatus(deps({
    claimCheckin: async () => { throw new Error('ECONNREFUSED'); },
  })).checkin('cn');
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /ECONNREFUSED/);
});

test('AI 区域拒绝签到', async () => {
  const out = await createTraeStatus(deps({ region: 'ai' })).checkin('ai');
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /CN region/);
});

test('未装配 usage 时明确失败而不是静默成功', async () => {
  const d = deps();
  d.providers()[0].provider.usage = undefined;
  const out = await createTraeStatus(d).checkin('cn');
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /not wired yet/);
});

test('HTTP 路由 POST /panel/api/trae/checkin 可用', async () => {
  const api = createPanelApi(deps());
  let body = '';
  let status = 0;
  const res = { headers: undefined, writeHead(s) { status = s; }, end(chunk) { body = chunk ?? ''; } };
  const req = { method: 'POST', url: '/panel/api/trae/checkin?region=cn', headers: {} };
  assert.equal(await api.handle(req, res, '/panel/api/trae/checkin'), true);
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).claimed, true);
});
