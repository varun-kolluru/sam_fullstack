# =============================================================================
# Backend Dockerfile — FastAPI + SAM2 Video Segmentation (GPU)
# Base: PyTorch 2.5.1 with CUDA 12.1 + cuDNN 9  (runtime image)
# =============================================================================
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    SAM2_BUILD_CUDA=0 \
    DEBIAN_FRONTEND=noninteractive

# ---- System dependencies ----------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libavutil-dev \
        libavcodec-dev \
        libavformat-dev \
        libswscale-dev \
        libgl1 \
        libglib2.0-0 \
        pkg-config \
        build-essential \
        libffi-dev \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sam2

# ---- Install SAM2 package ---------------------------------------------------
# Copy only the files needed by setup.py first (for better Docker layer caching)
COPY setup.py pyproject.toml README.md ./
COPY sam2/ ./sam2/
COPY configs/ ./configs/

RUN pip install --upgrade pip setuptools \
    && pip install -e ".[notebooks]" --no-build-isolation

# ---- Install FastAPI app dependencies ----------------------------------------
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ---- Download SAM 2.1 checkpoint (tiny, ~39 MB) ----------------------------
RUN mkdir -p checkpoints \
    && python -c "\
import urllib.request, os; \
url='https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt'; \
dst='checkpoints/sam2.1_hiera_tiny.pt'; \
print(f'Downloading {url}'); \
urllib.request.urlretrieve(url, dst); \
print(f'Saved to {dst} ({os.path.getsize(dst)/(1024*1024):.1f} MB)')"

# ---- Copy application code ---------------------------------------------------
COPY main.py sam2_service.py ./

# ---- Create storage directories ----------------------------------------------
RUN mkdir -p storage/videos storage/frames storage/masks

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
