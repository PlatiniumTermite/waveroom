'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RoomClock,measurement,paired}=require('../public/clock-sync');
const {scheduleDelay}=require('../public/sync-model');

test('four-timestamp measurement excludes server processing and preserves offset sign',()=>{
  const sample=measurement({t0:1000,t1:1110,t2:1114},1024);
  assert.equal(sample.rtt,20);assert.equal(sample.offset,100);
  assert.equal(measurement({t0:1000,t1:1110,t2:1120},1005),null);
  assert.equal(measurement({t0:NaN,t1:1110,t2:1114},1024),null);
});
test('paired probes reject distorted arrival gaps and select the lowest RTT',()=>{
  const first={t0:1000,t1:1100,rtt:20,offset:100};
  const second={t0:1025,t1:1125,rtt:10,offset:100};
  assert.equal(paired(first,second),second);
  assert.equal(paired(first,{...second,t1:1140}),null);
});
function fixture(){
  let now=1000,id=0,respond=true;
  const timers=new Map(),updates=[],sent=[],stale=[];
  const setTimer=(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;};
  const clock=new RoomClock({now:()=>now,setTimer,clearTimer:id=>timers.delete(id),
    onUpdate:x=>updates.push(x),onStale:()=>stale.push(now),send:data=>{
      sent.push(data);
      if(respond)setTimer(()=>clock.receive({...data,t1:data.t0+110,t2:data.t0+112}),22);
    }});
  function step(){const [id,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];timers.delete(id);now=timer.at;timer.fn();}
  return {clock,updates,sent,stale,timers,step,setRespond:value=>respond=value};
}
test('clock requires sixteen clean pairs, refreshes steadily and rejects duplicate replies',()=>{
  const f=fixture();f.clock.start();
  while(f.updates.length<15)f.step();assert.equal(f.clock.ready,false);
  while(f.updates.length<16)f.step();
  assert.equal(f.clock.ready,true);assert.equal(f.clock.offset,100);assert.equal(f.clock.rtt,20);
  assert.equal(f.sent.length,32);
  const old=f.sent[0];f.clock.receive({...old,t1:old.t0+110,t2:old.t0+112});
  assert.equal(f.updates.length,16);
  const last=f.sent.at(-1).t0;while(f.sent.length<33)f.step();
  assert.ok(f.sent.at(-1).t0-last>=2500);
  const count=f.updates.length;f.clock.stop();
  while(f.timers.size)f.step();
  assert.equal(f.updates.length,count);assert.equal(f.clock.ready,false);
});
test('lost probes invalidate old calibration and can recover without a socket reconnect',()=>{
  const f=fixture();f.clock.start();while(!f.clock.ready)f.step();f.setRespond(false);
  while(!f.stale.length)f.step();assert.equal(f.clock.ready,false);assert.equal(f.clock.samples.length,0);
  f.setRespond(true);while(!f.clock.ready)f.step();assert.equal(f.clock.offset,100);
  f.clock.stop();
});
test('adaptive delay follows slowest RTT and device compensation with bounded headroom',()=>{
  assert.equal(scheduleDelay([]),400);
  assert.equal(scheduleDelay([{rtt:100},{rtt:600}]),1100);
  assert.equal(scheduleDelay([{rtt:10,compensationMs:1000}]),1200);
  assert.equal(scheduleDelay([{rtt:10000,compensationMs:2000}]),3000);
  assert.equal(scheduleDelay([{rtt:NaN,compensationMs:Infinity}]),400);
});


test('default browser timers are not invoked with the clock object as their receiver',()=>{
  const vm=require('node:vm'),fs=require('node:fs');let calls=0;
  const context={setTimeout:function(){assert.notEqual(this?.constructor?.name,'RoomClock');calls++;return calls;},
    clearTimeout:function(){assert.notEqual(this?.constructor?.name,'RoomClock');calls++;}};
  vm.runInNewContext(fs.readFileSync('public/clock-sync.js','utf8'),context);
  const clock=new context.RoomClock.RoomClock({now:()=>1000,send:()=>{}});
  clock.start();clock.stop();assert.ok(calls>0);
});
