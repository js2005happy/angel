import sys
LOGO='<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 0C9 5 11 7 16 8C11 9 9 11 8 16C7 11 5 9 0 8C5 7 7 5 8 0Z"/></svg>'
FONTS='''@font-face{font-family:Inter;src:url(Inter-Regular.ttf);font-weight:400}
@font-face{font-family:Inter;src:url(Inter-SemiBold.ttf);font-weight:500 600}
@font-face{font-family:Inter;src:url(Inter-Bold.ttf);font-weight:700}
@font-face{font-family:JBM;src:url(JBM-Regular.ttf);font-weight:400}
@font-face{font-family:JBM;src:url(JBM-Bold.ttf);font-weight:700}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}.mono{font-family:JBM,monospace}'''
DARK=dict(bg="#0B0B0C",side="#141415",panel="#111112",line="#232325",line2="#2C2C2F",fg="#EDEDED",mu="#8E8E93",mu2="#5E5E63",chip="#1C1C1E",hover="#1F1F22",add="#3FB950",addbg="rgba(63,185,80,.10)",rm="#F85149",rmbg="rgba(248,81,73,.10)",btn="#EDEDED",btnfg="#0B0B0C",stage="#050505",glow="rgba(255,255,255,.06)")
LIGHT=dict(bg="#FFFFFF",side="#F7F7F8",panel="#FBFBFB",line="#ECECEE",line2="#E2E2E5",fg="#0D0D0D",mu="#6E6E73",mu2="#A1A1A6",chip="#F2F2F3",hover="#EDEDEF",add="#1A7F37",addbg="#E9F6EC",rm="#CF222E",rmbg="#FCEBEC",btn="#0D0D0D",btnfg="#FFFFFF",stage="#E9E9EC",glow="rgba(0,0,0,.04)")
def css(t):
    v=";".join(f"--{k}:{x}" for k,x in t.items())
    return FONTS+":root{"+v+"}"+'''
.stage{width:1600px;height:1000px;background:var(--stage);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.stage:before{content:"";position:absolute;inset:0;background:radial-gradient(900px 500px at 50% 0%,var(--glow),transparent 70%)}
.cap{position:absolute;left:48px;top:30px;display:flex;align-items:center;gap:12px;color:var(--fg);font-size:19px;font-weight:600;z-index:2}
.cap small{color:var(--mu);font-weight:400;font-size:14px}
.mk{width:28px;height:28px;border-radius:8px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center}.mk svg{width:14px;height:14px}
.win{width:1460px;height:870px;margin-top:44px;border-radius:12px;overflow:hidden;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;box-shadow:0 40px 120px rgba(0,0,0,.35),0 0 0 1px var(--line2);position:relative;z-index:1;font-size:13.5px}
.body{flex:1;display:flex;min-height:0}
.side{width:248px;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:10px 8px;gap:1px}
.si{height:30px;display:flex;align-items:center;gap:10px;padding:0 10px;border-radius:7px;color:var(--fg)}
.si .k{margin-left:auto;color:var(--mu2);font-size:11.5px}
.si.on{background:var(--hover)}
.si i{font-style:normal;width:16px;text-align:center;color:var(--mu)}
.sh{font-size:11.5px;color:var(--mu);margin:16px 10px 4px;display:flex;justify-content:space-between}
.pr{height:28px;display:flex;align-items:center;gap:8px;padding:0 10px;color:var(--fg);font-weight:500}
.th{height:28px;display:flex;align-items:center;gap:8px;padding:0 10px 0 28px;border-radius:7px;color:var(--mu);white-space:nowrap;overflow:hidden}
.th.on{background:var(--hover);color:var(--fg)}
.th .t{margin-left:auto;font-size:11.5px;color:var(--mu2)}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--mu2);border-top-color:var(--fg);flex:none}
.dot{width:6px;height:6px;border-radius:50%;flex:none}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.top{height:46px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:0 18px;flex:none}
.top b{font-weight:500}.top .crumb{color:var(--mu)}
.tbtn{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--line2);display:flex;align-items:center;gap:6px;color:var(--fg);font-size:12.5px}
.tbtn.p{background:var(--btn);color:var(--btnfg);border-color:var(--btn);font-weight:500}
.cols{flex:1;display:flex;min-height:0}
.conv{flex:1;display:flex;flex-direction:column;min-width:0}
.feed{flex:1;overflow:hidden;padding:26px 0}
.col{width:640px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.u{align-self:flex-end;background:var(--chip);padding:10px 14px;border-radius:16px;max-width:480px;line-height:1.5}
.p{line-height:1.65;color:var(--fg)}
.p code{font-family:JBM;font-size:12.5px;background:var(--chip);padding:1px 5px;border-radius:5px}
.log{color:var(--mu);display:flex;flex-direction:column;gap:7px;font-size:13px}
.log .h{display:flex;align-items:center;gap:8px;color:var(--mu)}
.log .r{display:flex;align-items:center;gap:8px;padding-left:4px}
.log .r span.c{font-family:JBM;font-size:12px;color:var(--fg)}
.files{border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.files .fr{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid var(--line)}
.files .fr:first-child{border:none}
.add{color:var(--add)}.del{color:var(--rm)}
.comp{width:680px;margin:0 auto 14px;border:1px solid var(--line2);border-radius:18px;background:var(--panel);padding:12px 14px 10px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.comp .ph{color:var(--mu2);font-size:14px;padding:2px 2px 12px}
.comp .rw{display:flex;align-items:center;gap:6px}
.pk{height:28px;padding:0 10px;border-radius:999px;background:var(--chip);display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--fg)}
.pk.g{background:transparent;color:var(--mu)}
.send{margin-left:auto;width:32px;height:32px;border-radius:50%;background:var(--btn);color:var(--btnfg);display:flex;align-items:center;justify-content:center;font-size:15px}
.status{height:28px;border-top:1px solid var(--line);display:flex;align-items:center;gap:18px;padding:0 14px;color:var(--mu);font-size:11.5px;flex:none;background:var(--side)}
.status span{display:flex;align-items:center;gap:6px}
.review{width:520px;border-left:1px solid var(--line);display:flex;flex-direction:column;background:var(--panel)}
.rt{height:42px;display:flex;align-items:center;gap:4px;padding:0 10px;border-bottom:1px solid var(--line)}
.tab{height:28px;padding:0 10px;border-radius:7px;display:flex;align-items:center;gap:6px;color:var(--mu);font-size:12.5px}
.tab.on{background:var(--hover);color:var(--fg)}
.fh{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;font-family:JBM;font-size:12px}
.code{font-family:JBM;font-size:12px;line-height:20px}
.ln{display:flex;padding-right:10px;white-space:pre}
.ln .n{width:42px;text-align:right;padding-right:12px;color:var(--mu2);flex:none}
.ln.a{background:var(--addbg)}.ln.a .n{color:var(--add)}
.ln.d{background:var(--rmbg)}.ln.d .n{color:var(--rm)}
.cm{margin:8px 14px 8px 54px;border:1px solid var(--line2);border-radius:10px;padding:10px 12px;font-family:Inter;font-size:12.5px;background:var(--bg)}
.term{border-top:1px solid var(--line);margin-top:auto;padding:10px 14px;font-family:JBM;font-size:11.5px;line-height:18px;color:var(--mu);background:var(--side)}
'''
def page(t, cap, inner):
    return f'<html><head><style>{css(t)}</style></head><body><div class="stage"><div class="cap"><div class="mk">{LOGO}</div>{cap}</div>{inner}</div></body></html>'
