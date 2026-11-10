window.R = {};
function st(v){ return v ? {paused: v.paused, t: +v.currentTime.toFixed(2), muted: v.muted} : null; }
function tryPlay(v, key){ try { const p = v.play(); R[key] = 'pending'; p.then(()=>R[key]='resolved', e=>R[key]=e.name); } catch(e){ R[key]='threw:'+e.name; } }
