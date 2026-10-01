// Synchronization adapted from BeatSync; see third-party/beatsync-LICENSE.txt.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomClock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function measurement(data, received) {
    const { t0, t1, t2 } = data;
    if (![t0,t1,t2,received].every(Number.isFinite) || t2 < t1 || received < t0) return null;
    const rtt = received - t0 - (t2 - t1);
    if (rtt < 0 || rtt > 10000) return null;
    return { t0, t1, rtt, offset: ((t1 - t0) + (t2 - received)) / 2 };
  }
  function paired(first, second) {
    const clientGap=second.t0-first.t0,serverGap=second.t1-first.t1;
    if (clientGap<0 || serverGap<0 || Math.abs(serverGap-clientGap)>5) return null;
    return first.rtt<=second.rtt?first:second;
  }
  class RoomClock {
    constructor({now,send,onUpdate=()=>{},onStale=()=>{},timing=()=>({}),setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=id=>clearTimeout(id)}) {
      Object.assign(this,{now,send,onUpdate,onStale,timing,setTimer,clearTimer});
      this.sequence=0;this.active=false;this.samples=[];this.pending=null;
      this.offset=0;this.rtt=0;this.ready=false;this.lastGood=0;
    }
    start() { this.stop();this.active=true;this.lastGood=this.now();this.probe(); }
    stop() {
      this.active=false;this.pending=null;this.ready=false;this.samples=[];
      for(const key of ['secondTimer','deadline','nextTimer'])this.clearTimer(this[key]);
    }
    probe() {
      if(!this.active)return;
      const group={id:++this.sequence,sent:[],results:[]};this.pending=group;
      const send=index=>{
        if(!this.active || this.pending!==group)return;
        const timing=this.timing(),t0=this.now();group.sent[index]=t0;
        this.send({...timing,t0,groupId:group.id,index});
      };
      // Arm before sending so synchronous test transports are also safe.
      this.deadline=this.setTimer(()=>this.finish(group,null),3750);
      send(0);this.secondTimer=this.setTimer(()=>send(1),25);
    }
    receive(data) {
      const group=this.pending;
      if(!this.active || !group || data.groupId!==group.id || ![0,1].includes(data.index) ||
        data.t0!==group.sent[data.index] || group.results[data.index])return;
      const sample=measurement(data,this.now());if(!sample)return;
      group.results[data.index]=sample;
      if(group.results[0] && group.results[1])this.finish(group,paired(...group.results));
    }
    finish(group,sample) {
      if(this.pending!==group || !this.active)return;
      this.clearTimer(this.deadline);this.clearTimer(this.secondTimer);this.pending=null;
      if(sample){
        this.lastGood=this.now();this.samples.push(sample);
        if(this.samples.length>16)this.samples.shift();
        const best=this.samples.reduce((a,b)=>a.rtt<=b.rtt?a:b);
        this.offset=best.offset;
        this.rtt=this.samples.reduce((sum,s)=>sum+s.rtt,0)/this.samples.length;
        this.ready=this.samples.length>=16;
        this.onUpdate({offset:this.offset,rtt:this.rtt,ready:this.ready,count:this.samples.length});
      }else if(this.ready && this.now()-this.lastGood>10000){
        this.ready=false;this.samples=[];this.onStale();
      }
      this.nextTimer=this.setTimer(()=>this.probe(),this.ready?2500:50);
    }
  }
  return {RoomClock,measurement,paired};
});
