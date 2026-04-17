# =============================================================================
# Backend Dockerfile — FastAPI + SAM2 Video Segmentation (GPU)
# =============================================================================
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    SAM2_BUILD_CUDA=0 \
    DEBIAN_FRONTEND=noninteractive

# ---- System dependencies ----
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        git \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Install SAM2 package ----
# Copy setup files first for caching
COPY setup.py pyproject.toml README.md ./
COPY sam2/ ./sam2/
COPY configs/ ./configs/

RUN pip install --upgrade pip setuptools \
    && pip install -e .

# ---- Install FastAPI app dependencies ----
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir uvicorn python-multipart opencv-python-headless pillow scikit-image scipy numpy

# ---- Download SAM 2.1 checkpoint (tiny) ----
RUN mkdir -p checkpoints \
    && wget -q -O checkpoints/sam2.1_hiera_tiny.pt \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt

# ---- Copy application code ----
COPY main.py sam2_service.py ./

# ---- Create storage directories ----
RUN mkdir -p storage/videos storage/frames storage/masks storage/vidmasks storage/tmp_batches

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
