"use strict";
/* ===========================================================================
   engine.js — SALINAN LOGIKA SINYAL DARI index.html (tanpa perubahan strategi)
   Dipakai oleh scan.js di GitHub Actions. Jika Anda mengubah indikator atau
   aturan sinyal di index.html, ubah juga file ini agar hasilnya tetap sama.
   =========================================================================== */
const finite=Number.isFinite;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)), mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
function fmt(n,d=2){return finite(n)?n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"--"}
function fmtP(n){if(!finite(n))return"--";const d=n>=1000?2:n>=1?4:n>=0.01?6:8;return n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d})}
const SIG={window:300,minCandles:60,minValid:7,maxBars:24,minSample:30,backtestStart:100,oosShare:0.3};
const GROUPS={ema:"trend",sma:"trend",macd:"trend",adx:"trend",rsi:"momentum",stochrsi:"momentum",cci:"momentum",bb:"band",atr:"band",obv:"volume"};
const GROUP_W={trend:.35,momentum:.25,band:.2,volume:.2};

const TA={
emaSeries(a,p){const out=new Array(a.length).fill(NaN);if(a.length<p)return out;let v=mean(a.slice(0,p));out[p-1]=v;const k=2/(p+1);for(let i=p;i<a.length;i++){v=a[i]*k+v*(1-k);out[i]=v}return out},
ema(a,p){const s=this.emaSeries(a,p);return s.length?s[s.length-1]:NaN},
sma(a,p){return a.length>=p?mean(a.slice(-p)):NaN},
smaSeries(a,p){return a.map((_,i)=>{if(i<p-1)return NaN;const w=a.slice(i-p+1,i+1);return w.every(x=>finite(x))?mean(w):NaN})},
rsi(a,p=14){if(a.length<p+1)return NaN;let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}g/=p;l/=p;for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p}return l===0?(g===0?50:100):100-100/(1+g/l)},
rsiSeries(a,p=14){const out=new Array(a.length).fill(NaN);if(a.length<p+1)return out;let g=0,l=0;for(let i=1;i<=p;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}g/=p;l/=p;const val=()=>l===0?(g===0?50:100):100-100/(1+g/l);out[p]=val();for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;out[i]=val()}return out},
stochRsi(a,rp=14,sp=14,kp=3,dp=3){const rs=this.rsiSeries(a,rp),raw=rs.map((v,i)=>{if(i<sp-1)return NaN;const w=rs.slice(i-sp+1,i+1);if(!w.every(x=>finite(x)))return NaN;const hi=Math.max(...w),lo=Math.min(...w);return hi===lo?50:(rs[i]-lo)/(hi-lo)*100});const k=this.smaSeries(raw,kp),d=this.smaSeries(k,dp);return {k:k[k.length-1],d:d[d.length-1]}},
macd(a){if(a.length<35)return {line:NaN,signal:NaN,histogram:NaN};const e12=this.emaSeries(a,12),e26=this.emaSeries(a,26),m=[];for(let i=25;i<a.length;i++)m.push(e12[i]-e26[i]);const sg=this.emaSeries(m,9),line=m[m.length-1],signal=sg[sg.length-1];return {line,signal,histogram:line-signal}},
bb(a,p=20,k=2){if(a.length<p)return {upper:NaN,middle:NaN,lower:NaN,width:NaN};let s=a.slice(-p),m=mean(s),sd=Math.sqrt(mean(s.map(x=>(x-m)**2)));return {upper:m+k*sd,middle:m,lower:m-k*sd,width:m?2*k*sd/m:NaN}},
atrSeries(h,l,c,p=14){const n=c.length,out=new Array(n).fill(NaN);if(n<p+1)return out;const tr=new Array(n).fill(0);for(let j=1;j<n;j++)tr[j]=Math.max(h[j]-l[j],Math.abs(h[j]-c[j-1]),Math.abs(l[j]-c[j-1]));let v=mean(tr.slice(1,p+1));out[p]=v;for(let i=p+1;i<n;i++){v=(v*(p-1)+tr[i])/p;out[i]=v}return out},
adx(h,l,c,p=14){const n=c.length;if(n<2*p+2)return {adx:NaN,plusDI:NaN,minusDI:NaN};const tr=[],pd=[],md=[];for(let i=1;i<n;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];pd.push(up>dn&&up>0?up:0);md.push(dn>up&&dn>0?dn:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])))}
let sT=0,sP=0,sM=0;for(let i=0;i<p;i++){sT+=tr[i];sP+=pd[i];sM+=md[i]}
const dxs=[];let pdi=0,mdi=0;const calc=()=>{pdi=sT?100*sP/sT:0;mdi=sT?100*sM/sT:0;dxs.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0)};calc();
for(let i=p;i<tr.length;i++){sT=sT-sT/p+tr[i];sP=sP-sP/p+pd[i];sM=sM-sM/p+md[i];calc()}
if(dxs.length<p)return {adx:NaN,plusDI:pdi,minusDI:mdi};let a=mean(dxs.slice(0,p));for(let j=p;j<dxs.length;j++)a=(a*(p-1)+dxs[j])/p;return {adx:a,plusDI:pdi,minusDI:mdi}},
cci(h,l,c,p=20){const n=c.length;if(n<p)return NaN;const tp=[];for(let i=n-p;i<n;i++)tp.push((h[i]+l[i]+c[i])/3);const m=mean(tp),md=mean(tp.map(x=>Math.abs(x-m)));return md===0?0:(tp[tp.length-1]-m)/(0.015*md)},
obvSeries(cs){const out=new Array(cs.length).fill(0);for(let i=1;i<cs.length;i++){const d=cs[i].close-cs[i-1].close;out[i]=out[i-1]+(d>0?cs[i].volume:d<0?-cs[i].volume:0)}return out}
};

function evaluateIndicators(cs){
const n=cs.length,c=cs.map(x=>x.close),h=cs.map(x=>x.high),l=cs.map(x=>x.low),p=c[n-1],list=[],ctx={};
const push=(key,name,value,dir,note)=>list.push({key,name,group:GROUPS[key],value,dir,note});
const na=(key,name,why)=>push(key,name,"--","na","Gagal dihitung ("+why+")");
const atrS=TA.atrSeries(h,l,c,14),atrNow=atrS[n-1];ctx.atr=atrNow;
const rsi=TA.rsi(c);
if(!finite(rsi))na("rsi","RSI (14)","butuh minimal 15 candle");
else{let d,t;
if(rsi>70){d="neutral";t="Jenuh beli (>70)"}else if(rsi<30){d="neutral";t="Jenuh jual (<30)"}
else if(rsi>=55){d="bull";t="Momentum naik (55–70)"}else if(rsi<=45){d="bear";t="Momentum turun (30–45)"}
else{d="neutral";t="Zona tengah 45–55"}
push("rsi","RSI (14)",fmt(rsi,1),d,t)}
const m=TA.macd(c);
if(!finite(m.histogram)||!finite(atrNow))na("macd","MACD (12,26,9)","butuh minimal 35 candle");
else{const th=0.02*atrNow;let d,t;
if(m.histogram>th&&m.line>m.signal){d="bull";t="Histogram positif"}
else if(m.histogram<-th&&m.line<m.signal){d="bear";t="Histogram negatif"}
else{d="neutral";t="Mendekati nol"}
push("macd","MACD (12,26,9)",fmt(m.histogram,p<1?6:4),d,t)}
const e9=TA.ema(c,9),e21=TA.ema(c,21);ctx.ema21=e21;
if(!finite(e9)||!finite(e21))na("ema","EMA 9/21","butuh minimal 21 candle");
else{let d,t;
if(e9>e21&&p>e21){d="bull";t="EMA 9 > EMA 21 & Harga > EMA 21"}
else if(e9<e21&&p<e21){d="bear";t="EMA 9 < EMA 21 & Harga < EMA 21"}
else{d="neutral";t="Persilangan netral"}
push("ema","EMA 9/21",fmtP(e9)+" / "+fmtP(e21),d,t)}
const s20=TA.sma(c,20),s50=TA.sma(c,50);
if(!finite(s20)||!finite(s50))na("sma","SMA 20/50","butuh minimal 50 candle");
else{let d,t;
if(s20>s50&&p>s50){d="bull";t="SMA 20 > SMA 50"}
else if(s20<s50&&p<s50){d="bear";t="SMA 20 < SMA 50"}
else{d="neutral";t="Netral"}
push("sma","SMA 20/50",fmtP(s20)+" / "+fmtP(s50),d,t)}
const b=TA.bb(c);
if(!finite(b.upper)||!finite(b.lower)||b.upper<=b.lower)na("bb","Bollinger Bands (20,2)","butuh minimal 20 candle");
else{const pct=(p-b.lower)/(b.upper-b.lower);let d,t;
if(pct>1||pct<0){d="neutral";t="Ekstrem di luar band"}
else if(pct>=0.55){d="bull";t="Di paruh atas band"}
else if(pct<=0.45){d="bear";t="Di paruh bawah band"}
else{d="neutral";t="Di tengah band"}
push("bb","Bollinger Bands (20,2)","%B "+fmt(pct*100,0)+"%",d,t)}
const sr=TA.stochRsi(c);
if(!finite(sr.k)||!finite(sr.d))na("stochrsi","Stochastic RSI","butuh minimal 35 candle");
else{let d,t;
if(sr.k>sr.d&&sr.k<80){d="bull";t="%K > %D"}
else if(sr.k<sr.d&&sr.k>20){d="bear";t="%K < %D"}
else{d="neutral";t="Jenuh / Netral"}
push("stochrsi","Stochastic RSI (14,14,3,3)","K "+fmt(sr.k,1)+" / D "+fmt(sr.d,1),d,t)}
const a=TA.adx(h,l,c);ctx.adx=a.adx;
if(!finite(a.adx))na("adx","ADX (14)","butuh minimal 30 candle");
else{let d,t;
if(a.adx>=20&&a.plusDI>a.minusDI){d="bull";t="ADX ≥ 20 (+DI > -DI)"}
else if(a.adx>=20&&a.minusDI>a.plusDI){d="bear";t="ADX ≥ 20 (-DI > +DI)"}
else{d="neutral";t="ADX < 20"}
push("adx","ADX (14)",fmt(a.adx,1)+" (+DI "+fmt(a.plusDI,1)+" / -DI "+fmt(a.minusDI,1)+")",d,t)}
const cci=TA.cci(h,l,c);
if(!finite(cci))na("cci","CCI (20)","butuh minimal 20 candle");
else{let d,t;
if(cci>100&&cci<=200){d="bull";t="CCI > +100"}
else if(cci<-100&&cci>=-200){d="bear";t="CCI < -100"}
else{d="neutral";t="Netral"}
push("cci","CCI (20)",fmt(cci,1),d,t)}
const obv=TA.obvSeries(cs);
if(n<26)na("obv","OBV","butuh minimal 26 candle");
else{const oe=TA.emaSeries(obv,20),eNow=oe[n-1],now=obv[n-1],prev=obv[n-6];let d,t;
if(!finite(eNow))na("obv","OBV","EMA OBV N/A");
else{
if(now>eNow&&now>prev){d="bull";t="OBV naik di atas EMA 20"}
else if(now<eNow&&now<prev){d="bear";t="OBV turun di bawah EMA 20"}
else{d="neutral";t="OBV netral"}
push("obv","OBV",fmt(now,0),d,t)}}
const atrVals=atrS.slice(-20).filter(x=>finite(x));
if(!finite(atrNow)||atrVals.length<10||n<5)na("atr","ATR (14)","butuh 25 candle");
else{const avg=mean(atrVals),exp=atrNow>avg*1.05,chg=c[n-1]-c[n-4];ctx.atrExp=exp;let d,t;
if(exp&&Math.abs(chg)>0.5*atrNow){d=chg>0?"bull":"bear";t="Volatilitas meluas"}
else{d="neutral";t="Volatilitas normal"}
push("atr","ATR (14)",fmtP(atrNow),d,t)}
return {list,ctx};
}
function swingExt(cs,k,type){const s=cs.slice(-k);return type==="L"?Math.min(...s.map(x=>x.low)):Math.max(...s.map(x=>x.high))}
function buildLevels(s,cs,ctx){
const p=cs[cs.length-1].close,atr=ctx.atr,ema21=ctx.ema21;
let far=p-s*0.5*atr;
if(finite(ema21)&&((s===1&&ema21<p&&ema21>far)||(s===-1&&ema21>p&&ema21<far)))far=ema21;
if(Math.abs(p-far)<0.1*atr)far=p-s*0.1*atr;
const low=Math.min(p,far),high=Math.max(p,far),mid=(low+high)/2;let sl;
if(s===1){const sw=swingExt(cs,10,"L")-0.25*atr;sl=sw<low?sw:mid-1.5*atr;sl=Math.max(mid-2.5*atr,Math.min(sl,mid-1.0*atr))}
else{const sw=swingExt(cs,10,"H")+0.25*atr;sl=sw>high?sw:mid+1.5*atr;sl=Math.min(mid+2.5*atr,Math.max(sl,mid+1.0*atr))}
const risk=Math.abs(mid-sl);
return {low,high,mid,sl,risk,rr:[1,2,3],tps:[1,2,3].map(k=>mid+s*k*risk)};
}
function computeSignal(all){
const cs=all.slice(-SIG.window),last=cs[cs.length-1];
const base={time:last?last.time:0,price:last?last.close:NaN,list:[],g:0,y:0,r:0,nv:0,strength:null,dom:0,weak:false,levels:null,filterMsg:""};
if(cs.length<SIG.minCandles)return {...base,status:"INSUFFICIENT",reason:`Data candle tertutup belum cukup (${cs.length}/${SIG.minCandles}).`,invalid:"--"};
const {list,ctx}=evaluateIndicators(cs),valid=list.filter(x=>x.dir!=="na"),nv=valid.length;
const g=valid.filter(x=>x.dir==="bull").length,r=valid.filter(x=>x.dir==="bear").length,y=valid.filter(x=>x.dir==="neutral").length;
const res={...base,list,g,y,r,nv};
if(nv<SIG.minValid)return {...res,status:"INSUFFICIENT",reason:`Hanya ${nv} indikator valid.`,invalid:"--"};
const minVotes=Math.ceil(0.6*nv),minMargin=Math.ceil(0.3*nv);
let status="NEUTRAL";
if(g>=minVotes&&g-r>=minMargin)status="BUY";else if(r>=minVotes&&r-g>=minMargin)status="SELL";
const s=status==="BUY"?1:status==="SELL"?-1:0,adxV=ctx.adx;
if(s!==0){
const ema=list.find(x=>x.key==="ema"),sma=list.find(x=>x.key==="sma"),adx=list.find(x=>x.key==="adx"),opp=s===1?"bear":"bull";
if(ema&&sma&&ema.dir===opp&&sma.dir===opp)res.filterMsg="Filter tren bertentangan.";
else if(adx&&adx.dir===opp&&adxV>=25)res.filterMsg="Filter ADX bertentangan.";
if(res.filterMsg)status="NEUTRAL";
}
res.status=status;res.weak=!(adxV>=20);
if(status==="NEUTRAL"){res.reason="Belum ada konfirmasi suara mayoritas indikator.";res.invalid="--";return res;}
const sc=d=>d==="bull"?1:d==="bear"?-1:0;let num=0,den=0;
for(const gr in GROUP_W){const mm=valid.filter(x=>x.group===gr);if(!mm.length)continue;num+=GROUP_W[gr]*s*mean(mm.map(x=>sc(x.dir)));den+=GROUP_W[gr]}
const dom=den?clamp(num/den,-1,1):0,adxF=finite(adxV)?clamp((adxV-15)/25,0,1):0,volF=ctx.atrExp?1:0.4;
res.dom=s*Math.max(0,dom);res.strength=Math.round(100*clamp(0.65*Math.max(0,dom)+0.2*adxF+0.15*volF,0,1));
res.levels=buildLevels(s,cs,ctx);
res.reason=`${s===1?'BUY':'SELL'} terkonfirmasi: ${g} hijau, ${y} kuning, ${r} merah dari ${nv} indikator.`;
res.invalid=`Candle ditutup menembus Stop Loss ${fmtP(res.levels.sl)}.`;
return res;
}

module.exports={computeSignal,SIG};
