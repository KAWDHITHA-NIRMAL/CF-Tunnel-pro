const api = {
    request: async (endpoint, options = {}) => {
        const token = localStorage.getItem('cft_auth_token');
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        };
        const response = await fetch(`/api${endpoint}`, { ...options, headers });
        if (response.status === 401 && endpoint !== '/login') {
            document.getElementById('loginOverlay').classList.remove('hidden');
            document.getElementById('mainContent').classList.add('hidden');
            localStorage.removeItem('cft_auth_token');
            throw new Error('Unauthorized');
        }
        return response.json();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const loginOverlay = document.getElementById('loginOverlay');
    const mainContent = document.getElementById('mainContent');
    const loginForm = document.getElementById('loginForm');
    const loginError = document.getElementById('loginError');
    const passwordInput = document.getElementById('passwordInput');

    // Check auth on load
    if (localStorage.getItem('cft_auth_token')) {
        initApp();
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const data = await api.request('/login', {
                method: 'POST',
                body: JSON.stringify({ password: passwordInput.value })
            });
            if (data.token) {
                localStorage.setItem('cft_auth_token', data.token);
                loginError.classList.add('hidden');
                passwordInput.value = '';
                initApp();
            } else {
                loginError.classList.remove('hidden');
            }
        } catch (err) {
            loginError.classList.remove('hidden');
        }
    });

    async function initApp() {
        loginOverlay.style.opacity = '0';
        setTimeout(() => {
            loginOverlay.classList.add('hidden');
            mainContent.classList.remove('hidden');
            loadDomains();
            loadTunnels();
        }, 300);
        
        // Polling tunnels every 5 seconds
        setInterval(loadTunnels, 5000);
    }

    // Domain & CF Authorization Logic
    const addDomainForm = document.getElementById('addDomainForm');
    const newDomainInput = document.getElementById('newDomainInput');
    const addDomainBtn = document.getElementById('addDomainBtn');
    const cfLoginModal = document.getElementById('cfLoginModal');
    const cfLoginLink = document.getElementById('cfLoginLink');
    const domainsList = document.getElementById('domainsList');
    const pBaseDomain = document.getElementById('pBaseDomain');

    addDomainForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const domain = newDomainInput.value.trim();
        if (!domain) return;

        addDomainBtn.disabled = true;
        addDomainBtn.innerText = 'Requesting...';
        try {
            const initialDomains = await api.request('/domains');
            const initialCount = initialDomains.length;

            const data = await api.request('/cf/login', { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain }) 
            });
            
            if (data.url) {
                cfLoginModal.classList.remove('hidden');
                cfLoginLink.href = data.url;
                cfLoginLink.innerText = data.url;
                addDomainBtn.innerText = 'Waiting...';
                
                const pollCF = setInterval(async () => {
                    const currentDomains = await api.request('/domains');
                    if (currentDomains.length > initialCount) {
                        clearInterval(pollCF);
                        cfLoginModal.classList.add('hidden');
                        addDomainBtn.disabled = false;
                        addDomainBtn.innerText = 'Authorize & Add';
                        newDomainInput.value = '';
                        loadDomains();
                    }
                }, 3000);
            }
        } catch(e) {
            addDomainBtn.disabled = false;
            addDomainBtn.innerText = 'Authorize & Add';
            alert('Failed to start login process');
        }
    });

    async function loadDomains() {
        try {
            const domains = await api.request('/domains');
            renderDomains(domains);
            updateDomainDropdown(domains);
        } catch (e) {}
    }

    function renderDomains(domains) {
        if (domains.length === 0) {
            domainsList.innerHTML = '<li class="text-xs text-slate-500">No domains added yet.</li>';
            return;
        }
        domainsList.innerHTML = domains.map(d => `
            <li class="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                <span class="font-medium text-slate-700">${d}</span>
                <button onclick="deleteDomain('${d}')" class="text-red-500 hover:text-red-700 text-xs px-2 py-1 rounded bg-red-50">Remove</button>
            </li>
        `).join('');
    }

    function updateDomainDropdown(domains) {
        pBaseDomain.innerHTML = '<option value="" disabled selected>Select Domain</option>' + 
            domains.map(d => `<option value="${d}">${d}</option>`).join('');
    }

    window.deleteDomain = async (domain) => {
        if(confirm(`Are you sure you want to remove ${domain}?`)) {
            await api.request(`/domains/${domain}`, { method: 'DELETE' });
            loadDomains();
        }
    };

    // Create Tunnels
    const permanentTunnelForm = document.getElementById('permanentTunnelForm');
    const tempTunnelForm = document.getElementById('tempTunnelForm');

    permanentTunnelForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const subdomain = document.getElementById('pSubdomain').value;
        const baseDomain = document.getElementById('pBaseDomain').value;
        const port = document.getElementById('pPort').value;
        const isPermanent = document.getElementById('pPermanent').checked;
        
        await api.request('/tunnels', {
            method: 'POST',
            body: JSON.stringify({ subdomain, baseDomain, port, isPermanent, isTemporary: false })
        });
        
        document.getElementById('pSubdomain').value = '';
        document.getElementById('pPort').value = '';
        loadTunnels();
    });

    tempTunnelForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const port = document.getElementById('tPort').value;
        
        await api.request('/tunnels', {
            method: 'POST',
            body: JSON.stringify({ port, isPermanent: false, isTemporary: true })
        });
        
        document.getElementById('tPort').value = '';
        loadTunnels();
    });

    // Load and render tunnels
    const tunnelsList = document.getElementById('tunnelsList');
    const noTunnelsMsg = document.getElementById('noTunnelsMsg');
    document.getElementById('refreshTunnelsBtn').addEventListener('click', loadTunnels);

    async function loadTunnels() {
        try {
            const tunnels = await api.request('/tunnels');
            renderTunnels(tunnels);
        } catch (e) {}
    }

    function renderTunnels(tunnels) {
        if (tunnels.length === 0) {
            tunnelsList.innerHTML = '';
            noTunnelsMsg.classList.remove('hidden');
            return;
        }
        noTunnelsMsg.classList.add('hidden');
        
        tunnelsList.innerHTML = tunnels.map(t => {
            const isRunning = t.status === 'running';
            const displayUrl = t.isTemporary ? (t.url || 'Generating...') : t.subdomain;
            const urlEl = t.url ? `<a href="${t.url}" target="_blank" class="text-blue-600 hover:underline inline-flex items-center gap-1">${displayUrl}<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg></a>` : (t.isTemporary ? `<span class="text-slate-500">${displayUrl}</span>` : `<a href="https://${displayUrl}" target="_blank" class="text-blue-600 hover:underline inline-flex items-center gap-1">${displayUrl}<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg></a>`);
            
            const badgeClass = t.isTemporary ? 'bg-blue-50 text-blue-600 border-blue-200' : (t.isPermanent ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-slate-100 text-slate-600 border-slate-200');
            const badgeText = t.isTemporary ? 'Temporary' : (t.isPermanent ? 'Permanent' : 'Custom');

            return `
                <tr class="hover:bg-slate-50/50 transition-colors">
                    <td class="py-3 px-2">
                        <div class="flex items-center gap-2">
                            <span class="status-dot ${isRunning ? 'running' : 'stopped'}"></span>
                            <span class="text-xs font-medium text-slate-600">${isRunning ? 'Active' : 'Offline'}</span>
                        </div>
                    </td>
                    <td class="py-3 px-2 font-medium break-all max-w-[200px]">${urlEl}</td>
                    <td class="py-3 px-2 text-slate-600">:${t.port}</td>
                    <td class="py-3 px-2">
                        <span class="text-xs font-medium px-2 py-1 rounded border ${badgeClass}">${badgeText}</span>
                    </td>
                    <td class="py-3 px-2 text-right space-x-1 whitespace-nowrap">
                        ${isRunning 
                            ? `<button onclick="stopTunnel('${t.id}')" class="px-2 py-1 text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 rounded border border-red-200 transition-colors">Stop</button>`
                            : `<button onclick="startTunnel('${t.id}')" class="px-2 py-1 text-xs font-medium bg-emerald-50 text-emerald-600 hover:bg-emerald-100 rounded border border-emerald-200 transition-colors">Start</button>`
                        }
                        <button onclick="deleteTunnel('${t.id}')" class="px-2 py-1 text-xs font-medium bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-red-600 rounded border border-slate-200 transition-colors">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    window.startTunnel = async (id) => {
        await api.request(`/tunnels/${id}/start`, { method: 'POST' });
        loadTunnels();
    };

    window.stopTunnel = async (id) => {
        await api.request(`/tunnels/${id}/stop`, { method: 'POST' });
        loadTunnels();
    };

    window.deleteTunnel = async (id) => {
        if(confirm('Are you sure you want to delete this tunnel?')) {
            await api.request(`/tunnels/${id}`, { method: 'DELETE' });
            loadTunnels();
        }
    };
});
