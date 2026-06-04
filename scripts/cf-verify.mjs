// Verify (1) mobility PUT/update behaviour, (2) power-cycle loop profiles in ue.cfg.
import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
const HOST='192.168.10.202';
const KEY='C:\\Users\\Simnovus-Lab\\Documents\\private_key';
const T=await(await fetch(`http://${HOST}/v2/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})})).json().then(j=>j.access_token);
const H={Authorization:`Bearer ${T}`,'Content-Type':'application/json'};
const mob={antennaType:'isotropic',position:[4,3],referencePower:-25,ulAttenuation:60};
const call=async(m,p,b)=>{const r=await fetch(`http://${HOST}/v2${p}`,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=t?JSON.parse(t):undefined}catch{};return{s:r.status,t,j};};
const del=(id)=>fetch(`http://${HOST}/v2/testcases/${id}`,{method:'DELETE',headers:H}).catch(()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cells=()=>({cellConfig:{master:{product:'UE-SIM',ratType:'smartphone',carrierAggregation:false,channelSim:false,pdcchDecodeOpt:true,pdcchDecodeOptThreshold:0.1,turboIteration:14},cells:[{cellType:'4g',syncId:0,duplexMode:'FDD',band:'1',EARFCN:{dl:300,ul:18300},bandwidth:'5',prach:0,antennas:{dl:1,ul:1},rfCard:0,rxToTxLatency:4,txGain:[70],rxGain:[0],globalTimingAdvance:-1,mobility:mob}]}});
const subs=()=>({subsConfig:{subs:[{ueCount:1,servingCell:0,startingIMSI:1010123456789,nextIMSI:1,algorithm:'milenage',sharedKey:'00112233445566778899aabbccddeeff',op:'000102030405060708090A0B0C0D0E0F',resLength:8,securityContext:true,asRelease:13,redCap:false,ueCategoryType:'combined',ueCategory:'6',imeisv:'4085780000000102',powerControl:false,attachType:'normal',ueInitiatedEvents:'rrc',eventsInLoop:false,triggerTime:[10],pdnType:'ipv4',defaultApn:'',cipherAlgorithm:['eea0','eea1','eea2'],integrityAlgorithm:['eia0','eia1','eia2'],cqi:'auto',ri:'auto',pmi:'auto',preambleIndex:0}]}});
const upNoData=()=>({userPlaneConfig:{profiles:[{subscriberGroup:[0],dataType:'no_data',pdnType:'ipv4',apnName:''}]}});
const pc=(o)=>({powerCycleConfig:{profiles:[{subscriberGroup:[0],attachType:'bursty',attachRate:1,attachDelay:0,powerOnTime:20,powerOffTime:10,...o}]}});
const mobBody=(speed)=>({mobilityConfig:{profiles:[{subscriberGroup:[0],tripType:'roundTrip',loopProfile:'time',startDelay:5,duration:120,tripCount:1,waitTime:0,uePosition:[0,0],speed,direction:0,distance:50,fadingProfile:{fadingType:'epa',frequencyDoppler:70,mimoCorrelation:'low'},noiseSpectralDensity:-174}]}});

async function readUeCfg(){
  const ssh=new NodeSSH();
  await ssh.connect({host:'192.168.1.101',username:'sysadmin',privateKey:fs.readFileSync(KEY,'utf8'),readyTimeout:10000});
  const r=await ssh.execCommand("cat /root/ue/config/ue.cfg"); ssh.dispose(); return r.stdout;
}
async function statMtime(){const ssh=new NodeSSH();await ssh.connect({host:'192.168.1.101',username:'sysadmin',privateKey:fs.readFileSync(KEY,'utf8'),readyTimeout:10000});const r=await ssh.execCommand("stat -c %Y /root/ue/config/ue.cfg 2>/dev/null");ssh.dispose();return parseInt(r.stdout.trim(),10)||0;}
async function genUeCfg(id,name){
  await call('POST',`/testcases/${id}/executions`,{}).catch(()=>{});
  const t0=Date.now(); let raw;
  while(Date.now()-t0<75000){const r=await readUeCfg().catch(()=>'');const m=r.match(/"log_filename"\s*:\s*"([^"]+)"/);const nm=m&&m[1].split('/').pop().replace(/\.log$/,'');if(r.trim()&&(!name||nm===name)){raw=r;break;}await sleep(2500);}
  await call('POST',`/testcases/executions/current/stop?simulatorId=1`,{}).catch(()=>{});
  return raw;
}

console.log('===== 1) MOBILITY UPDATE (PUT) =====');
{
  const c=await call('POST','/tests/cells',cells()); const id=c.j.testCaseId;
  await call('POST',`/tests/${id}/subscribers`,subs());
  await call('POST',`/tests/${id}/user-plane`,upNoData());
  await call('POST',`/tests/${id}/power-cycle`,pc({loopProfile:'disable'}));
  const post=await call('POST',`/tests/${id}/mobility`,mobBody(5));
  console.log('  POST mobility (create):',post.s, post.j?.message||post.j?.status||'');
  const put=await call('PUT',`/tests/${id}/mobility`,mobBody(15));   // change speed 5->15
  console.log('  PUT  mobility (update speed 5->15):',put.s, JSON.stringify(put.j));
  // re-GET to see if anything changed
  const g=await call('GET',`/tests/${id}/mobility`);
  console.log('  GET  mobility speed now:', g.j?.mobilityConfig?.profiles?.[0]?.speed);
  // compare: do other sections accept PUT?
  const putSub=await call('PUT',`/tests/${id}/subscribers`,subs());
  const putPc=await call('PUT',`/tests/${id}/power-cycle`,pc({loopProfile:'disable'}));
  console.log('  (control) PUT subscribers:',putSub.s,' PUT power-cycle:',putPc.s);
  await del(id);
}

console.log('===== 2) LOOP PROFILE in ue.cfg =====');
for(const prof of [{loopProfile:'count',noOfPowerOnCycles:3},{loopProfile:'time',totalTestDuration:5000},{loopProfile:'disable'}]){
  const name=`cf-loop-${prof.loopProfile}-${Date.now().toString(36)}`;
  const c=await call('POST','/tests/cells',cells()); const id=c.j.testCaseId;
  await call('POST',`/tests/${id}/subscribers`,subs());
  await call('POST',`/tests/${id}/user-plane`,upNoData());
  await call('POST',`/tests/${id}/power-cycle`,pc(prof));
  await call('POST',`/tests/${id}/settings`,{settings:{loggingProfileName:'rrc_debug',successCriteriaName:'BLER Success',testCaseName:name,test_name:name}});
  const raw=await genUeCfg(id,name);
  if(!raw){console.log(`  ${prof.loopProfile}: no ue.cfg`); await del(id); continue;}
  const j=JSON.parse(raw); const u=j.ue_list?.[0]||{};
  const ev=(u.sim_events||[]).map(e=>`${e.event}@${e.start_time}`).join(' ');
  console.log(`  ${prof.loopProfile} ${JSON.stringify(prof).slice(0,40)}: sim_events=[${ev}]`);
  await del(id); await sleep(1500);
}
