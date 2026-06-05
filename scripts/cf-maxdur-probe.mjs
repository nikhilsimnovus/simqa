// Find the MAX configurable test duration (seconds) the box accepts, then
// verify the largest accepted value is reflected in ue.cfg.
import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
const HOST='192.168.10.202', KEY='C:\\Users\\Simnovus-Lab\\Documents\\private_key';
const T=await(await fetch(`http://${HOST}/v2/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})})).json().then(j=>j.access_token);
const H={Authorization:`Bearer ${T}`,'Content-Type':'application/json'};
const mob={antennaType:'isotropic',position:[4,3],referencePower:-25,ulAttenuation:60};
const call=async(m,p,b)=>{const r=await fetch(`http://${HOST}/v2${p}`,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=t?JSON.parse(t):undefined}catch{};return{s:r.status,t,j};};
const del=id=>fetch(`http://${HOST}/v2/testcases/${id}`,{method:'DELETE',headers:H}).catch(()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cells=()=>({cellConfig:{master:{product:'UE-SIM',ratType:'smartphone',carrierAggregation:false,channelSim:false,pdcchDecodeOpt:true,pdcchDecodeOptThreshold:0.1,turboIteration:14},cells:[{cellType:'4g',syncId:0,duplexMode:'FDD',band:'1',EARFCN:{dl:300,ul:18300},bandwidth:'5',prach:0,antennas:{dl:1,ul:1},rfCard:0,rxToTxLatency:4,txGain:[70],rxGain:[0],globalTimingAdvance:-1,mobility:mob}]}});
const subs=()=>({subsConfig:{subs:[{ueCount:1,servingCell:0,startingIMSI:1010123456789,nextIMSI:1,algorithm:'milenage',sharedKey:'00112233445566778899aabbccddeeff',op:'000102030405060708090A0B0C0D0E0F',resLength:8,securityContext:true,asRelease:13,redCap:false,ueCategoryType:'combined',ueCategory:'6',imeisv:'4085780000000102',powerControl:false,attachType:'normal',ueInitiatedEvents:'rrc',eventsInLoop:false,triggerTime:[10],pdnType:'ipv4',defaultApn:'',cipherAlgorithm:['eea0','eea1','eea2'],integrityAlgorithm:['eia0','eia1','eia2'],cqi:'auto',ri:'auto',pmi:'auto',preambleIndex:0}]}});
const up=(dur)=>({userPlaneConfig:{profiles:[{subscriberGroup:[0],dataType:'iperf',transportProtocol:'udp',serverIpAddress:'192.168.2.1',portRange:5000,pdnType:'ipv4',apnName:'',startDelay:5,sessionDuration:dur,dataLoop:false,loopCount:0,interSessionGap:5,dataDirection:'both',dataBitrate:{dl:{unit:'mbps',value:100},ul:{unit:'mbps',value:50}},payloadLength:1000,mtuSize:1500}]}});
const pc=(dur)=>({powerCycleConfig:{profiles:[{subscriberGroup:[0],loopProfile:'disable',attachType:'bursty',attachRate:1,attachDelay:0,powerOnTime:dur,powerOffTime:10}]}});

const H_ = (s)=>`${(s/3600).toFixed(1)}h`;
const CANDIDATES=[259200, 604800, 2592000, 31536000, 311040000, 2147483647, 4294967295];
// 72h, 168h(1wk), 720h(30d), 1yr, 3600d, int32max, uint32max
async function createWith(dur){
  const c=await call('POST','/tests/cells',cells()); if(c.s!==200) return {step:'cells',s:c.s,msg:c.t.slice(0,120)};
  const id=c.j.testCaseId;
  const sb=await call('POST',`/tests/${id}/subscribers`,subs()); if(sb.s!==200){await del(id);return{step:'subs',s:sb.s,msg:sb.t.slice(0,120),id};}
  const u=await call('POST',`/tests/${id}/user-plane`,up(dur)); if(u.s!==200){await del(id);return{step:'user-plane',s:u.s,msg:u.t.slice(0,140),id};}
  const p=await call('POST',`/tests/${id}/power-cycle`,pc(dur)); if(p.s!==200){await del(id);return{step:'power-cycle',s:p.s,msg:p.t.slice(0,140),id};}
  const st=await call('POST',`/tests/${id}/settings`,{settings:{loggingProfileName:'rrc_debug',successCriteriaName:'BLER Success',testCaseName:`cf-dur-${dur}`,test_name:`cf-dur-${dur}`}}); if(st.s!==200){await del(id);return{step:'settings',s:st.s,msg:st.t.slice(0,140),id};}
  return {step:'ok',s:200,id,name:`cf-dur-${dur}`};
}
console.log('=== create acceptance by duration (seconds) ===');
let maxOk=null, maxId=null, maxName=null;
for(const dur of CANDIDATES){
  const r=await createWith(dur);
  console.log(`  ${dur} (${H_(dur)}): ${r.step==='ok'?'ACCEPTED':'REJECTED@'+r.step+' '+r.s+' '+(r.msg||'')}`);
  if(r.step==='ok'){ if(maxId) await del(maxId); maxOk=dur; maxId=r.id; maxName=r.name; } else if(r.id){ await del(r.id); }
  await sleep(800);
}
console.log(`\nMax accepted: ${maxOk} (${maxOk?H_(maxOk):'-'})`);

if(maxId){
  console.log('=== verify max in ue.cfg (execute + retrieve) ===');
  await call('POST',`/testcases/${maxId}/executions`,{}).catch(()=>{});
  const readCfg=async()=>{const s=new NodeSSH();await s.connect({host:'192.168.1.101',username:'sysadmin',privateKey:fs.readFileSync(KEY,'utf8'),readyTimeout:10000});const r=await s.execCommand('cat /root/ue/config/ue.cfg');s.dispose();return r.stdout;};
  let raw; const t0=Date.now();
  while(Date.now()-t0<75000){const r=await readCfg().catch(()=>'');const m=r.match(/"log_filename"\s*:\s*"([^"]+)"/);const nm=m&&m[1].split('/').pop().replace(/\.log$/,'');if(r.trim()&&nm===maxName){raw=r;break;}await sleep(2500);}
  await call('POST',`/testcases/executions/current/stop?simulatorId=1`,{}).catch(()=>{});
  if(raw){const j=JSON.parse(raw);const u=j.ue_list[0];const po=(u.sim_events||[]).find(e=>e.event==='power_off')?.start_time;const sd=u.traffic?.[0]?.iperf?.[0]?.session_duration;console.log(`  power_off.start_time=${po} (exp ${maxOk}) ${po===maxOk?'PASS':'MISMATCH'}; session_duration=${sd} (exp ${maxOk}) ${sd===maxOk?'PASS':'MISMATCH'}`);
   fs.mkdirSync('data/cf-report/maxdur',{recursive:true}); fs.writeFileSync('data/cf-report/maxdur/ue.cfg',raw); console.log('  wrote data/cf-report/maxdur/ue.cfg ('+raw.length+' bytes)');
  } else console.log('  no ue.cfg retrieved');
  await del(maxId);
}
