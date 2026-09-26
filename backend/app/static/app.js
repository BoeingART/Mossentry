let state = {servers:[], users:[], actions:[], audit:[], admin:null};
let userFilter = 'enabled';
let userPage = 1;
const USER_PAGE_SIZE = 15;
let actionPage = 1;
const ACTION_PAGE_SIZE = 10;
let actionRefreshTimer = null;
let bulkApprovalActive = false;
const expandedUserGroups = new Set();
const actionLabels = {create_user:'Create user',disable_user:'Disable sign-in',enable_user:'Enable sign-in',set_sudo:'Change sudo access'};
const eventLabels = {login_success:'Administrator sign-in',login_failed:'Sign-in failed',logout:'Sign-out',scan_started:'Scan started',scan_completed:'Scan completed',scan_failed:'Scan failed',action_requested:'Request submitted',action_approved:'Action approved',action_rejected:'Action rejected',action_executed:'Action completed',action_failed:'Action failed',private_key_downloaded:'Credentials downloaded',user_profile_updated:'User profile updated',password_changed:'Password changed'};

const esc = (value='') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const fmt = value => value ? new Intl.DateTimeFormat('en-US',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : 'Never';

async function api(path, options={}) {
  const headers = {...(options.headers || {})};
  if (options.body && typeof options.body !== 'string') { headers['Content-Type']='application/json'; options.body=JSON.stringify(options.body); }
  if (options.method && options.method !== 'GET' && state.admin) headers['X-CSRF-Token']=state.admin.csrf;
  const response = await fetch(path,{...options,headers});
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  if (response.status === 401) { location.reload(); throw new Error('Your session has expired'); }
  if (!response.ok) throw new Error(data.detail || data || 'Operation failed');
  return data;
}

function notice(message, error=false) {
  const el=document.querySelector('#notice'); el.textContent=message; el.className=`notice${error?' error':''}`; el.hidden=false;
  clearTimeout(notice.timer); notice.timer=setTimeout(()=>el.hidden=true,6500);
}

async function load() {
  try { state=await api('/api/dashboard'); render(); }
  catch(e){ notice(e.message,true); }
}

function render(){renderHeaderStatus();renderServers();renderRecent();renderSummary();renderUsers();renderActions();renderAudit();renderServerOptions();renderApproveAllButton();scheduleActionRefresh();}

function scheduleActionRefresh(){
  clearTimeout(actionRefreshTimer);
  actionRefreshTimer=null;
  if(!bulkApprovalActive&&state.actions.some(action=>action.status==='approved'))actionRefreshTimer=setTimeout(load,2000);
}

function markActionRunning(actionId){
  const action=state.actions.find(item=>item.id===Number(actionId));
  if(!action)return;
  action.status='approved';
  renderHeaderStatus();
  renderRecent();
  renderActions();
  renderApproveAllButton();
  scheduleActionRefresh();
}

function renderHeaderStatus(){
  const pending=state.actions.filter(a=>a.status==='pending').length;
  document.querySelector('#approval-count').textContent=pending;
  const dates=state.servers.map(s=>s.last_scan_at).filter(Boolean).sort(); document.querySelector('#last-updated').textContent=dates.length?`Last sync ${fmt(dates.at(-1))}`:'Waiting for first sync';
}
function renderServers(){
  const query=document.querySelector('#host-search')?.value.trim().toLowerCase()||'';
  const servers=state.servers.filter(s=>!query||[s.name,s.hostname,s.ssh_user,`${s.ssh_user}@${s.hostname}`].some(value=>String(value||'').toLowerCase().includes(query)));
  const icon='<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="4" width="24" height="10" rx="2"/><rect x="4" y="18" width="24" height="10" rx="2"/><circle cx="9" cy="9" r="1"/><circle cx="9" cy="23" r="1"/><path d="M15 9h9M15 23h9"/></svg>';
  document.querySelector('#server-grid').innerHTML=servers.length?servers.map(s=>{
    const count=state.users.filter(u=>u.server===s.name).length;
    const status=s.last_scan_status||'unknown';
    const statusText={ok:'Synced',failed:'Scan failed',error:'Scan failed',never:'Not scanned',unknown:'Not scanned'}[status]||status.replaceAll('_',' ');
    return `<article class="server-card ${esc(status)}"><span class="host-icon">${icon}</span><div class="host-main"><h3 title="${esc(s.name)}">${esc(s.name)}</h3></div><span class="host-status ${esc(status)}">${esc(statusText)}</span><div class="host-detail"><span>Port ${esc(s.port)}</span><span>${count} user${count===1?'':'s'}</span><span>Last scan ${fmt(s.last_scan_at)}</span></div>${s.last_scan_error?`<p class="host-error">${esc(s.last_scan_error.slice(0,120))}</p>`:''}</article>`;
  }).join(''):'<div class="empty">No hosts match your search.</div>';
}
function renderRecent(){const actions=state.actions.slice(0,4);document.querySelector('#recent-actions').innerHTML=actions.length?actions.map(actionRow).join(''):'<div class="empty">No approval history yet</div>';}
function actionRow(a){return `<div class="mini-action"><span class="event-icon">${a.action_type==='create_user'?'+':'↻'}</span><div><strong>${actionLabels[a.action_type]||esc(a.action_type)} · ${esc(a.target_user)}</strong><small>${esc(a.target_server)} · ${fmt(a.requested_at)}</small></div><span class="status ${a.status}">${statusLabel(a.status)}</span></div>`;}
function statusLabel(s){return ({pending:'Pending',approved:'Running',executed:'Completed',failed:'Failed',rejected:'Rejected'})[s]||s;}
function renderSummary(){const normal=state.users.filter(u=>!u.is_sudo&&!u.is_disabled).length,sudo=state.users.filter(u=>u.is_sudo&&!u.is_disabled).length,disabled=state.users.filter(u=>u.is_disabled).length,total=Math.max(normal+sudo+disabled,1);document.querySelector('#privilege-summary').innerHTML=`<div class="summary-bar"><span style="width:${normal/total*100}%"></span><span style="width:${sudo/total*100}%"></span><span style="width:${disabled/total*100}%;background:#c75b54"></span></div><div class="summary-grid"><div class="summary-item"><strong>${normal}</strong><span>Standard access</span></div><div class="summary-item"><strong>${sudo}</strong><span>Sudo access</span></div><div class="summary-item"><strong>${disabled}</strong><span>Disabled sign-in</span></div><div class="summary-item"><strong>${state.servers.filter(s=>s.last_scan_status==='ok').length}/${state.servers.length}</strong><span>Hosts synced</span></div></div>`;}
function renderUsers(){
  const search=document.querySelector('#user-search');
  const list=document.querySelector('#users-list');
  const pagination=document.querySelector('#users-pagination');
  if(!search||!list)return;
  list.querySelectorAll('.user-group[data-username]').forEach(group=>group.open?expandedUserGroups.add(group.dataset.username):expandedUserGroups.delete(group.dataset.username));
  const q=search.value.trim().toLowerCase();
  const grouped=new Map();
  state.users.forEach(account=>{
    if(!grouped.has(account.username))grouped.set(account.username,[]);
    grouped.get(account.username).push(account);
  });
  const groups=[...grouped.entries()]
    .map(([username,accounts])=>({username,fullName:accounts.find(account=>account.full_name)?.full_name||'',accounts:accounts.sort((a,b)=>a.server.localeCompare(b.server,'en',{sensitivity:'base',numeric:true}))}))
    .filter(group=>(!q||group.username.toLowerCase().includes(q)||group.fullName.toLowerCase().includes(q)||group.accounts.some(account=>account.server.toLowerCase().includes(q)))&&(userFilter==='all'||(userFilter==='enabled'&&group.accounts.some(account=>!account.is_disabled))||(userFilter==='sudo'&&group.accounts.some(account=>account.is_sudo))||(userFilter==='disabled'&&group.accounts.some(account=>account.is_disabled))))
    .sort((a,b)=>a.username.localeCompare(b.username,'en',{sensitivity:'base',numeric:true}));
  const pageCount=Math.max(1,Math.ceil(groups.length/USER_PAGE_SIZE));
  userPage=Math.min(Math.max(userPage,1),pageCount);
  const pageGroups=groups.slice((userPage-1)*USER_PAGE_SIZE,userPage*USER_PAGE_SIZE);
  list.innerHTML=pageGroups.length?pageGroups.map(group=>{
    const sudoCount=group.accounts.filter(account=>account.is_sudo).length;
    const disabledCount=group.accounts.filter(account=>account.is_disabled).length;
    return `<details class="user-group" data-username="${esc(group.username)}"${expandedUserGroups.has(group.username)?' open':''}><summary><span class="user-avatar">${esc((group.fullName||group.username)[0]?.toUpperCase()||'?')}</span><span class="user-group-name"><strong>${group.fullName?`${esc(group.fullName)} <span class="user-login-name">(${esc(group.username)})</span>`:esc(group.username)}</strong><small>${group.accounts.length} host account${group.accounts.length===1?'':'s'}</small></span><span class="user-group-tags">${sudoCount?`<span class="tag sudo">${sudoCount} Sudo</span>`:'<span class="tag">Standard access</span>'}${disabledCount?`<span class="tag disabled">${disabledCount} disabled</span>`:''}</span><button type="button" class="user-profile-edit" data-edit-profile data-user="${esc(group.username)}" data-full-name="${esc(group.fullName)}">Edit profile</button><span class="expand-label">Expand</span><span class="group-chevron" aria-hidden="true">⌄</span></summary><div class="user-group-detail"><div class="table-wrap"><table><thead><tr><th>Host</th><th>UID</th><th>Access</th><th>Sign-in</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${group.accounts.map(account=>`<tr><td><span class="tag server-tag">${esc(account.server)}</span></td><td>${account.uid}</td><td>${account.is_sudo?'<span class="tag sudo">Sudo</span>':'<span class="tag">Standard user</span>'}</td><td>${account.is_disabled?'<span class="tag disabled">Disabled</span>':'<span class="tag active">Enabled</span>'}</td><td><div class="row-menu">${account.is_disabled?`<button data-user-action="enable_user" data-user="${esc(account.username)}" data-server="${esc(account.server)}">Enable</button>`:`<button data-user-action="disable_user" data-user="${esc(account.username)}" data-server="${esc(account.server)}">Disable</button>`}<button data-user-action="set_sudo" data-sudo="${account.is_sudo?'false':'true'}" data-user="${esc(account.username)}" data-server="${esc(account.server)}">${account.is_sudo?'Revoke sudo':'Grant sudo'}</button></div></td></tr>`).join('')}</tbody></table></div></div></details>`;
  }).join(''):'<div class="empty">No users match your search</div>';
  pagination.hidden=groups.length===0;
  pagination.innerHTML=`<span class="pagination-summary">${groups.length} users · Page ${userPage} of ${pageCount}</span><div class="pagination-controls"><button type="button" data-user-page="${userPage-1}" ${userPage===1?'disabled':''} aria-label="Previous">← Previous</button><button type="button" data-user-page="${userPage+1}" ${userPage===pageCount?'disabled':''} aria-label="Next">Next →</button></div>`;
}
function renderActions(){
  const list=document.querySelector('#actions-list'),pagination=document.querySelector('#actions-pagination');
  const pageCount=Math.max(1,Math.ceil(state.actions.length/ACTION_PAGE_SIZE));
  actionPage=Math.min(Math.max(actionPage,1),pageCount);
  const actions=state.actions.slice((actionPage-1)*ACTION_PAGE_SIZE,actionPage*ACTION_PAGE_SIZE);
  list.innerHTML=actions.length?actions.map(a=>`<article class="action-card"><span class="event-icon">${a.action_type==='create_user'?'+':'↻'}</span><div><h3>#${a.id} ${actionLabels[a.action_type]||esc(a.action_type)} · ${esc(a.target_user)} <span class="status ${a.status}">${statusLabel(a.status)}</span></h3><p>Target: ${esc(a.target_server)}${a.action_type==='set_sudo'?` · Access: ${a.payload.sudo?'Grant sudo':'Revoke sudo'}`:''}${a.action_type==='create_user'?` · Access: ${a.payload.sudo?'Sudo user':'Standard user'}`:''}</p><p>Requested by: ${esc(a.requested_by_name)} · ${fmt(a.requested_at)}${a.key_fingerprint?` · Fingerprint ${esc(a.key_fingerprint)}`:''}</p>${a.error?`<div class="error-box">${esc(a.error)}</div>`:''}</div><div class="action-controls">${a.status==='pending'?`<button class="button compact ghost" data-reject="${a.id}">Reject</button><button class="button compact primary" data-approve="${a.id}">Approve and run</button>`:''}${a.private_key_ready?`<a class="button compact primary" href="/api/actions/${a.id}/private-key" data-download="${a.id}">Download credentials once</a>`:''}${a.key_downloaded_at?'<span class="status executed">Credentials downloaded</span>':''}</div></article>`).join(''):'<div class="empty panel">No requests yet</div>';
  pagination.hidden=state.actions.length===0;
  pagination.innerHTML=`<span class="pagination-summary">${state.actions.length} records · Page ${actionPage} of ${pageCount}</span><div class="pagination-controls"><button type="button" data-action-page="${actionPage-1}" ${actionPage===1?'disabled':''} aria-label="Previous">← Previous</button><button type="button" data-action-page="${actionPage+1}" ${actionPage===pageCount?'disabled':''} aria-label="Next">Next →</button></div>`;
}
function renderApproveAllButton(){
  const button=document.querySelector('#approve-all-button');
  if(!button)return;
  const pending=state.actions.filter(action=>action.status==='pending').length;
  if(bulkApprovalActive){
    button.disabled=true;
    button.textContent=pending?`Approving (${pending} remaining)`:'Finishing approvals…';
    return;
  }
  button.disabled=pending===0;
  button.textContent=pending?`Approve all (${pending})`:'Approve all';
}
function renderAudit(){document.querySelector('#audit-table').innerHTML=state.audit.length?state.audit.map(a=>`<tr><td>${fmt(a.created_at)}</td><td>${esc(a.actor||'System')}</td><td class="audit-event">${esc(eventLabels[a.event]||a.event)}</td><td>${esc(a.target||'—')}</td><td>${esc(a.ip_address||'—')}</td></tr>`).join(''):'<tr><td colspan="5" class="empty">No activity yet</td></tr>';}
function renderServerOptions(){document.querySelector('#server-options').innerHTML=state.servers.filter(s=>s.enabled).map(s=>`<label class="server-check"><input type="checkbox" name="servers" value="${esc(s.name)}"><span>${esc(s.name.toUpperCase())}</span></label>`).join('');}

function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav-item').forEach(v=>v.classList.remove('active'));document.querySelector(`#view-${name}`).classList.add('active');document.querySelector(`.nav-item[data-view="${name}"]`)?.classList.add('active');document.querySelector('#page-title').textContent=({overview:'Hosts',users:'Users & access',approvals:'Approvals',audit:'Activity log'})[name];}
function setServerSelectionCopy(){
  document.querySelector('#server-selection-label').textContent='Allowed hosts';
  document.querySelector('#server-selection-help').textContent='An account will be created on each selected host.';
}
function setActionTargetCopy(action,username,server,sudoEnabled=false){
  const serverName=server.toUpperCase();
  const submitLabel={
    disable_user:'Request disable',
    enable_user:'Request enable',
    set_sudo:sudoEnabled?'Request sudo grant':'Request sudo removal',
  }[action];
  document.querySelector('#action-username').textContent=username;
  document.querySelector('#action-target-server').textContent=serverName;
  document.querySelector('#user-submit-button').textContent=submitLabel;
}
function openUserAction(button){
  const dialog=document.querySelector('#user-dialog'),form=document.querySelector('#user-form'),action=button.dataset.userAction,sudoEnabled=button.dataset.sudo==='true';
  form.reset();
  form.mode.value=action;
  form.username.value=button.dataset.user;
  form.username.readOnly=true;
  document.querySelector('#dialog-title').textContent=actionLabels[action];
  document.querySelector('#user-form-error').textContent='';
  setActionTargetCopy(action,button.dataset.user,button.dataset.server,sudoEnabled);
  dialog.querySelectorAll('.create-only').forEach(el=>el.hidden=true);
  dialog.querySelectorAll('.action-only').forEach(el=>el.hidden=false);
  dialog.querySelectorAll('[name=servers]').forEach(el=>el.checked=el.value===button.dataset.server);
  if(action==='set_sudo')form.sudo.checked=sudoEnabled;
  dialog.showModal();
}
function openCreate(){
  const dialog=document.querySelector('#user-dialog'),form=document.querySelector('#user-form');
  form.reset();
  form.mode.value='create_user';
  form.username.readOnly=false;
  document.querySelector('#dialog-title').textContent='New user';
  document.querySelector('#user-submit-button').textContent='Submit for approval';
  document.querySelector('#user-form-error').textContent='';
  setServerSelectionCopy('create_user');
  dialog.querySelectorAll('.create-only').forEach(el=>el.hidden=false);
  dialog.querySelectorAll('.action-only').forEach(el=>el.hidden=true);
  dialog.showModal();
}
function openProfileEditor(button){
  const dialog=document.querySelector('#profile-dialog'),form=document.querySelector('#profile-form');
  form.reset();
  form.username.value=button.dataset.user;
  form.full_name.value=button.dataset.fullName||'';
  document.querySelector('#profile-username').textContent=button.dataset.user;
  document.querySelector('#profile-form-error').textContent='';
  dialog.showModal();
  setTimeout(()=>form.full_name.focus(),0);
}

function approveAllActions(){
  const pendingIds=state.actions.filter(action=>action.status==='pending').map(action=>action.id);
  if(!pendingIds.length)return;
  confirmAction('all',`Approve and run all ${pendingIds.length} pending requests?`,async()=>{
    const button=document.querySelector('#approve-all-button');
    let succeeded=0;
    const failures=[];
    bulkApprovalActive=true;
    renderApproveAllButton();
    try{
      for(const actionId of pendingIds){
        markActionRunning(actionId);
        try{await api(`/api/actions/${actionId}/approve`,{method:'POST'});succeeded+=1;}
        catch(error){failures.push(actionId);}
        await load();
      }
    }finally{
      bulkApprovalActive=false;
      renderApproveAllButton();
    }
    if(failures.length)notice(`${succeeded} completed, ${failures.length} failed`,true);
    else notice(`Approved and ran ${succeeded} requests`);
  });
}
document.addEventListener('click',async e=>{
  const profileEdit=e.target.closest('[data-edit-profile]');
  if(profileEdit){e.preventDefault();e.stopPropagation();openProfileEditor(profileEdit);return;}
  const nav=e.target.closest('[data-view]');if(nav)showView(nav.dataset.view);
  const go=e.target.closest('[data-goto]');if(go)showView(go.dataset.goto);
  if(e.target.closest('#new-user-button'))openCreate();
  if(e.target.closest('#approve-all-button'))approveAllActions();
  if(e.target.closest('#password-button')){document.querySelector('#password-form').reset();document.querySelector('#password-error').textContent='';document.querySelector('#password-dialog').showModal();}
  if(e.target.closest('.close-dialog'))e.target.closest('dialog').close();
  const userAction=e.target.closest('[data-user-action]');if(userAction)openUserAction(userAction);
  const pageButton=e.target.closest('[data-user-page]');if(pageButton&&!pageButton.disabled){userPage=Number(pageButton.dataset.userPage);renderUsers();document.querySelector('#view-users').scrollIntoView({behavior:'smooth',block:'start'});}
  const actionPageButton=e.target.closest('[data-action-page]');if(actionPageButton&&!actionPageButton.disabled){actionPage=Number(actionPageButton.dataset.actionPage);renderActions();document.querySelector('#view-approvals').scrollIntoView({behavior:'smooth',block:'start'});}
  const approve=e.target.closest('[data-approve]');if(approve)confirmAction(approve.dataset.approve,'Approve and run this request? This connects to the target host.',async()=>{markActionRunning(approve.dataset.approve);try{await api(`/api/actions/${approve.dataset.approve}/approve`,{method:'POST'});notice('Action completed');}finally{await load();}});
  const reject=e.target.closest('[data-reject]');if(reject)confirmAction(reject.dataset.reject,'Reject this request?',async()=>{await api(`/api/actions/${reject.dataset.reject}/reject`,{method:'POST'});notice('Request rejected');await load();});
  const download=e.target.closest('[data-download]');if(download)setTimeout(load,1000);
});

function confirmAction(id,text,callback){const dialog=document.querySelector('#confirm-dialog');document.querySelector('#confirm-text').textContent=text;dialog.returnValue='';dialog.showModal();dialog.addEventListener('close',async function handler(){dialog.removeEventListener('close',handler);if(dialog.returnValue==='confirm'){const button=document.querySelector('#confirm-button');button.disabled=true;try{await callback();}catch(e){notice(e.message,true);}finally{button.disabled=false;}}});}

document.querySelector('#user-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.currentTarget,mode=form.mode.value,servers=[...form.querySelectorAll('[name=servers]:checked')].map(i=>i.value),error=document.querySelector('#user-form-error');
  error.textContent='';
  if(!servers.length){error.textContent='Select at least one host';return;}
  const body={username:form.username.value,servers};
  let path='/api/actions/user';
  if(mode==='create_user'){path='/api/actions/create-user';body.full_name=form.full_name.value;body.sudo=form.sudo.checked;}
  else{body.action=mode;if(mode==='set_sudo')body.sudo=form.sudo.checked;}
  const submit=form.querySelector('[type=submit]');
  submit.disabled=true;
  try{
    const data=await api(path,{method:'POST',body});
    form.closest('dialog').close();
    notice(data.message);
    await load();
  }catch(err){error.textContent=err.message;}
  finally{submit.disabled=false;}
});
document.querySelector('#profile-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.currentTarget,error=document.querySelector('#profile-form-error'),submit=form.querySelector('[type=submit]');
  error.textContent='';
  submit.disabled=true;
  try{
    const data=await api(`/api/users/${encodeURIComponent(form.username.value)}/profile`,{
      method:'PUT',body:{full_name:form.full_name.value},
    });
    form.closest('dialog').close();
    notice(data.message);
    await load();
  }catch(err){
    error.textContent=err.message;
  }finally{
    submit.disabled=false;
  }
});
document.querySelector('#scan-button').addEventListener('click',async e=>{e.currentTarget.disabled=true;e.currentTarget.textContent='Syncing…';try{const data=await api('/api/scan',{method:'POST'});notice(data.ok?`Sync complete: ${data.users} user records found`:`Some hosts failed to sync: ${Object.keys(data.errors).join(', ')}`,!data.ok);await load();}catch(err){notice(err.message,true);}finally{e.currentTarget.disabled=false;e.currentTarget.textContent='↻ Sync hosts';}});
document.querySelector('#logout')?.addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.reload();});
document.querySelector('#password-form')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,error=document.querySelector('#password-error');error.textContent='';if(form.new_password.value!==form.confirm_password.value){error.textContent='The new passwords do not match';return;}const submit=form.querySelector('[type=submit]');submit.disabled=true;try{await api('/api/change-password',{method:'POST',body:{current_password:form.current_password.value,new_password:form.new_password.value}});form.closest('dialog').close();notice('Administrator password updated');}catch(err){error.textContent=err.message;}finally{submit.disabled=false;}});
document.querySelector('#host-search').addEventListener('input',renderServers);
document.querySelector('#user-search').addEventListener('input',()=>{userPage=1;renderUsers();});document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(b=>b.classList.remove('active'));button.classList.add('active');userFilter=button.dataset.filter;userPage=1;renderUsers();}));
load();
