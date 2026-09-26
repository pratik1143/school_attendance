# Production Deployment Guide: Google Cloud Compute Engine VM

This document details how to deploy and operate the backend (T800 TCP listener, HTTP health monitor, and REST API) on a clean Debian/Ubuntu Linux VM in Google Cloud Platform (GCP).

---

## Architecture Overview

On the VM:
- **T800 TCP Listener**: Listens on port `8001` (configurable via `T800_TCP_PORT`) bound to `0.0.0.0` for incoming raw device connection/packets.
- **HTTP Health Monitor**: Listens on port `8080` (configurable via `HEALTH_PORT` or `PORT`) bound to `0.0.0.0`. Endpoints: `GET /health` and `GET /status`.
- **REST API Server**: Listens on port `8081` (configurable via `API_PORT`) bound to `0.0.0.0` for client integrations and admin operations.
- **Firebase / Firestore**: Server-side access authenticated automatically using **Google Application Default Credentials (ADC)** from the VM's attached Google Service Account.

---

## Prerequisites & Firewall Rules

### Google Cloud VPC Firewall Rules
Create firewall ingress rules in GCP for the VM's network tags:

| Rule Name | Target | Protocol / Ports | Source Ranges | Description |
|-----------|--------|------------------|---------------|-------------|
| `allow-t800-tcp` | VM instance tag | TCP `8001` | Specific gateway IPs or `0.0.0.0/0` | T800 device communication |
| `allow-backend-health` | VM instance tag | TCP `8080` | GCP Health Checkers / internal | `/health` checks |
| `allow-api-http` | VM instance tag | TCP `8081` | Authorized callers / Load Balancer | REST API access |

---

## Step-by-Step Deployment Instructions

### 1. Clone the Repository
Connect to your Linux VM via SSH and clone the codebase:
```bash
sudo mkdir -p /opt/school-attendance
sudo chown -R $USER:$USER /opt/school-attendance
git clone <YOUR_GITHUB_REPOSITORY_URL> /opt/school-attendance
cd /opt/school-attendance
```

### 2. Install Node.js (Node 24 / Node 22+)
The backend requires Node.js 22.18+ (Node 24 recommended) which supports `--experimental-strip-types`:
```bash
# Using NodeSource for Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v # Verify: should be v24.x or v22.18+
```

### 3. Install Dependencies
Install dependencies for the backend:
```bash
cd /opt/school-attendance/backend
npm ci --omit=dev
# If running build on VM, install devDependencies as well:
npm install
```

### 4. Configure Environment Variables
Create the production environment file from the template:
```bash
cp /opt/school-attendance/backend/.env.example /opt/school-attendance/backend/.env
nano /opt/school-attendance/backend/.env
```
Ensure required settings are populated (see Environment Variables Reference below).

### 5. Configure Firebase Admin & Application Default Credentials (ADC)
In Google Cloud Compute Engine, do **NOT** copy or commit service account JSON keys. Instead, use the VM's service account:
1. In the Google Cloud Console, ensure the VM instance is assigned a Service Account with:
   - **Cloud Datastore User** or **Firebase Admin** permissions.
2. The Firebase Admin SDK running on Node.js will automatically detect the VM metadata service via `applicationDefault()`.
3. Set your project ID in `backend/.env`:
   ```bash
   FIREBASE_PROJECT_ID=school-project-717c3
   FIRESTORE_WRITES_ENABLED=true
   ```

### 6. Build the Backend
Verify type checking and compile readiness:
```bash
cd /opt/school-attendance/backend
npm run build
```

### 7. Test-Run Backend Manually
Start the backend manually to confirm startup:
```bash
npm run start
```
You should see structured JSON logs confirming:
- `TCP listener ready` on port `8001`
- `Health server ready` on port `8080`
- `Public API ready` on port `8081`

Press `Ctrl + C` to stop after verification.

### 8. Verify Health Check Endpoint
Test the health server from the VM or via curl:
```bash
curl -i http://127.0.0.1:8080/health
# Expected Response: HTTP 200 {"success":true,"service":"school-attendance-backend","tcpPort":8001,...}

curl -i http://127.0.0.1:8080/status
# Expected Response: HTTP 200 with Firestore and TCP running state
```

### 9. Verify TCP Listener
Verify that port `8001` is open and listening:
```bash
ss -tulpn | grep 8001
# Or using netstat / nc
nc -zv 127.0.0.1 8001
```

### 10. Run Backend as a Systemd Service
Create a dedicated system user and install the systemd service unit:
```bash
# Create application user
sudo useradd --system --shell /bin/false --home-dir /opt/school-attendance attendance
sudo chown -R attendance:attendance /opt/school-attendance

# Copy service unit file
sudo cp /opt/school-attendance/deploy/school-attendance.service /etc/systemd/system/

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable school-attendance.service
sudo systemctl start school-attendance.service
```

### 11. View Live Production Logs
Check the status and stream logs using `journalctl`:
```bash
sudo systemctl status school-attendance.service

# Stream logs in real time
sudo journalctl -u school-attendance.service -f -o cat
```

### 12. Restarting & Stopping the Service
```bash
# Restart
sudo systemctl restart school-attendance.service

# Stop
sudo systemctl stop school-attendance.service
```

### 13. Firewall & Networking Verification
From an external computer or test terminal (if ingress firewall is configured):
```bash
# Check health from remote
curl -i http://<VM_EXTERNAL_IP>:8080/health

# Test TCP connectivity to port 8001
nc -zv <VM_EXTERNAL_IP> 8001
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `T800_TCP_PORT` (or `TCP_PORT`) | `8001` | TCP port for T800 terminal listener |
| `HEALTH_PORT` (or `PORT`) | `8080` | HTTP port for `/health` and `/status` |
| `HEALTH_HOST` | `0.0.0.0` | Bind IP for health check server |
| `API_PORT` | `8081` | HTTP port for REST API server |
| `API_HOST` | `0.0.0.0` | Bind IP for REST API server |
| `FIREBASE_PROJECT_ID` | `school-project-717c3` | Google Cloud / Firebase project ID |
| `FIRESTORE_WRITES_ENABLED`| `true` | Set `false` to disable Firestore writes |
| `API_RATE_LIMIT` | `60` | Max requests per minute per API client |
| `API_KEY_PEPPER` | *(none)* | Secret pepper for API key hashing (min 32 chars) |
| `CORS_ORIGINS` | *(none)* | Comma-separated allowlist of origins |
| `MAX_CONNECTIONS` | `16` | Max concurrent TCP connections |
| `MAX_PACKET_BYTES` | `65536` | Max packet size accepted |
| `LOG_RAW_PACKETS` | `false` | Log full packet hex in debug output |
| `DIAGNOSTIC_MODE` | `false` | Enable enhanced protocol diagnostics |
