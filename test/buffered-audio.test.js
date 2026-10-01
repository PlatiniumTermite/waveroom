'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BufferedAudio = require('../public/buffered-audio');
function setup() {
  const sources=[];
  const context={currentTime:10,outputLatency:0.04,state:'running',createBufferSource(){
    const source={connect(){},disconnect(){},stop(){this.stopped=true;},
      start(when,offset){this.when=when;this.offset=offset;},
      playbackRate:{setValueAtTime(rate){source.rate=rate;}}};
    sources.push(source);return source;
  }};
  let ended=0;const engine=new BufferedAudio(context,{},()=>ended++);engine.buffer={duration:120};
  return {engine,context,sources,ended:()=>ended};
}
test('audio is scheduled ahead on the audio clock with output delay compensation',()=>{
  const {engine,context,sources}=setup();
  engine.schedule({playing:true,position:5,serverPlayAt:12000},10000);
  assert.equal(sources[0].when,11.96);assert.equal(sources[0].offset,5);
  context.currentTime=12.5;assert.ok(Math.abs(engine.position-5.5)<1e-9);
});
test('late arrivals schedule a matching future song position and can cancel before sound',()=>{
  const {engine,context,sources}=setup();
  engine.schedule({playing:true,position:0,serverPlayAt:8000},10000);
  assert.equal(sources[0].offset,2.16);assert.ok(Math.abs(sources[0].when-10.12)<1e-9);
  engine.stop(2);assert.equal(sources[0].stopped,true);assert.equal(sources[0].onended,null);
  context.currentTime=20;assert.equal(engine.position,2);
});
test('timing calibration shifts sound while drift correction preserves that offset',()=>{
  const {engine,context,sources}=setup();engine.advanceMs=50;
  engine.schedule({playing:true,position:0,serverPlayAt:12000},10000);
  assert.equal(sources[0].when,11.91);
  context.currentTime=13;engine.correct(1);
  assert.equal(engine.rate,1);
  assert.ok(Math.abs(engine.position-1.05)<1e-9);
});
test('clock slope correction keeps position continuous and cancels replaced sources',()=>{
  const {engine,context,sources,ended}=setup();
  engine.schedule({playing:true,position:0,serverPlayAt:12000},10000);
  context.currentTime=13;const before=engine.position;
  engine.correct(0.98);
  assert.equal(engine.rate,0.997);assert.ok(Math.abs(engine.position-before)<0.001);
  engine.schedule({playing:true,position:15,serverPlayAt:14000},13000);
  assert.equal(sources[0].stopped,true);assert.equal(sources[0].onended,null);
  sources[1].onended();assert.equal(ended(),1);assert.equal(engine.position,120);
});
test('suspended audio cannot announce a scheduled start',()=>{
  const {engine,context,sources}=setup();context.state='suspended';
  assert.throws(()=>engine.schedule({position:0,serverPlayAt:12000},10000),/Enable audio/);
  assert.equal(sources.length,0);
});


test('large clock jumps require rescheduling but scheduled future starts do not',()=>{
  const {engine,context}=setup();
  engine.schedule({playing:true,position:0,serverPlayAt:12000},10000);
  assert.notEqual(engine.correct(0),'resync');
  context.currentTime=13;
  assert.equal(engine.correct(3),'resync');
  assert.equal(engine.rate,1);
});
