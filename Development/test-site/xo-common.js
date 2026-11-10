window.childState = null;
window.addEventListener('message', e => { if (e.data && e.data.childState) window.childState = e.data.childState; });
function askChild(f){ window.childState=null; f.contentWindow.postMessage('state','*'); }
