# School Attendance Platform

Modern school attendance platform featuring a React management console and a high-performance Node.js TCP capture backend for T800 attendance terminals.

---

## Architecture

- **Frontend (`src/`)**: React + Vite single-page application providing real-time dashboards, student roster management, attendance record filters, device health monitoring, and Firebase Authentication.
- **Backend (`backend/src/`)**: Node.js service running on Node 22+/24:
  - **T800 TCP Listener** (port `8001`): Captures raw biometric device TCP streams into `raw_device_logs` and tracks device connectivity.
  - **Health Monitor** (port `8080`): Exposes `/health` and `/status` for load balancers and system monitoring.
  - **REST API** (port `8081`): Authenticated API for students, attendance, devices, and webhook event delivery.
- **Firebase / Firestore**: Cloud data storage for `students`, `attendance`, `devices`, `raw_device_logs`, and `sync_logs`. Backend authenticates using Google Application Default Credentials (ADC).

---

## Local Development

### 1. Install Dependencies
```bash
# Install frontend and workspace dependencies
npm install

# Install backend dependencies
npm --prefix backend install
```

### 2. Configure Environment
- **Frontend**: Copy `.env.example` to `.env.local` and add your Firebase client web app credentials.
- **Backend**: Copy `backend/.env.example` to `backend/.env`.

### 3. Run Development Servers
```bash
# Start frontend dashboard (http://localhost:5173)
npm run dev

# Start backend services (TCP 8001, Health 8080, API 8081)
npm run backend:dev
```

### 4. Run Tests & Typecheck
```bash
# Run backend test suite (73 automated unit & integration tests)
npm test

# Typecheck backend
npm run typecheck
```

---

## Production Deployment (Google Cloud VM)

The backend is built to run on a Linux Compute Engine VM with systemd.
Refer to [**DEPLOYMENT.md**](DEPLOYMENT.md) for full step-by-step instructions on:
1. Cloning the repository & installing Node 24
2. Configuring Google Cloud VM service account & Application Default Credentials (ADC)
3. Installing & starting the systemd service (`deploy/school-attendance.service`)
4. Verifying `/health` and TCP port `8001`
5. Viewing production logs via `journalctl`

---

## Security Guidelines

- **Never commit `.env` or service account JSON files to Git.**
- In production, backend Firestore access is authenticated via GCP Application Default Credentials (ADC) attached to the VM instance.
- Biometric templates and raw passwords are never logged or stored in Firestore without explicit requirements.
