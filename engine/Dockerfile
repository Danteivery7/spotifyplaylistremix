FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml .
COPY app ./app

ARG INSTALL_STEMS=false
RUN if [ "$INSTALL_STEMS" = "true" ]; then pip install --no-cache-dir ".[stems]"; else pip install --no-cache-dir .; fi

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
