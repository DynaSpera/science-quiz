// Science Quiz v2: 학생/학년도 식별, 문항 내용별 버전 분리, 중복 응시 정책.
const round = (n, digits=1) => Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
const pct = (a,b) => b>0 ? a/b*100 : 0;
const dateValue = (v) => { const n=Date.parse(v||''); return Number.isFinite(n)?n:0; };
const yearOf = (a) => Number(a.academicYear)||Number(String(a.submittedAt||a.startedAt||'').slice(0,4))||0;
export const getStudentKey = (a) => `${yearOf(a)}:${String(a.studentCode||'').trim()||`이름:${String(a.studentName||'').trim()}`}`;
export const questionSignature = r => JSON.stringify([
  String(r.questionId||''),String(r.unit||''),String(r.difficulty||''),
  String(r.prompt||'').trim(),String(r.correctText||'').trim(),
  Number(r.points)||0,String(r.explanation||'').trim(),Number(r.questionVersion)>1?Number(r.questionVersion):0
]);
export function chooseAttempts(all,policy='latest'){
 const filtered=(all||[]).filter(a=>a.status==='submitted'&&Array.isArray(a.resultItems));
 if(policy==='all')return [...filtered].sort((a,b)=>dateValue(b.submittedAt)-dateValue(a.submittedAt));
 const byStudent=new Map();
 for(const a of filtered){
   const key=getStudentKey(a),old=byStudent.get(key),nowRate=pct(Number(a.score),Number(a.maxScore));
   const oldRate=old?pct(Number(old.score),Number(old.maxScore)):0;
   if(!old||(policy==='highest'?(nowRate>oldRate||(nowRate===oldRate&&dateValue(a.submittedAt)>dateValue(old.submittedAt))):dateValue(a.submittedAt)>dateValue(old.submittedAt)))byStudent.set(key,a);
 }
 return [...byStudent.values()].sort((a,b)=>dateValue(b.submittedAt)-dateValue(a.submittedAt));
}
function correlation(x,y){
 if(x.length<5||x.length!==y.length||x.some(n=>!Number.isFinite(n))||y.some(n=>!Number.isFinite(n)))return null;
 const xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;
 let num=0,xd=0,yd=0;
 for(let i=0;i<x.length;i++){const a=x[i]-xm,b=y[i]-ym;num+=a*b;xd+=a*a;yd+=b*b;}
 return xd>0&&yd>0?num/Math.sqrt(xd*yd):null;
}
function schoolInfo(a){
 const s=String(a.studentCode||'').trim(),year=yearOf(a);
 return {academicYear:year||'미지정',grade:/^\d{5}$/.test(s)?s[0]:'—',classNo:/^\d{5}$/.test(s)?String(Number(s.slice(1,3))):'—'};
}
function level(rate,count){if(count<5)return '참고';return rate>=90?'A':rate>=80?'B':rate>=70?'C':rate>=60?'D':'E';}
export function analyzeAttempts(all,policy='latest',versionHistory=all){
 const historicSubmitted=(versionHistory||[]).filter(a=>a.status==='submitted'&&Array.isArray(a.resultItems));
 const allSubmitted=(all||[]).filter(a=>a.status==='submitted'&&Array.isArray(a.resultItems));
 const attempts=chooseAttempts(allSubmitted,policy);
 // 응시 정책으로 일부 기록이 제외되더라도 문항의 버전 번호는 바뀌지 않도록 전체 기록으로 순서 부여.
 const versionOrder=new Map();
 for(const a of [...historicSubmitted].sort((x,y)=>dateValue(x.submittedAt)-dateValue(y.submittedAt))){
   for(const r of a.resultItems||[]){if(!r.questionId)continue;
     const id=String(r.questionId),signature=questionSignature(r);
     if(!versionOrder.has(id))versionOrder.set(id,new Map());
     const versions=versionOrder.get(id);
     if(!versions.has(signature))versions.set(signature,versions.size+1);
   }
 }
 const students=attempts.map(a=>{
   const info=schoolInfo(a),rate=pct(Number(a.score),Number(a.maxScore));
   return {id:a.id,name:a.studentName||'이름 없음',studentCode:a.studentCode||'',...info,
     isTest:!!a.isTest,submittedAt:a.submittedAt,score:Number(a.score)||0,maxScore:Number(a.maxScore)||0,
     rate:round(rate),correct:a.resultItems.filter(r=>r.isCorrect).length,count:a.resultItems.length,
     level:level(rate,a.resultItems.length)};
 });
 const rows=[];
 for(const a of attempts){
   const byId=new Map();
   for(const r of a.resultItems){if(r.questionId)byId.set(String(r.questionId),r);}
   for(const r of byId.values()){
     const points=Number(r.points)||0,earned=Number(r.earned)||0,restMax=Number(a.maxScore)-points;
     const signature=questionSignature(r),version=versionOrder.get(String(r.questionId))?.get(signature)||1;
     const itemCount=versionOrder.get(String(r.questionId))?.size||1;
     rows.push({...r,academicYear:yearOf(a),isTest:!!a.isTest,version,itemKey:`${r.questionId}::${version}`,
       versionLabel:itemCount>1?`${r.questionId} (v${version})`:String(r.questionId),
       attemptId:a.id,studentName:a.studentName||'',studentCode:a.studentCode||'',submittedAt:a.submittedAt,
       restRate:restMax>0?(Number(a.score)-earned)/restMax*100:null,totalRate:pct(Number(a.score),Number(a.maxScore))});
   }
 }
 const grouped=new Map(),unitMap=new Map();
 for(const r of rows){
   if(!grouped.has(r.itemKey))grouped.set(r.itemKey,[]);
   grouped.get(r.itemKey).push(r);
   const u=unitMap.get(r.unit)||{earned:0,available:0,n:0};u.earned+=Number(r.earned)||0;u.available+=Number(r.points)||0;u.n++;unitMap.set(r.unit,u);
 }
 const items=[],choices=[];
 for(const [key,group] of grouped){
   const first=group[0],n=group.length,correct=group.filter(r=>r.isCorrect).length,rate=pct(correct,n);
   const pairs=group.filter(r=>Number.isFinite(r.restRate));
   const disc=correlation(pairs.map(r=>r.isCorrect?1:0),pairs.map(r=>r.restRate));
   const ordered=[...group].sort((a,b)=>b.totalRate-a.totalRate);
   const k=n>=5?Math.max(1,Math.ceil(n*.27)):0;
   const upper=k?pct(ordered.slice(0,k).filter(r=>r.isCorrect).length,k):null;
   const lower=k?pct(ordered.slice(-k).filter(r=>r.isCorrect).length,k):null;
   items.push({id:first.questionId,version:first.version,itemKey:key,label:first.versionLabel,
     unit:first.unit||'기타',difficulty:first.difficulty||'',prompt:first.prompt||'',exposures:n,
     correct,wrong:n-correct,rate:round(rate),
     analyzedDifficulty:n<5?'판단 유보':rate>=80?'쉬움':rate<40?'어려움':'보통',
     sampleStatus:n<5?'표본 부족':n<20?'참고용':'충분성 검토',
     discrimination:round(disc,3),discriminationStatus:n<5?'표본 부족':disc===null?'계산 불가':'계산됨',
     upper:round(upper),lower:round(lower),gap:upper===null?null:round(upper-lower)});
   const choiceMap=new Map();
   for(const r of group){const text=String(r.selectedText||'(미선택)'),ck=`${text}\0${Boolean(r.isCorrect)}`;
     if(!choiceMap.has(ck))choiceMap.set(ck,{questionId:r.questionId,itemKey:key,version:r.version,versionLabel:r.versionLabel,option:text,isCorrect:Boolean(r.isCorrect),count:0});
     choiceMap.get(ck).count++;
   }
   for(const c of choiceMap.values())choices.push({...c,rate:round(pct(c.count,n))});
 }
 items.sort((a,b)=>a.id.localeCompare(b.id,'ko')||a.version-b.version);
 choices.sort((a,b)=>a.questionId.localeCompare(b.questionId,'ko')||a.version-b.version||b.count-a.count);
 const units=[...unitMap.entries()].map(([unit,v])=>({unit,rate:round(pct(v.earned,v.available)),exposures:v.n})).sort((a,b)=>a.rate-b.rate);
 return {attempts,students,items,choices,units,responses:rows,
  summary:{attempts:attempts.length,uniqueStudents:new Set(attempts.map(getStudentKey)).size,
   average:round(students.length?students.reduce((a,b)=>a+b.rate,0)/students.length:0),
   questionCount:items.length,lowItems:items.filter(i=>i.exposures>=5&&i.rate<40).length}};
}
