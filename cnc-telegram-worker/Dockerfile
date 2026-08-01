FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system worker \
  && adduser --system --ingroup worker worker \
  && mkdir -p /data/tmp /data/session /data/cnc-telegram-media \
  && chown -R worker:worker /app /data

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY cnc_telegram_worker ./cnc_telegram_worker
RUN chown -R worker:worker /app/cnc_telegram_worker \
  && find /app/cnc_telegram_worker -type d -exec chmod 0755 {} + \
  && find /app/cnc_telegram_worker -type f -exec chmod 0644 {} +

ENTRYPOINT ["python", "-m", "cnc_telegram_worker.entrypoint"]
CMD ["daemon"]
