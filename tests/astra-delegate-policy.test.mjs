import test from 'node:test';
import assert from 'node:assert/strict';
import { medianDuration, shouldProbeCpu, preferCpu } from '../app/live/astra/delegate-policy.ts';

test('CPU probing requires sustained slow GPU inference, not a cold-start spike', () => {
  assert.equal(shouldProbeCpu('GPU',[400,15,12,14],false),false);
  assert.equal(shouldProbeCpu('GPU',[180,210,170],false),false);
  assert.equal(shouldProbeCpu('GPU',[180,210,170,190],false),true);
  assert.equal(shouldProbeCpu('GPU',[180,210,170,190],true),false);
  assert.equal(shouldProbeCpu('CPU',[180,210,170,190],false),false);
});

test('CPU wins only when measured faster and it does not lose a detected face', () => {
  assert.equal(preferCpu(190,[12,13],true,true),true);
  assert.equal(preferCpu(30,[29,31],true,true),false);
  assert.equal(preferCpu(190,[12,13],true,false),false);
  assert.equal(preferCpu(190,[],true,true),false);
  assert.equal(medianDuration([190,170,210,180]),185);
});
