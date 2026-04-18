# Manual Installation Guide (Non-Docker)

This guide explains how to set up and run the SAM fullstack application directly on your Linux GPU server.

## 1. System Dependencies
Install the required libraries for video processing and GPU acceleration:
```bash
sudo apt-get update && sudo apt-get install -y \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    git \
    wget \
    python3-pip \
    python3-venv
```

## 2. Backend Setup (`backend/sam2`)

### Create a Virtual Environment
```bash
cd backend/sam2
python3 -m venv venv
source venv/bin/activate
```

### Install PyTorch (CUDA 12.1)
```bash
pip install --upgrade pip
pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121
```

### Install SAM 2 and API Dependencies
```bash
# Install build tools first (needed for --no-build-isolation)
pip install wheel setuptools --upgrade

# Install the sam2 package in editable mode with no-build-isolation
# (uses the torch we just installed instead of downloading it again)
pip install -e . --no-build-isolation

# Install FastAPI and other requirements
pip install -r requirements.txt
pip install uvicorn python-multipart opencv-python-headless pillow scikit-image scipy numpy
```

### Download Checkpoint
```bash
mkdir -p checkpoints
wget -q -O checkpoints/sam2.1_hiera_tiny.pt \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt
```

### Run the Backend
```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## 3. Frontend Setup (`frontend`)

### Install Node.js (Version 20+)
Vite requires a modern Node version. We recommend using **nvm**:
```bash
# 1. Install curl if missing
sudo apt-get update && sudo apt-get install -y curl

# 2. Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# 3. ACTIVATE nvm (run this if nvm is not found)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 4. Install and use Node 20
nvm install 20
nvm use 20
```

### Install Dependencies
```bash
cd frontend
npm install
```

### Run in Development Mode
This will host the app at `http://localhost:8080`.
```bash
npm run dev -- --host
```

### (Optional) Build for Production
If you want to serve the frontend via a separate web server (like Nginx):
```bash
npm run build
# The compiled files will be in frontend/dist
```

## 4. Running in Background (nohup)

To keep the services running after you disconnect from SSH, use `nohup`.

### Start Backend
```bash
cd backend/sam2
source venv/bin/activate
export PYTHONUNBUFFERED=1
nohup uvicorn main:app --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
```

### Start Frontend
```bash
cd frontend
nohup npm run dev -- --host > frontend.log 2>&1 &
```

## 5. Running as a Permanent System Service (Systemd)

For a real production server, it is better to manage these via `systemd`. This ensures they start on boot and restart automatically if they crash.

### Step 1: Create the Backend Service
1. Copy the contents of `backend/sam2/sam-backend.service`.
2. Create the file on your server: 
   `sudo nano /etc/systemd/system/sam-backend.service`
3. Paste the contents and save (Ctrl+O, Enter, Ctrl+X).

### Step 2: Create the Frontend Service
1. Copy the contents of `frontend/sam-frontend.service`.
2. **IMPORTANT**: Open the file and replace `<YOUR_SERVER_IP>` with your server's actual IP address.
3. Create the file on your server:
   `sudo nano /etc/systemd/system/sam-frontend.service`
4. Paste the modified contents and save.

### Step 3: Enable and Start Services
```bash
# 1. Reload systemd to detect new files
sudo systemctl daemon-reload

# 2. Enable services to start on boot
sudo systemctl enable sam-backend.service
sudo systemctl enable sam-frontend.service

# 3. Start the services
sudo systemctl start sam-backend.service
sudo systemctl start sam-frontend.service
```

### Step 4: Manage Services
- **Check Status**: `sudo systemctl status sam-backend.service`
- **View Logs**: `sudo journalctl -u sam-backend.service -f`
- **Restart**: `sudo systemctl restart sam-frontend.service`

## 6. Troubleshooting

- **GPU not detected**: Run `python -c "import torch; print(torch.cuda.is_available())"` inside the virtual environment. If it returns `False`, check your driver and CUDA version matches the PyTorch install.
- **Port Conflicts**: If port 8000 or 8080 is taken, use the `--port` flag to change it.
- **API Connectivity (Remote Server)**: 
  > [!IMPORTANT]
  > If you are accessing the UI from a different computer, the frontend must know the server's public IP. Run this before starting the dev server:
  > ```bash
  > export VITE_API_BASE=http://<YOUR_SERVER_IP>:8000
  > npm run dev -- --host
  > ```
