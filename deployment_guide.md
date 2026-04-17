# SAM Fullstack — GPU Server Deployment Guide

This guide describes how to deploy the Segment Anything (SAM 2) fullstack application on a Linux server with an NVIDIA GPU.

## Prerequisites

1.  **NVIDIA Drivers**: Ensure `nvidia-smi` works on the host.
2.  **NVIDIA Container Toolkit**: Required for Docker to access the GPU.
    - Install it via [NVIDIA's official documentation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
3.  **Docker & Docker Compose**: Ensure `docker compose` is version 2.0 or higher.

## Deployment Steps

### 1. Build the Images
From the root directory of the project, run:
```bash
docker compose build
```
This will:
- Build the backend with CUDA 12.1 support.
- Download the SAM 2.1 tiny checkpoint (~39MB).
- Build the React frontend and bundle it with Nginx.

### 2. Start the Application
Run in detached mode:
```bash
docker compose up -d
```

### 3. Verify GPU Access
Check the backend logs to ensure PyTorch can see the GPU:
```bash
docker logs medseg-backend
```
You should see output indicating that CUDA is available.

### 4. Access the App
- **Frontend**: `http://<your-server-ip>:3000`
- **Backend API**: `http://<your-server-ip>:8000/docs` (Swagger UI)

## Troubleshooting

- **GPU not found**: If `torch.cuda.is_available()` is False, double-check that you have the `nvidia-container-runtime` configured as the default runtime or that you are using the `deploy.resources` section in `docker-compose.yml`.
- **Port Conflict**: If port 3000 is taken, modify the `ports` mapping in `docker-compose.yml` for the `frontend` service.
- **Permission Errors**: If the backend cannot save videos or masks, ensure the `backend-storage` volume is correctly mounted.

## Storage
Processed videos and masks are stored in a Docker volume named `medseg-storage`. You can find the physical location on the host via:
```bash
docker volume inspect medseg-storage
```
