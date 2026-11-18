"""Regenerates src/research/scipy-vectors.json: reference values computed by scipy.
Run with an environment that has scipy + numpy (e.g. .venv-ocr):
    .venv-ocr/bin/python -I scripts/gen-stats-vectors.py > src/research/scipy-vectors.json
The TypeScript statistics in src/research/stats.ts are tested against these values."""
import json, numpy as np, scipy
from scipy import stats
out={'_provenance':{'generator':'scripts/gen-stats-vectors.py','scipy':scipy.__version__,'numpy':np.__version__}}
a=[5.1,4.9,6.2,5.8,6.0,5.5,4.7,6.4]; b=[6.9,7.2,6.1,7.8,6.6,7.4,8.0,7.1,6.8]
r=stats.ttest_ind(a,b,equal_var=False); ci=r.confidence_interval(0.95)
out['welch']={'a':a,'b':b,'t':r.statistic,'df':r.df,'p':r.pvalue,'diff':float(np.mean(a)-np.mean(b)),'ciLow':ci.low,'ciHigh':ci.high}
x=[2.5,3.1,3.7,4.0,4.2,5.9,6.3,7.7,8.1,9.4]
out['describe']={'x':x,'mean':float(np.mean(x)),'sd':float(np.std(x,ddof=1)),'median':float(np.median(x)),'q1':float(np.percentile(x,25)),'q3':float(np.percentile(x,75))}
w=[]
for k,n in [(7,20),(0,10),(10,10),(1,3)]:
    c=stats.binomtest(k,n).proportion_ci(confidence_level=0.95,method='wilson'); w.append({'k':k,'n':n,'low':c.low,'high':c.high})
out['wilson']=w
out['t_ppf']=[{'p':0.975,'df':d,'q':float(stats.t.ppf(0.975,d))} for d in (1,2,5,10,30,120.5)]
out['norm_ppf']=[{'p':p,'q':float(stats.norm.ppf(p))} for p in (0.001,0.025,0.5,0.8,0.975,0.999)]
out['norm_cdf']=[{'x':v,'c':float(stats.norm.cdf(v))} for v in (-3.5,-1.0,0.0,0.5,1.96,4.0)]
p=[0.001,0.008,0.039,0.041,0.042,0.06,0.074,0.205,0.212,0.216,0.222,0.251,0.269,0.275,0.34,0.341,0.384,0.569,0.594,0.696,0.762,0.94,0.942,0.975,0.986]
out['bh']={'p':p,'q':[float(v) for v in stats.false_discovery_control(p)]}
y=[0,0,0,0,1,0,1,1,0,1,1,1,0,1,1,0,1,0,1,1]; s=[0.1,0.2,0.15,0.4,0.35,0.3,0.7,0.8,0.45,0.9,0.65,0.6,0.5,0.55,0.85,0.35,0.95,0.2,0.5,0.75]
yy=np.array(y); ss=np.array(s)
u=stats.mannwhitneyu(ss[yy==1],ss[yy==0]).statistic
out['auc']={'y':y,'score':s,'auc':float(u/((yy==1).sum()*(yy==0).sum()))}
out['brier']={'y':y,'p':s,'brier':float(np.mean((ss-yy)**2))}
a1,n1,c1,n2=30,100,15,100
rr=(a1/n1)/(c1/n2); se=np.sqrt(1/a1-1/n1+1/c1-1/n2); z=stats.norm.ppf(0.975)
out['rr']={'a':a1,'n1':n1,'c':c1,'n2':n2,'rr':rr,'low':float(np.exp(np.log(rr)-z*se)),'high':float(np.exp(np.log(rr)+z*se))}
c1,t1,c2,t2=40,1000.0,25,1100.0
irr=(c1/t1)/(c2/t2); se=np.sqrt(1/c1+1/c2)
out['irr']={'c1':c1,'t1':t1,'c2':c2,'t2':t2,'irr':irr,'low':float(np.exp(np.log(irr)-z*se)),'high':float(np.exp(np.log(irr)+z*se))}
# Directly standardised rate, Fay-Feuer (1997) gamma interval, computed independently with scipy.stats.chi2
def fay_feuer(d, n, wt, conf=0.95):
    d=np.array(d,float); n=np.array(n,float); w=np.array(wt,float); w=w/w.sum()
    y=float((w*d/n).sum()); v=float((w**2*d/n**2).sum()); wm=float((w/n).max()); a=(1-conf)/2
    lo=0.0 if y==0 else float(v/(2*y)*stats.chi2.ppf(a,2*y*y/v))
    hi=float((v+wm**2)/(2*(y+wm))*stats.chi2.ppf(1-a,2*(y+wm)**2/(v+wm**2)))
    return {'rate':y,'variance':v,'low':lo,'high':hi}
dd=[3,8,20,41,60]; nn=[12000.0,15000.0,9000.0,7000.0,3500.0]; ww=[0.30,0.25,0.20,0.15,0.10]
out['dsr']={'events':dd,'personTime':nn,'weights':ww,**fay_feuer(dd,nn,ww)}
dd2=[2,9,17,35,48]; nn2=[10000.0,13000.0,10000.0,8000.0,4000.0]
a_=fay_feuer(dd,nn,ww); b_=fay_feuer(dd2,nn2,ww)
rr_=a_['rate']/b_['rate']; se_=float(np.sqrt(a_['variance']/a_['rate']**2+b_['variance']/b_['rate']**2))
out['dsr_ratio']={'a':{'events':dd,'personTime':nn},'b':{'events':dd2,'personTime':nn2},'weights':ww,'ratio':rr_,'low':float(np.exp(np.log(rr_)-z*se_)),'high':float(np.exp(np.log(rr_)+z*se_))}
out['dsr_zero']={'events':[0,0,0],'personTime':[1000.0,2000.0,3000.0],'weights':[1,1,1],**fay_feuer([0,0,0],[1000.0,2000.0,3000.0],[1,1,1])}
out['chi2_ppf']=[{'p':p_,'df':d_,'q':float(stats.chi2.ppf(p_,d_))} for p_ in (0.025,0.5,0.975) for d_ in (1,2,7.5,30,200.25)]
print(json.dumps(out,indent=1))
