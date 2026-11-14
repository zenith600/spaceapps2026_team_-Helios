FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/pipeline:/app/apps/api
COPY apps/api/requirements.txt /app/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /app/apps/api/requirements.txt
COPY pipeline/deepfield/__init__.py pipeline/deepfield/config.py /app/pipeline/deepfield/
COPY pipeline/deepfield/crowd /app/pipeline/deepfield/crowd
COPY apps/api/deepfield_api /app/apps/api/deepfield_api
COPY manifest.yaml /app/manifest.yaml
# frozen bundle: release if present, else the committed sample
COPY data/samples /app/data/samples
COPY data/release /app/data/release
ENV DEMO_MODE=1 DATA_DIR=/app/data/release PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn deepfield_api.main:app --host 0.0.0.0 --port ${PORT}"]
