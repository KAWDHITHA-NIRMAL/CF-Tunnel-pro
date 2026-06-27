const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, '../config.json');
const TUNNELS_FILE = path.join(__dirname, '../tunnels.json');
const CLOUDFLARED_DIR = path.join(os.homedir(), '.cloudflared');

function getConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
    return { port: 1215, password: '', token: '' };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getTunnels() {
    if (fs.existsSync(TUNNELS_FILE)) {
        return JSON.parse(fs.readFileSync(TUNNELS_FILE, 'utf-8'));
    }
    return [];
}

function saveTunnels(tunnels) {
    fs.writeFileSync(TUNNELS_FILE, JSON.stringify(tunnels, null, 2));
}

const config = getConfig();
const activeTunnels = new Map();

function requireAuth(req, res, next) {
    if (req.path === '/api/login') return next();

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'No authorization header' });
    
    const token = authHeader.split(' ')[1];
    if (token !== config.token || !config.token) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    next();
}

app.use('/api', requireAuth);

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === config.password) {
        if (!config.token) {
            config.token = crypto.randomUUID();
            saveConfig(config);
        }
        res.json({ token: config.token });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/api/cf/status', (req, res) => {
    const certPath = path.join(CLOUDFLARED_DIR, 'cert.pem');
    if (fs.existsSync(certPath)) {
        try {
            const certPem = fs.readFileSync(certPath, 'utf8');
            const cert = new crypto.X509Certificate(certPem);
            const match = cert.subject.match(/CN=([^,\n]+)/);
            const domain = match ? match[1] : 'Authorized';
            res.json({ authorized: true, domain: domain.replace('Cloudflare ', '') });
        } catch (e) {
            res.json({ authorized: true, domain: 'Authorized Domain' });
        }
    } else {
        res.json({ authorized: false });
    }
});

let loginProcess = null;
app.post('/api/cf/login', (req, res) => {
    if (loginProcess) {
        return res.status(400).json({ error: 'Login already in progress' });
    }

    loginProcess = spawn('cloudflared', ['tunnel', 'login']);
    let loginUrl = '';
    
    loginProcess.stderr.on('data', (data) => {
        const output = data.toString();
        const urlMatch = output.match(/(https:\/\/dash\.cloudflare\.com\/argotunnel[^\s]+)/);
        if (urlMatch) {
            loginUrl = urlMatch[1];
        }
    });

    loginProcess.on('close', (code) => {
        loginProcess = null;
    });

    setTimeout(() => {
        if (loginUrl) {
            res.json({ url: loginUrl });
        } else {
            res.status(500).json({ error: 'Failed to generate login URL' });
        }
    }, 2000);
});

app.get('/api/tunnels', (req, res) => {
    const tunnels = getTunnels();
    const enrichedTunnels = tunnels.map(t => ({
        ...t,
        status: activeTunnels.has(t.id) ? 'running' : 'stopped',
        url: activeTunnels.get(t.id)?.url || t.url
    }));
    res.json(enrichedTunnels);
});

app.post('/api/tunnels', (req, res) => {
    const { subdomain, port, isPermanent, isTemporary } = req.body;
    const id = crypto.randomUUID();
    const tunnel = {
        id,
        subdomain: subdomain || '',
        port,
        isPermanent: !!isPermanent,
        isTemporary: !!isTemporary,
        createdAt: new Date().toISOString()
    };

    const tunnels = getTunnels();
    tunnels.push(tunnel);
    saveTunnels(tunnels);

    startTunnel(tunnel);
    res.json(tunnel);
});

app.delete('/api/tunnels/:id', (req, res) => {
    const { id } = req.params;
    
    stopTunnel(id);
    
    let tunnels = getTunnels();
    const tunnel = tunnels.find(t => t.id === id);
    tunnels = tunnels.filter(t => t.id !== id);
    saveTunnels(tunnels);

    if (tunnel && !tunnel.isTemporary && tunnel.uuid) {
        try {
            execSync(`cloudflared tunnel delete -f ${tunnel.uuid}`, { stdio: 'ignore' });
            const configPath = path.join(CLOUDFLARED_DIR, `config-${tunnel.id}.yml`);
            if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
        } catch (e) {}
    }
    
    res.json({ success: true });
});

app.post('/api/tunnels/:id/start', (req, res) => {
    const { id } = req.params;
    const tunnels = getTunnels();
    const tunnel = tunnels.find(t => t.id === id);
    
    if (tunnel) {
        startTunnel(tunnel);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Tunnel not found' });
    }
});

app.post('/api/tunnels/:id/stop', (req, res) => {
    const { id } = req.params;
    stopTunnel(id);
    res.json({ success: true });
});

function setupNamedTunnel(tunnel) {
    const tunnelName = `cftunnelpro-${tunnel.id}`;
    let tunnelUUID = tunnel.uuid;

    if (!tunnelUUID) {
        try {
            const createOutput = execSync(`cloudflared tunnel create ${tunnelName}`).toString();
            const match = createOutput.match(/id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (match) tunnelUUID = match[1];
        } catch (e) {
            try {
                const listOutput = execSync(`cloudflared tunnel list --name ${tunnelName}`).toString();
                const match = listOutput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                if (match) tunnelUUID = match[1];
            } catch (err) {}
        }
    }

    if (tunnelUUID) {
        tunnel.uuid = tunnelUUID;
        const tunnels = getTunnels();
        const tIndex = tunnels.findIndex(t => t.id === tunnel.id);
        if (tIndex >= 0) {
            tunnels[tIndex].uuid = tunnelUUID;
            saveTunnels(tunnels);
        }

        try {
            execSync(`cloudflared tunnel route dns ${tunnelUUID} ${tunnel.subdomain}`, { stdio: 'ignore' });
        } catch(e) {}

        if (!fs.existsSync(CLOUDFLARED_DIR)) fs.mkdirSync(CLOUDFLARED_DIR, { recursive: true });

        const configPath = path.join(CLOUDFLARED_DIR, `config-${tunnel.id}.yml`);
        const credentialsPath = path.join(CLOUDFLARED_DIR, `${tunnelUUID}.json`);
        const configYaml = `tunnel: ${tunnelUUID}\ncredentials-file: ${credentialsPath}\ningress:\n  - hostname: ${tunnel.subdomain}\n    service: http://localhost:${tunnel.port}\n  - service: http_status:404\n`;
        fs.writeFileSync(configPath, configYaml);
        return configPath;
    }
    return null;
}

function startTunnel(tunnel) {
    if (activeTunnels.has(tunnel.id)) return;

    let proc;
    if (tunnel.isTemporary) {
        proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${tunnel.port}`]);
    } else {
        const configPath = setupNamedTunnel(tunnel);
        if (configPath && tunnel.uuid) {
            proc = spawn('cloudflared', ['tunnel', '--config', configPath, 'run', tunnel.uuid]);
        }
    }

    if (!proc) return;

    proc.url = '';
    proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (tunnel.isTemporary) {
            const urlMatch = output.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
            if (urlMatch && !proc.url) {
                proc.url = urlMatch[1];
                tunnel.url = proc.url;
                const tunnels = getTunnels();
                const t = tunnels.find(x => x.id === tunnel.id);
                if(t) { t.url = proc.url; saveTunnels(tunnels); }
            }
        }
    });

    proc.on('close', (code) => {
        activeTunnels.delete(tunnel.id);
    });

    activeTunnels.set(tunnel.id, proc);
}

function stopTunnel(id) {
    if (activeTunnels.has(id)) {
        const proc = activeTunnels.get(id);
        proc.kill('SIGINT');
        activeTunnels.delete(id);
    }
}

// Clean temporary tunnels on boot
let currentTunnels = getTunnels().filter(t => !t.isTemporary || t.isPermanent);
saveTunnels(currentTunnels);

currentTunnels.forEach(t => {
    if (t.isPermanent) startTunnel(t);
});

app.listen(config.port, () => {
    console.log(`CF Tunnel Pro running on port ${config.port}`);
});
