#!/usr/bin/env bash
# =============================================================================
# server_setup.sh — Verify & install prerequisites on a bare Ubuntu GPU server
# =============================================================================
# Usage:  chmod +x server_setup.sh && sudo ./server_setup.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✔ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✘ $1${NC}"; }

echo "=============================================="
echo " SAM Fullstack — GPU Server Setup Checker"
echo "=============================================="
echo ""

# ---------- 1. NVIDIA Driver ----------
echo "1. Checking NVIDIA GPU Driver..."
if command -v nvidia-smi &>/dev/null; then
    ok "nvidia-smi found"
    nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
else
    fail "nvidia-smi not found — NVIDIA driver is not installed"
    echo ""
    echo "   Install NVIDIA drivers with:"
    echo "   ┌───────────────────────────────────────────────────────────────┐"
    echo "   │ sudo apt update                                              │"
    echo "   │ sudo apt install -y ubuntu-drivers-common                    │"
    echo "   │ sudo ubuntu-drivers install                                  │"
    echo "   │ sudo reboot                                                  │"
    echo "   └───────────────────────────────────────────────────────────────┘"
    echo ""
fi

# ---------- 2. Docker Engine ----------
echo ""
echo "2. Checking Docker Engine..."
if command -v docker &>/dev/null; then
    ok "Docker found: $(docker --version)"
else
    fail "Docker not found"
    echo ""
    echo "   Install Docker with:"
    echo "   ┌───────────────────────────────────────────────────────────────┐"
    echo "   │ sudo apt update                                              │"
    echo "   │ sudo apt install -y ca-certificates curl gnupg               │"
    echo "   │ sudo install -m 0755 -d /etc/apt/keyrings                    │"
    echo "   │ curl -fsSL https://download.docker.com/linux/ubuntu/gpg \\    │"
    echo "   │   | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg       │"
    echo "   │ sudo chmod a+r /etc/apt/keyrings/docker.gpg                  │"
    echo "   │                                                              │"
    echo "   │ echo \"deb [arch=\$(dpkg --print-architecture) \\               │"
    echo "   │   signed-by=/etc/apt/keyrings/docker.gpg] \\                  │"
    echo "   │   https://download.docker.com/linux/ubuntu \\                 │"
    echo "   │   \$(. /etc/os-release && echo \$VERSION_CODENAME) stable\" \\   │"
    echo "   │   | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null │"
    echo "   │                                                              │"
    echo "   │ sudo apt update                                              │"
    echo "   │ sudo apt install -y docker-ce docker-ce-cli \\                │"
    echo "   │   containerd.io docker-buildx-plugin docker-compose-plugin   │"
    echo "   │                                                              │"
    echo "   │ # Allow running docker without sudo (optional):              │"
    echo "   │ sudo usermod -aG docker \$USER                                │"
    echo "   │ newgrp docker                                                │"
    echo "   └───────────────────────────────────────────────────────────────┘"
    echo ""
fi

# ---------- 3. Docker Compose ----------
echo ""
echo "3. Checking Docker Compose..."
if docker compose version &>/dev/null 2>&1; then
    ok "Docker Compose found: $(docker compose version --short 2>/dev/null || docker compose version)"
else
    fail "Docker Compose plugin not found"
    echo ""
    echo "   Install with:"
    echo "   ┌───────────────────────────────────────────────────────────────┐"
    echo "   │ sudo apt install -y docker-compose-plugin                    │"
    echo "   └───────────────────────────────────────────────────────────────┘"
    echo ""
fi

# ---------- 4. NVIDIA Container Toolkit ----------
echo ""
echo "4. Checking NVIDIA Container Toolkit..."
if dpkg -l 2>/dev/null | grep -q nvidia-container-toolkit; then
    ok "nvidia-container-toolkit is installed"
elif command -v nvidia-ctk &>/dev/null; then
    ok "nvidia-ctk found"
else
    fail "NVIDIA Container Toolkit not found"
    echo ""
    echo "   This is REQUIRED for Docker to access the GPU."
    echo "   Install with:"
    echo "   ┌───────────────────────────────────────────────────────────────┐"
    echo "   │ curl -fsSL https://nvidia.github.io/libnvidia-container/\\    │"
    echo "   │   gpgkey | sudo gpg --dearmor -o \\                           │"
    echo "   │   /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg   │"
    echo "   │                                                              │"
    echo "   │ curl -s -L https://nvidia.github.io/libnvidia-container/\\    │"
    echo "   │   stable/deb/nvidia-container-toolkit.list | \\               │"
    echo "   │   sed 's#deb https://#deb [signed-by=/usr/share/keyrings/\\   │"
    echo "   │   nvidia-container-toolkit-keyring.gpg] https://#g' | \\      │"
    echo "   │   sudo tee /etc/apt/sources.list.d/\\                         │"
    echo "   │   nvidia-container-toolkit.list                              │"
    echo "   │                                                              │"
    echo "   │ sudo apt update                                              │"
    echo "   │ sudo apt install -y nvidia-container-toolkit                 │"
    echo "   │ sudo nvidia-ctk runtime configure --runtime=docker           │"
    echo "   │ sudo systemctl restart docker                                │"
    echo "   └───────────────────────────────────────────────────────────────┘"
    echo ""
fi

# ---------- 5. Test GPU in Docker ----------
echo ""
echo "5. Testing GPU access from Docker container..."
if command -v docker &>/dev/null && command -v nvidia-smi &>/dev/null; then
    if docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi &>/dev/null; then
        ok "GPU is accessible from Docker containers"
    else
        fail "GPU not accessible from Docker"
        echo "   Make sure nvidia-container-toolkit is installed and Docker is restarted."
    fi
else
    warn "Skipped — Docker or NVIDIA driver not available"
fi

# ---------- 6. Git ----------
echo ""
echo "6. Checking Git..."
if command -v git &>/dev/null; then
    ok "Git found: $(git --version)"
else
    fail "Git not found"
    echo "   Install with: sudo apt install -y git"
fi

# ---------- Summary ----------
echo ""
echo "=============================================="
echo " Summary — Next Steps"
echo "=============================================="
echo ""
echo " After fixing any issues above, deploy with:"
echo ""
echo "   1. Clone your repository:"
echo "      git clone <your-repo-url> sam_fullstack"
echo ""
echo "   2. Build and start (first time will take ~10-15 min):"
echo "      cd sam_fullstack"
echo "      docker compose up --build -d"
echo ""
echo "   3. Verify services are running:"
echo "      docker compose ps"
echo ""
echo "   4. Check backend health:"
echo "      curl http://localhost:8000/videos"
echo ""
echo "   5. Access the application:"
echo "      Open http://<server-ip>:3000 in your browser"
echo ""
echo "   6. View logs:"
echo "      docker compose logs -f"
echo ""
echo "   7. Stop the stack:"
echo "      docker compose down"
echo ""
echo "=============================================="
