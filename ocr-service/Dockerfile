FROM python:3.12-slim
WORKDIR /srv
# opencv-python-headless==5.0.0.93 still dlopen()s a handful of shared libs
# at import time on debian-slim despite being the "headless" build (no X11
# server needed, just these .so files present). Fixed iteratively against the
# actual ImportError chain: libxcb.so.1 -> libGL.so.1 -> ... (documented
# deviation from the brief's plain Dockerfile sketch, which didn't need this).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Запечь модели в образ: прогреть движок на build-этапе (скачает onnx-модели
# в site-packages/rapidocr/models). БЕЗ сети в рантайме.
COPY app ./app
RUN python -c "from app.ocr import get_engine; get_engine()"
COPY tests ./tests
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
