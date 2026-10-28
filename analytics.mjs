// 응시 기록은 {id, studentName, studentCode, submittedAt, score, maxScore, resultItems: []} 형태입니다.
// 문항 무작위 출제를 고려하여 문항별 실제 노출 인원으로 정답률을 계산합니다.
const round = (n, digits = 1) => Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
const pct = (a,b) => b > 0 ? (a/b)*100 : 0;
const dateValue = (v) => { const n=Date.parse(v||''); return Number.isFinite(n) ? n : 0; };
const getStudentKey = (a) => (String(a.studentCode||'').trim() || String(a.studentName||'').trim());

export function chooseAttempts(all, policy='latest') {
  const filtered=(all||[]).filter(a=>a.status==='submitted' && Array.isArray(a.resultItems));
  if (policy==='all') return [...filtered].sort((a,b)=>dateValue(b.submittedAt)-dateValue(a.submittedAt));
  const byStudent=new Map();
  for(const a of filtered){
    const key=getStudentKey(a);
    const old=byStudent.get(key);
    if(!old || (policy==='highest'
      ? (pct(a.score,a.maxScore)>pct(old.score,old.maxScore) || (pct(a.score,a.maxScore)===pct(old.score,old.maxScore)&&dateValue(a.submittedAt)>dateValue(old.submittedAt)))
      : dateValue(a.submittedAt)>dateValue(old.submittedAt))) byStudent.set(key,a);
  }
  return [...byStudent.values()].sort((a,b)=>dateValue(b.submittedAt)-dateValue(a.submittedAt));
}
function correlation(x,y) {
  if(x.length<5 || x.length!==y.length)return null;
  const xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;
  let num=0,xd=0,yd=0;
  for(let i=0;i<x.length;i++){let a=x[i]-xm,b=y[i]-ym;num+=a*b;xd+=a*a;yd+=b*b;}
  return xd>0&&yd>0?num/Math.sqrt(xd*yd):null;
}
export function analyzeAttempts(all, policy='latest') {
  const attempts=chooseAttempts(all,policy);
  const students=attempts.map(a=>({
    id:a.id,name:a.studentName||'이름 없음',studentCode:a.studentCode||'',submittedAt:a.submittedAt,
    score:Number(a.score)||0,maxScore:Number(a.maxScore)||0,rate:round(pct(Number(a.score),Number(a.maxScore))),
    correct:a.resultItems.filter(r=>r.isCorrect).length, count:a.resultItems.length,
    level: pct(Number(a.score),Number(a.maxScore))>=90?'A':pct(Number(a.score),Number(a.maxScore))>=80?'B':pct(Number(a.score),Number(a.maxScore))>=70?'C':pct(Number(a.score),Number(a.maxScore))>=60?'D':'E'
  }));
  const rows=[];
  for(const a of attempts){
    const byId=new Map();
    for(const r of a.resultItems){if(!r.questionId)continue;byId.set(String(r.questionId),r);}
    for(const r of byId.values()){
      const points=Number(r.points)||0, earned=Number(r.earned)||0;
      const restMax=Number(a.maxScore)-points;
      rows.push({...r, attemptId:a.id,studentName:a.studentName||'',studentCode:a.studentCode||'',submittedAt:a.submittedAt,
        restRate:restMax>0?(Number(a.score)-earned)/restMax*100:null,
        totalRate:pct(Number(a.score),Number(a.maxScore))});
    }
  }
  const grouped=new Map();const unitMap=new Map();
  for(const r of rows){
    if(!grouped.has(r.questionId))grouped.set(r.questionId,[]);
    grouped.get(r.questionId).push(r);
    if(!unitMap.has(r.unit))unitMap.set(r.unit,{earned:0,available:0,n:0});
    const u=unitMap.get(r.unit);u.earned+=Number(r.earned)||0;u.available+=Number(r.points)||0;u.n++;
  }
  const items=[];const choices=[];
  for(const [id,group] of grouped){
    const n=group.length, correct=group.filter(r=>r.isCorrect).length,rate=pct(correct,n);
    const disc=correlation(group.map(r=>r.isCorrect?1:0),group.map(r=>r.restRate));
    const ordered=[...group].sort((a,b)=>b.totalRate-a.totalRate);
    const k=n>=5?Math.max(1,Math.ceil(n*.27)):0;
    const upper=k? pct(ordered.slice(0,k).filter(r=>r.isCorrect).length,k):null;
    const lower=k? pct(ordered.slice(-k).filter(r=>r.isCorrect).length,k):null;
    items.push({id, unit:group[0].unit||'기타',difficulty:group[0].difficulty||'',prompt:group[0].prompt||'',exposures:n,correct,wrong:n-correct,rate:round(rate),
      analyzedDifficulty:rate>=80?'쉬움':rate<40?'어려움':'보통',discrimination:round(disc,3),upper:round(upper),lower:round(lower),gap:upper===null?null:round(upper-lower)});
    const choiceMap=new Map();
    for(const r of group){
      const text=String(r.selectedText||'(미선택)');
      const key=`${text}\u0000${Boolean(r.isCorrect)}`;
      if(!choiceMap.has(key))choiceMap.set(key,{questionId:id,option:text,isCorrect:Boolean(r.isCorrect),count:0});
      choiceMap.get(key).count++;
    }
    for(const c of choiceMap.values())choices.push({...c,rate:round(pct(c.count,n))});
  }
  items.sort((a,b)=>a.id.localeCompare(b.id,'ko'));
  choices.sort((a,b)=>a.questionId.localeCompare(b.questionId,'ko')||b.count-a.count);
  const units=[...unitMap.entries()].map(([unit,v])=>({unit,rate:round(pct(v.earned,v.available)),exposures:v.n})).sort((a,b)=>a.rate-b.rate);
  return {attempts,students,items,choices,units,
    summary:{attempts:attempts.length,uniqueStudents:new Set(attempts.map(getStudentKey)).size,
      average:round(students.length?students.reduce((a,b)=>a+b.rate,0)/students.length:0),
      questionCount:items.length, lowItems:items.filter(i=>i.rate<40).length},
    responses:rows};
}
